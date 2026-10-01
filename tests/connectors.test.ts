import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import test, { type TestContext } from "node:test";
import {
  ConnectorError,
  connectorAdapter,
  httpJson,
  parseWgDump,
  redact,
} from "../packages/integrations/src/connectors/index.ts";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
interface Captured {
  url: string;
  headers: IncomingMessage["headers"];
}

async function mockProvider(t: TestContext, handler: Handler) {
  const requests: Captured[] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", headers: request.headers });
    handler(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

const json = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
};

const github = connectorAdapter("github");
const tailscale = connectorAdapter("tailscale");
const headscale = connectorAdapter("headscale");
const proxmox = connectorAdapter("proxmox");

async function tlsProvider(t: TestContext, certificate = "server.pem") {
  const fixture = (name: string) => readFile(new URL(`./fixtures/tls/${name}`, import.meta.url));
  const [ca, cert, key] = await Promise.all([
    fixture("ca.pem"),
    fixture(certificate),
    fixture("server-key.pem"),
  ]);
  const requests: Captured[] = [];
  const server = createHttpsServer({ cert, key }, (request, response) => {
    requests.push({ url: request.url ?? "", headers: request.headers });
    json(response, {
      data:
        request.url === "/api2/json/version"
          ? { version: "9.0.1" }
          : [{ node: "test-node", status: "online" }],
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { baseUrl: `https://127.0.0.1:${address.port}`, ca: ca.toString("utf8"), requests };
}

test("proxmox rejects an untrusted CA before sending credentials and accepts a connection-specific CA", async (t) => {
  const mock = await tlsProvider(t);
  const ctx = {
    config: { baseUrl: mock.baseUrl },
    secrets: { tokenId: "monitoring@pve!test", tokenSecret: "fixture-token-secret" },
  };
  const untrusted = await proxmox.test(ctx);
  assert.equal(untrusted.ok, false);
  assert.match(untrusted.detail, /certificate is not trusted/);
  assert.equal(untrusted.detail.includes(ctx.secrets.tokenSecret), false);
  assert.equal(mock.requests.length, 0, "No HTTP credentials may reach an untrusted peer");

  const trusted = await proxmox.test({
    ...ctx,
    config: { ...ctx.config, ca: mock.ca, verifyTls: true },
  });
  assert.equal(trusted.ok, true);
  assert.deepEqual(
    mock.requests.map((r) => r.url),
    ["/api2/json/version", "/api2/json/nodes"],
  );
  assert.equal(
    mock.requests[1].headers.authorization,
    "PVEAPIToken=monitoring@pve!test=fixture-token-secret",
  );

  assert.equal((await proxmox.test(ctx)).ok, false, "Trust must not leak into another connection");
  assert.equal(
    (await proxmox.test({ ...ctx, config: { ...ctx.config, verifyTls: false } })).ok,
    true,
  );
  assert.equal(
    (await proxmox.test(ctx)).ok,
    false,
    "A per-connection TLS opt-out must not change the default",
  );
});

test("proxmox custom CA still verifies the configured hostname", async (t) => {
  const mock = await tlsProvider(t, "wrong-host.pem");
  await assert.rejects(
    httpJson(`${mock.baseUrl}/api2/json/version`, { tls: { ca: mock.ca } }),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "tls");
      assert.match(error.message, /does not match the configured URL/);
      return true;
    },
  );
  assert.equal(mock.requests.length, 0);
});

test("proxmox test rejects invalid credentials even when the version endpoint is public", async (t) => {
  const mock = await mockProvider(t, (request, response) => {
    if (request.url === "/api2/json/version") return json(response, { data: { version: "9.0.1" } });
    return json(response, { message: "Invalid API token" }, 401);
  });
  const check = await proxmox.test({
    config: { baseUrl: mock.baseUrl },
    secrets: { tokenId: "monitoring@pve!test", tokenSecret: "invalid-token" },
  });
  assert.equal(check.ok, false);
  assert.match(check.detail, /credentials \(HTTP 401\)/);
  assert.equal(check.detail.includes("invalid-token"), false);
  assert.deepEqual(
    mock.requests.map((r) => r.url),
    ["/api2/json/version", "/api2/json/nodes"],
  );
});

test("github adapter authenticates, lists repositories and maps them", async (t) => {
  const mock = await mockProvider(t, (_request, response) =>
    json(response, [
      {
        id: 1,
        name: "demo",
        full_name: "me/demo",
        private: false,
        description: "A repo",
        html_url: "https://github.com/me/demo",
        default_branch: "main",
        updated_at: "2026-01-01T00:00:00Z",
        pushed_at: "2026-01-02T00:00:00Z",
        language: "TypeScript",
        stargazers_count: 7,
        open_issues_count: 2,
        archived: false,
      },
    ]),
  );
  const result = (await github.run(
    { config: { baseUrl: mock.baseUrl }, secrets: { token: "ghp_test_token" } },
    "repos",
    {},
  )) as { repos: Record<string, unknown>[] };
  assert.equal(
    mock.requests[0].url,
    "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
  );
  assert.equal(mock.requests[0].headers.authorization, "Bearer ghp_test_token");
  assert.equal(mock.requests[0].headers["x-github-api-version"], "2022-11-28");
  assert.equal(result.repos[0].fullName, "me/demo");
  assert.equal(result.repos[0].defaultBranch, "main");
});

test("github issues exclude pull requests and pulls map head/base", async (t) => {
  const mock = await mockProvider(t, (request, response) => {
    if (request.url?.includes("/issues"))
      return json(response, [
        {
          id: 10,
          number: 5,
          title: "Bug",
          state: "open",
          html_url: "https://github.com/me/demo/issues/5",
          user: { login: "octo" },
          labels: [{ name: "bug" }, "triage"],
          comments: 3,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
        {
          id: 11,
          number: 6,
          title: "Actually a PR",
          state: "open",
          html_url: "https://github.com/me/demo/pull/6",
          pull_request: {},
          comments: 0,
        },
      ]);
    return json(response, [
      {
        id: 20,
        number: 7,
        title: "Feature",
        state: "open",
        draft: true,
        html_url: "https://github.com/me/demo/pull/7",
        user: { login: "octo" },
        head: { ref: "feature-x" },
        base: { ref: "main" },
        merged_at: null,
      },
    ]);
  });
  const ctx = { config: { baseUrl: mock.baseUrl }, secrets: { token: "ghp_test_token" } };
  const issues = (await github.run(ctx, "issues", { repo: "me/demo", state: "all" })) as {
    issues: { title: string; labels: string[] }[];
  };
  assert.equal(issues.issues.length, 1);
  assert.equal(issues.issues[0].title, "Bug");
  assert.deepEqual(issues.issues[0].labels, ["bug", "triage"]);
  const pulls = (await github.run(ctx, "pulls", { repo: "me/demo" })) as {
    pulls: { draft: boolean; head: string; base: string }[];
  };
  assert.equal(pulls.pulls[0].head, "feature-x");
  assert.equal(pulls.pulls[0].draft, true);
  assert.equal(mock.requests[0].url, "/repos/me/demo/issues?state=all&per_page=30");
});

test("github surfaces auth failures and malformed responses", async (t) => {
  const unauthorized = await mockProvider(t, (_request, response) =>
    json(response, { message: "Bad credentials" }, 401),
  );
  const ctx = {
    config: { baseUrl: unauthorized.baseUrl },
    secrets: { token: "ghp_test_token" },
  };
  await assert.rejects(github.run(ctx, "repos", {}), (error: unknown) => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "auth");
    assert.match(error.message, /credentials/);
    return true;
  });
  const broken = await mockProvider(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{not json");
  });
  await assert.rejects(
    github.run({ config: { baseUrl: broken.baseUrl }, secrets: { token: "t" } }, "repos", {}),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "malformed");
      return true;
    },
  );
});

test("provider error bodies never echo stored secrets", async (t) => {
  const token = "ghp_super_secret_token";
  const mock = await mockProvider(t, (_request, response) =>
    json(response, { message: `token ${token} was rejected by policy` }, 500),
  );
  await assert.rejects(
    github.run({ config: { baseUrl: mock.baseUrl }, secrets: { token } }, "repos", {}),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.message.includes(token), false);
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
  assert.equal(
    redact(`a ${token} b ${encodeURIComponent(token)}`, [token]),
    "a [redacted] b [redacted]",
  );
});

test("provider timeouts raise a timeout error without hanging", async (t) => {
  const hanging = await mockProvider(t, () => {
    // Never respond; the client-side timeout must win.
  });
  await assert.rejects(httpJson(`${hanging.baseUrl}/slow`, { timeoutMs: 50 }), (error: unknown) => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "timeout");
    return true;
  });
});

test("tailscale lists tailnet devices", async (t) => {
  const mock = await mockProvider(t, (_request, response) =>
    json(response, {
      devices: [
        {
          id: "d1",
          name: "laptop.me.github",
          hostname: "laptop",
          addresses: ["100.64.0.1"],
          os: "windows",
          user: "me@github",
          lastSeen: "2026-09-29T00:00:00Z",
          authorized: true,
          keyExpiryDisabled: true,
          nodeKey: "nodekey:secret-material",
        },
      ],
    }),
  );
  const result = (await tailscale.run(
    {
      config: { tailnet: "me.github", baseUrl: mock.baseUrl },
      secrets: { apiKey: "tskey-api-secret" },
    },
    "devices",
    {},
  )) as { devices: Record<string, unknown>[] };
  assert.equal(mock.requests[0].url, "/tailnet/me.github/devices?fields=all");
  assert.equal(mock.requests[0].headers.authorization, "Bearer tskey-api-secret");
  assert.equal(result.devices[0].name, "laptop.me.github");
  assert.equal(JSON.stringify(result).includes("nodekey"), false);
  const check = await tailscale.test({
    config: { tailnet: "me.github", baseUrl: mock.baseUrl },
    secrets: { apiKey: "tskey-api-secret" },
  });
  assert.equal(check.ok, true);
  assert.match(check.detail, /1 device/);
});

test("headscale lists nodes and falls back to the legacy machine endpoint", async (t) => {
  const legacy = await mockProvider(t, (request, response) => {
    if (request.url === "/api/v1/node") return json(response, { message: "not found" }, 404);
    if (request.url === "/api/v1/machine")
      return json(response, {
        machines: [
          {
            id: "7",
            name: "server",
            givenName: "server",
            user: { name: "admin" },
            ipAddresses: ["100.64.0.5"],
            lastSeen: "2026-09-29T00:00:00Z",
            online: true,
            machineKey: "mkey:secret",
          },
        ],
      });
    return json(response, {}, 404);
  });
  const ctx = {
    config: { baseUrl: legacy.baseUrl },
    secrets: { apiKey: "hskey-secret" },
  };
  const result = (await headscale.run(ctx, "devices", {})) as {
    devices: Record<string, unknown>[];
  };
  assert.equal(mockPath(legacy, 0), "/api/v1/node");
  assert.equal(result.devices[0].user, "admin");
  assert.equal(JSON.stringify(result).includes("mkey"), false);

  const modern = await mockProvider(t, (_request, response) =>
    json(response, {
      nodes: [
        { id: 3, name: "node3", user: { name: "ops" }, ipAddresses: ["100.64.0.9"], online: false },
      ],
    }),
  );
  const result2 = (await headscale.run(
    { config: { baseUrl: modern.baseUrl }, secrets: { apiKey: "k" } },
    "devices",
    {},
  )) as { devices: { name: string }[] };
  assert.equal(result2.devices[0].name, "node3");
});

function mockPath(mock: { requests: Captured[] }, index: number) {
  return mock.requests[index].url;
}

const WG_DUMP = [
  "wg0\tPRIVKEY_SENTINEL_AAA=\tPUB_IFACE_0\t51820\toff",
  "wg0\tPEER_A_KEY\tPSK_SENTINEL_BBB=\t1.2.3.4:5678\t10.0.0.2/32\t1713634774\t38071572\t14387132\t25",
  "wg0\tPEER_B_KEY\t(none)\t(none)\t10.0.0.3/32\t0\t0\t0\toff",
  "wg1\tPRIVKEY_SENTINEL_CCC=\tPUB_IFACE_1\t51821\toff",
  "wg1\tPEER_C_KEY\tPSK_SENTINEL_DDD=\t5.6.7.8:9999\t10.1.0.2/32,fdaa::2/128\t1713634709\t1\t2\toff",
  "",
].join("\n");

test("wireguard dump parsing drops private and preshared keys", () => {
  const interfaces = parseWgDump(WG_DUMP);
  assert.equal(interfaces.length, 2);
  const wg0 = interfaces[0];
  assert.equal(wg0.publicKey, "PUB_IFACE_0");
  assert.equal(wg0.listenPort, 51820);
  assert.equal(wg0.peers.length, 2);
  const peer = wg0.peers[0];
  assert.equal(peer.publicKey, "PEER_A_KEY");
  assert.equal(peer.endpoint, "1.2.3.4:5678");
  assert.deepEqual(peer.allowedIps, ["10.0.0.2/32"]);
  assert.equal(peer.latestHandshake, 1713634774);
  assert.equal(peer.latestHandshakeAt, "2024-04-20T17:39:34.000Z");
  assert.equal(peer.persistentKeepalive, 25);
  const serialized = JSON.stringify(interfaces);
  for (const secret of [
    "PRIVKEY_SENTINEL_AAA=",
    "PSK_SENTINEL_BBB=",
    "PRIVKEY_SENTINEL_CCC=",
    "PSK_SENTINEL_DDD=",
  ])
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  assert.throws(() => parseWgDump("wg0\ttoo\tfew\n"), /malformed/i);
  assert.throws(
    () => parseWgDump("wg1\tPEER\t(none)\t(none)\t10.0.0.1/32\t0\t0\t0\toff\n"),
    /malformed/i,
  );
});

test("wireguard adapter uses fixed argv without a shell and reports missing wg", async () => {
  const calls: { file: string; args: string[] }[] = [];
  const adapter = connectorAdapter("wireguard", {
    exec: async (file, args) => {
      calls.push({ file, args });
      return { stdout: WG_DUMP, stderr: "" };
    },
  });
  const result = (await adapter.run({ config: {}, secrets: {} }, "status", {})) as {
    interfaces: unknown[];
  };
  assert.deepEqual(calls[0].args, ["show", "all", "dump"]);
  assert.equal(result.interfaces.length, 2);
  await adapter.run(
    { config: { interface: "wg0", wgPath: "/usr/bin/wg" }, secrets: {} },
    "status",
    {},
  );
  assert.equal(calls[1].file, "/usr/bin/wg");
  assert.deepEqual(calls[1].args, ["show", "wg0", "dump"]);

  const missing = connectorAdapter("wireguard", {
    exec: async () => {
      throw new ConnectorError(
        "WireGuard tools are not installed (wg not found)",
        undefined,
        "unreachable",
      );
    },
  });
  const check = await missing.test({ config: {}, secrets: {} });
  assert.equal(check.ok, false);
  assert.match(check.detail, /not installed/);
});

test("proxmox authenticates with PVEAPIToken and aggregates cluster resources", async (t) => {
  const mock = await mockProvider(t, (request, response) => {
    if (request.url === "/api2/json/version")
      return json(response, { data: { version: "8.4.1", release: "abc" } });
    if (request.url === "/api2/json/nodes")
      return json(response, {
        data: [
          {
            node: "pve1",
            status: "online",
            cpu: 0.1,
            maxcpu: 8,
            mem: 1024,
            maxmem: 8192,
            uptime: 100,
          },
          {
            node: "pve2",
            status: "online",
            cpu: 0.2,
            maxcpu: 16,
            mem: 2048,
            maxmem: 16384,
            uptime: 200,
          },
        ],
      });
    if (request.url === "/api2/json/cluster/resources?type=vm")
      return json(response, {
        data: [
          {
            id: "qemu/100",
            type: "qemu",
            node: "pve1",
            vmid: 100,
            name: "web",
            status: "running",
            maxmem: 4096,
            mem: 1024,
          },
          {
            id: "lxc/200",
            type: "lxc",
            node: "pve2",
            vmid: 200,
            name: "db",
            status: "running",
            template: 0,
          },
          {
            id: "qemu/101",
            type: "qemu",
            node: "pve2",
            vmid: 101,
            name: "stopped",
            status: "stopped",
          },
        ],
      });
    if (request.url === "/api2/json/cluster/resources?type=lxc")
      return json(response, {
        data: [
          { id: "lxc/200", type: "lxc", node: "pve2", vmid: 200, name: "db", status: "running" },
        ],
      });
    return json(response, { data: null });
  });
  const ctx = {
    config: { baseUrl: mock.baseUrl },
    secrets: { tokenId: "monitoring@pve!openmuse", tokenSecret: "uuid-secret" },
  };
  const check = await proxmox.test(ctx);
  assert.equal(check.ok, true);
  assert.match(check.detail, /8\.4\.1/);
  assert.equal(
    mock.requests[0].headers.authorization,
    "PVEAPIToken=monitoring@pve!openmuse=uuid-secret",
  );
  const nodes = (await proxmox.run(ctx, "nodes", {})) as { nodes: { node: string }[] };
  assert.deepEqual(
    nodes.nodes.map((n) => n.node),
    ["pve1", "pve2"],
  );
  const vms = (await proxmox.run(ctx, "vms", {})) as { vms: { name: string; type: string }[] };
  assert.deepEqual(
    vms.vms.map((v) => v.name),
    ["web", "stopped"],
  );
  const single = (await proxmox.run(ctx, "vms", { node: "pve2" })) as {
    vms: { node: string }[];
  };
  assert.deepEqual(
    single.vms.map((v) => v.node),
    ["pve2"],
  );
  const containers = (await proxmox.run(ctx, "containers", {})) as {
    containers: { name: string; type: string }[];
  };
  assert.deepEqual(
    containers.containers.map((c) => c.name),
    ["db"],
  );
});
