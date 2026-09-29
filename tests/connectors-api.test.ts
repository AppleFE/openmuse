import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../apps/server/src/config.ts";
import { connectorRoutes } from "../apps/server/src/connector-routes.ts";
import { ConnectorService } from "../apps/server/src/connector-service.ts";
import { connectorTools } from "../apps/server/src/connector-tools.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { AppError } from "../apps/server/src/errors.ts";
import { decryptSecret } from "../packages/integrations/src/vault.ts";

const TOKEN_SECRET = "ghp_live_token_value";
const ENCRYPTION_KEY = randomBytes(32).toString("base64");

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
async function mockProvider(t: TestContext, handler: Handler) {
  const requests: { url: string; headers: IncomingMessage["headers"] }[] = [];
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

const WG_DUMP = [
  "wg0\tPRIVKEY_SENTINEL_AAA=\tPUB_IFACE_0\t51820\toff",
  "wg0\tPEER_A_KEY\tPSK_SENTINEL_BBB=\t1.2.3.4:5678\t10.0.0.2/32\t1713634774\t38071572\t14387132\t25",
  "",
].join("\n");

interface Fixture {
  db: Store;
  service: ConnectorService;
  app: Hono<{ Variables: { owner: string } }>;
  directory: string;
}

/** Mirrors production wiring: Bearer auth resolves an owner, routes sit under /api/connectors. */
async function fixture(
  t: TestContext,
  deps: ConstructorParameters<typeof ConnectorService>[2] = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-connectors-"));
  const db = await createStore();
  const config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    encryptionKey: ENCRYPTION_KEY,
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  } satisfies Config;
  const service = new ConnectorService(db, config, deps);
  const app = new Hono<{ Variables: { owner: string } }>();
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json({ error: error.issues.map((i) => i.message).join("; ") }, 422);
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    return c.json({ error: "Request failed. Check the server setup and try again." }, 502);
  });
  app.use("/api/*", async (c, next) => {
    const match = /^Bearer ([a-z0-9-]+)-token$/.exec(c.req.header("authorization") ?? "");
    if (!match) return c.json({ error: "Sign in to OpenMuse" }, 401);
    c.set("owner", match[1]);
    await next();
  });
  app.route("/api/connectors", connectorRoutes(service));
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { db, service, app, directory } satisfies Fixture;
}

const headers = (owner = "alice") => ({
  Authorization: `Bearer ${owner}-token`,
  "Content-Type": "application/json",
});

test("connector CRUD keeps secrets encrypted at rest and out of every view", async (t) => {
  const { db, app } = await fixture(t);
  const created = await app.request("/api/connectors", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      provider: "github",
      name: "Personal GitHub",
      config: {},
      secrets: { token: TOKEN_SECRET },
    }),
  });
  assert.equal(created.status, 201);
  const view = await created.json();
  assert.equal(view.hasSecret, true);
  assert.equal(JSON.stringify(view).includes(TOKEN_SECRET), false);
  const stored = await db.get<{ secret: string }>("alice", "connectors", view.id);
  assert.ok(stored);
  assert.ok(stored.secret.startsWith("v1."));
  assert.equal(stored.secret.includes(TOKEN_SECRET), false);
  assert.deepEqual(JSON.parse(decryptSecret(stored.secret, ENCRYPTION_KEY)), {
    token: TOKEN_SECRET,
  });
  const list = await app.request("/api/connectors", { headers: headers() });
  assert.equal((await list.json()).connectors.length, 1);
  const updated = await app.request(`/api/connectors/${view.id}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ name: "Work GitHub", secrets: { token: "rotated_token" } }),
  });
  assert.equal((await updated.json()).name, "Work GitHub");
  const rotated = await db.get<{ secret: string }>("alice", "connectors", view.id);
  assert.ok(rotated);
  assert.equal(JSON.parse(decryptSecret(rotated.secret, ENCRYPTION_KEY)).token, "rotated_token");
  const removed = await app.request(`/api/connectors/${view.id}`, {
    method: "DELETE",
    headers: headers(),
  });
  assert.equal(removed.status, 200);
  assert.equal(
    (await app.request(`/api/connectors/${view.id}`, { headers: headers() })).status,
    404,
  );
});

test("connector routes require auth and isolate owners", async (t) => {
  const { app } = await fixture(t);
  assert.equal((await app.request("/api/connectors")).status, 401);
  const created = await app.request("/api/connectors", {
    method: "POST",
    headers: headers("alice"),
    body: JSON.stringify({
      provider: "github",
      name: "Alice GitHub",
      config: {},
      secrets: { token: TOKEN_SECRET },
    }),
  });
  const { id } = await created.json();
  assert.equal(
    (await app.request(`/api/connectors/${id}`, { headers: headers("bob") })).status,
    404,
  );
  assert.equal(
    (
      await app.request(`/api/connectors/${id}/test`, {
        method: "POST",
        headers: headers("bob"),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await app.request(`/api/connectors/${id}`, {
        method: "DELETE",
        headers: headers("bob"),
      })
    ).status,
    404,
  );
  const bobList = await app.request("/api/connectors", { headers: headers("bob") });
  assert.equal((await bobList.json()).connectors.length, 0);
});

test("providers metadata, query validation and read operations work end to end", async (t) => {
  const mock = await mockProvider(t, (request, response) => {
    if (request.url === "/user") return response.end(JSON.stringify({ login: "octocat" }));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify([
        {
          id: 1,
          name: "demo",
          full_name: "octo/demo",
          private: false,
          description: null,
          html_url: "https://github.com/octo/demo",
          default_branch: "main",
          updated_at: "2026-01-01T00:00:00Z",
          language: null,
        },
      ]),
    );
  });
  const { app } = await fixture(t);
  const providers = await app.request("/api/connectors/providers", { headers: headers() });
  const { providers: infos } = await providers.json();
  assert.deepEqual(infos.map((info: { provider: string }) => info.provider).sort(), [
    "github",
    "headscale",
    "proxmox",
    "tailscale",
    "wireguard",
  ]);
  const githubInfo = infos.find((info: { provider: string }) => info.provider === "github");
  assert.deepEqual(
    githubInfo.operations.map((op: { name: string }) => op.name),
    ["repos", "issues", "pulls"],
  );
  const created = await app.request("/api/connectors", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      provider: "github",
      name: "GitHub",
      config: { baseUrl: mock.baseUrl },
      secrets: { token: TOKEN_SECRET },
    }),
  });
  const { id } = await created.json();
  const check = await app.request(`/api/connectors/${id}/test`, {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  const checkBody = await check.json();
  assert.equal(checkBody.ok, true);
  assert.match(checkBody.detail, /octocat/);
  const query = await app.request(`/api/connectors/${id}/query`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ operation: "repos", params: {} }),
  });
  assert.equal(query.status, 200);
  assert.equal((await query.json()).data.repos[0].fullName, "octo/demo");
  const unsupported = await app.request(`/api/connectors/${id}/query`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ operation: "delete-repo", params: {} }),
  });
  assert.equal(unsupported.status, 422);
  const badParams = await app.request(`/api/connectors/${id}/query`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ operation: "issues", params: { repo: "no-slash" } }),
  });
  assert.equal(badParams.status, 422);
  // Persisted health stays redacted and queryable.
  const detail = await app.request(`/api/connectors/${id}`, { headers: headers() });
  const detailBody = await detail.json();
  assert.equal(detailBody.check.ok, true);
  assert.equal(JSON.stringify(detailBody).includes(TOKEN_SECRET), false);
});

test("provider failures at the API stay redacted and timeout cleanly", async (t) => {
  const leaky = await mockProvider(t, (_request, response) => {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: `internal error for token ${TOKEN_SECRET}` }));
  });
  const { app } = await fixture(t);
  const created = await app.request("/api/connectors", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      provider: "github",
      name: "GitHub",
      config: { baseUrl: leaky.baseUrl },
      secrets: { token: TOKEN_SECRET },
    }),
  });
  const { id } = await created.json();
  const response = await app.request(`/api/connectors/${id}/query`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ operation: "repos", params: {} }),
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(JSON.stringify(body).includes(TOKEN_SECRET), false);
  assert.match(body.error, /\[redacted\]/);

  const hanging = await mockProvider(t, () => {});
  const { app: timeoutApp } = await fixture(t, { timeoutMs: 50 });
  const slow = await timeoutApp.request("/api/connectors", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      provider: "github",
      name: "GitHub",
      config: { baseUrl: hanging.baseUrl },
      secrets: { token: "t" },
    }),
  });
  const { id: slowId } = await slow.json();
  const timedOut = await timeoutApp.request(`/api/connectors/${slowId}/query`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ operation: "repos", params: {} }),
  });
  assert.equal(timedOut.status, 502);
  assert.match((await timedOut.json()).error, /did not respond/);
});

test("wireguard status flows through the API with no secret material", async (t) => {
  const { app } = await fixture(t, {
    exec: async (file, args) => {
      assert.equal(file, "wg");
      assert.deepEqual(args, ["show", "all", "dump"]);
      return { stdout: WG_DUMP, stderr: "" };
    },
  });
  const created = await app.request("/api/connectors", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ provider: "wireguard", name: "Host VPN", config: {} }),
  });
  assert.equal(created.status, 201);
  const view = await created.json();
  assert.equal(view.hasSecret, false);
  const response = await app.request(`/api/connectors/${view.id}/query`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ operation: "status", params: {} }),
  });
  const { data } = await response.json();
  assert.equal(data.interfaces[0].peers[0].publicKey, "PEER_A_KEY");
  const serialized = JSON.stringify(data);
  assert.equal(serialized.includes("PRIVKEY_SENTINEL"), false);
  assert.equal(serialized.includes("PSK_SENTINEL"), false);
});

test("multiple proxmox connections stay independent and reachable", async (t) => {
  const seen: Record<string, string[]> = {};
  const make = (tag: string) => async (t2: TestContext) => {
    seen[tag] = [];
    return mockProvider(t2, (request, response) => {
      seen[tag].push(request.url ?? "");
      if (request.url === "/api2/json/version")
        return response.end(JSON.stringify({ data: { version: tag === "a" ? "8.4.0" : "9.0.1" } }));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: [{ node: `node-${tag}`, status: "online", uptime: 42 }],
        }),
      );
    });
  };
  const mockA = await make("a")(t);
  const mockB = await make("b")(t);
  const { app } = await fixture(t);
  const createFor = (baseUrl: string, name: string) =>
    app.request("/api/connectors", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        provider: "proxmox",
        name,
        config: { baseUrl, verifyTls: true },
        secrets: { tokenId: `monitoring@pve!${name}`, tokenSecret: `secret-${name}` },
      }),
    });
  const a = await (await createFor(mockA.baseUrl, "pve-a")).json();
  const b = await (await createFor(mockB.baseUrl, "pve-b")).json();
  assert.notEqual(a.id, b.id);
  const nodesA = await app.request(`/api/connectors/${a.id}/query`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ operation: "nodes", params: {} }),
  });
  assert.equal((await nodesA.json()).data.nodes[0].node, "node-a");
  assert.equal(seen.a.at(-1), "/api2/json/nodes");
  const testB = await app.request(`/api/connectors/${b.id}/test`, {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  assert.match((await testB.json()).detail, /9\.0\.1/);
  assert.equal(seen.b[0], "/api2/json/version");
  assert.equal(
    mockB.requests[0].headers.authorization,
    "PVEAPIToken=monitoring@pve!pve-b=secret-pve-b",
  );
});

test("connector agent tools list, test and query without leaking secrets", async (t) => {
  const { service } = await fixture(t);
  const created = await service.create("alice", {
    provider: "wireguard",
    name: "VPN",
    config: {},
  });
  const tools = connectorTools(service, "alice");
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(names, ["list_connectors", "test_connector", "query_connector"]);
  const list = tools[0].execute as (args: unknown) => Promise<unknown>;
  const listed = (await list({})) as { id: string }[];
  assert.equal(listed[0].id, created.id);
  assert.equal(JSON.stringify(listed).includes("secret"), false);
  const query = tools[2].execute as (args: unknown) => Promise<unknown>;
  const queried = (await query({
    connectorId: created.id,
    operation: "invalid",
    params: {},
  })) as { error: string };
  assert.match(queried.error, /Unsupported/);
});
