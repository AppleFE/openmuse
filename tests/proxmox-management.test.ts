import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { connectorTools } from "../apps/server/src/connector-tools.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { ActionProposal } from "../packages/domain/src/index.ts";
import { connectorWriteSchema, proxmoxWriteOperations } from "../packages/domain/src/proxmox.ts";
import { ConnectorError, connectorAdapter } from "../packages/integrations/src/connectors/index.ts";
import { type PiProtocolTurn, piProtocolFixture } from "./helpers/pi-protocol.ts";

const TOKEN_ID = "monitoring@pve!fixture",
  SECRET = "fixture-token-secret";
const UPID = `UPID:pve1:00000001:00000001:00000001:qmstart:100:${TOKEN_ID}:`;
const DIGEST = "a".repeat(40);
const json = (res: ServerResponse, data: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ data }));
};
interface Request {
  method: string;
  url: string;
  body: URLSearchParams;
  authorization: string | undefined;
}
async function provider(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse, seen: Request) => void,
) {
  const requests: Request[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const seen = {
      method: req.method ?? "GET",
      url: req.url ?? "",
      body: new URLSearchParams(Buffer.concat(chunks).toString()),
      authorization: req.headers.authorization,
    };
    requests.push(seen);
    handler(req, res, seen);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}
const proxmox = connectorAdapter("proxmox");

test("embedded Pi pauses for Proxmox review, resumes and verifies the provider job without re-executing", async (t) => {
  const mock = await provider(t, (_req, res, seen) => {
    if (seen.method === "POST") return json(res, UPID);
    if (seen.url.endsWith("/config")) return json(res, { digest: DIGEST, cores: 2, memory: 2048 });
    if (seen.url.endsWith("/status")) return json(res, { status: "stopped", exitstatus: "OK" });
    json(res, {}, 404);
  });
  const turns: PiProtocolTurn[] = [];
  const model = await piProtocolFixture(t, turns);
  const directory = await mkdtemp(join(tmpdir(), "openmuse-proxmox-pi-"));
  const db = await createStore();
  const server = await createApp(db, {
    mode: "sample",
    host: "127.0.0.1",
    port: 8787,
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    allowedOrigins: [],
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    models: [
      {
        id: "pi-coder",
        label: "Pi coder",
        provider: "openai",
        model: "openai/gpt-4o-mini",
        capabilities: ["chat", "coding", "tools"],
        enabled: true,
        available: true,
      },
    ],
  });
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir(), "openmuse-proxmox-pi-")));
    await rm(directory, { recursive: true, force: true });
  });
  const c = await server.connectors.create("owner", {
    provider: "proxmox",
    name: "Pi fixture",
    config: { baseUrl: mock.baseUrl },
    secrets: { tokenId: TOKEN_ID, tokenSecret: SECRET },
  });
  turns.push({
    tool: {
      name: "prepare_connector_action",
      arguments: {
        connectorId: c.id,
        operation: "guest_power",
        params: { node: "pve1", kind: "qemu", vmid: 100, action: "start" },
      },
    },
  });
  turns.push({ text: "The exact VM start request is prepared and waiting for native review." });
  const task = await server.agent.createTask("owner", {
    kind: "agent",
    modelId: "pi-coder",
    prompt: "Start fixture VM 100 after native review, verify its provider task, and finish.",
  });
  await server.agent.worker.tick();
  const pending = await server.agent.getTask("owner", task.id);
  assert.equal(pending.status, "waiting_approval", pending.error ?? pending.question);
  assert.ok(pending.actionId);
  assert.equal(mock.requests.filter((r) => r.method !== "GET").length, 0);
  const action = await server.actions.get("owner", pending.actionId);
  assert.equal(action.kind, "connector.write");
  await server.actions.decide("owner", action.id, action.hash, "approve");
  turns.push(
    {
      tool: {
        name: "query_connector",
        arguments: {
          connectorId: c.id,
          operation: "task_status",
          params: { node: "pve1", upid: UPID },
        },
      },
    },
    {
      tool: {
        name: "finish_task",
        arguments: { summary: "The reviewed VM start job stopped with exitstatus OK." },
      },
    },
    { text: "The reviewed provider job completed successfully." },
  );
  await server.agent.worker.tick();
  const completed = await server.agent.getTask("owner", task.id);
  assert.equal(completed.status, "succeeded", completed.error ?? completed.question);
  assert.equal(mock.requests.filter((r) => r.method !== "GET").length, 1);
  assert.ok(model.requests.some((r) => JSON.stringify(r.body).includes("exitstatus")));
  assert.ok(model.requests.some((r) => JSON.stringify(r.body).includes("approvalResult")));
  assert.equal(
    (await db.list<ActionProposal>("owner", "actions")).filter((a) => a.taskId === task.id).length,
    1,
  );
});

test("Proxmox reads node storage, contents, guest configuration and usable provider task IDs", async (t) => {
  const mock = await provider(t, (_req, res, seen) => {
    if (seen.url === "/api2/json/access/permissions?path=%2Fstorage")
      return json(res, { "/storage": { "Datastore.Audit": 1 } });
    if (seen.url === "/api2/json/nodes")
      return json(res, [
        { node: "pve1", status: "online" },
        { node: "pve2", status: "online" },
      ]);
    if (
      seen.url.startsWith("/api2/json/nodes/pve1/storage?") ||
      seen.url === "/api2/json/nodes/pve1/storage"
    )
      return json(res, [
        {
          storage: "local",
          type: "dir",
          active: 1,
          enabled: 1,
          content: "iso,backup",
          total: 1000,
          used: 400,
          avail: 600,
        },
      ]);
    if (seen.url.startsWith("/api2/json/nodes/pve2/storage"))
      return json(res, { message: "Forbidden" }, 403);
    if (seen.url === "/api2/json/nodes/pve1/storage/local/content?content=iso")
      return json(res, [{ volid: "local:iso/test.iso", content: "iso", size: 99 }]);
    if (seen.url === "/api2/json/storage/local")
      return json(res, {
        storage: "local",
        type: "dir",
        digest: DIGEST,
        password: "storage-password",
      });
    if (seen.url === "/api2/json/nodes/pve1/qemu/100/config")
      return json(res, {
        name: "demo",
        digest: DIGEST,
        cores: 2,
        cipassword: "cloudinit-password",
      });
    if (seen.url.endsWith("/status") && seen.url.includes("/tasks/"))
      return json(res, { upid: UPID, status: "stopped", exitstatus: "OK" });
    if (seen.url.includes("/log?"))
      return json(res, [{ n: 1, t: `authorization ${SECRET} ${encodeURIComponent(SECRET)}` }]);
    if (seen.url === "/api2/json/cluster/nextid") return json(res, "101");
    json(res, {}, 404);
  });
  const ctx = {
    config: { baseUrl: mock.baseUrl },
    secrets: { tokenId: TOKEN_ID, tokenSecret: SECRET },
  };
  assert.deepEqual(await proxmox.run(ctx, "permissions", { path: "/storage" }), {
    permissions: { "/storage": { "Datastore.Audit": 1 } },
  });
  const storages = (await proxmox.run(ctx, "storages", { content: "iso" })) as {
    storages: {
      node: string;
      totalBytes: number;
      usedBytes: number;
      availableBytes: number;
      contentTypes: string[];
    }[];
    errors: { node: string; error: string }[];
  };
  assert.equal(storages.storages[0].node, "pve1");
  assert.equal(storages.storages[0].totalBytes, 1000);
  assert.equal(storages.storages[0].availableBytes, 600);
  assert.deepEqual(storages.storages[0].contentTypes, ["iso", "backup"]);
  assert.equal(storages.errors[0].node, "pve2");
  const content = (await proxmox.run(ctx, "storage_content", {
    node: "pve1",
    storage: "local",
    content: "iso",
  })) as { volumes: { volid: string }[] };
  assert.equal(content.volumes[0].volid, "local:iso/test.iso");
  const storage = await proxmox.run(ctx, "storage_config", { storage: "local" });
  assert.ok(!JSON.stringify(storage).includes("storage-password"));
  const guest = await proxmox.run(ctx, "guest_config", { node: "pve1", kind: "qemu", vmid: 100 });
  assert.ok(!JSON.stringify(guest).includes("cloudinit-password"));
  const task = (await proxmox.run(ctx, "task_status", { node: "pve1", upid: UPID })) as {
    task: { upid: string };
  };
  assert.equal(task.task.upid, UPID, "A public token identifier must not corrupt the task ID");
  const log = await proxmox.run(ctx, "task_log", {
    node: "pve1",
    upid: UPID,
    start: 10,
    limit: 20,
  });
  assert.ok(!JSON.stringify(log).includes(SECRET));
  assert.ok(mock.requests.some((r) => r.url.includes("start=10&limit=20")));
  assert.deepEqual(await proxmox.run(ctx, "next_id", {}), { vmid: 101 });
});

test("Proxmox write adapters use exact methods, form encoding, endpoints and async receipts", async (t) => {
  const mock = await provider(t, (_req, res) => json(res, UPID));
  assert.ok(proxmox.write);
  const ctx = {
      config: { baseUrl: mock.baseUrl },
      secrets: { tokenId: TOKEN_ID, tokenSecret: SECRET },
    },
    g = { node: "pve1", kind: "qemu", vmid: 100 };
  const cases: {
    operation: string;
    params: Record<string, unknown>;
    method: string;
    path: string;
    body?: Record<string, string>;
  }[] = [
    {
      operation: "guest_power",
      params: { ...g, action: "shutdown", timeout: 60 },
      method: "POST",
      path: "/nodes/pve1/qemu/100/status/shutdown",
      body: { timeout: "60" },
    },
    {
      operation: "guest_config_update",
      params: {
        ...g,
        settings: { cores: 4, memory: 4096, onboot: false, description: "Korean & = value" },
        digest: DIGEST,
      },
      method: "PUT",
      path: "/nodes/pve1/qemu/100/config",
      body: {
        cores: "4",
        memory: "4096",
        onboot: "0",
        description: "Korean & = value",
        digest: DIGEST,
      },
    },
    {
      operation: "guest_create",
      params: {
        ...g,
        settings: { name: "demo", scsi0: "local-lvm:32", net0: "virtio,bridge=vmbr0" },
      },
      method: "POST",
      path: "/nodes/pve1/qemu",
      body: { vmid: "100", name: "demo" },
    },
    {
      operation: "guest_create",
      params: {
        ...g,
        kind: "lxc",
        settings: { ostemplate: "local:vztmpl/debian.tar.zst", rootfs: "local-lvm:8" },
      },
      method: "POST",
      path: "/nodes/pve1/lxc",
      body: { vmid: "100", unprivileged: "1" },
    },
    {
      operation: "guest_clone",
      params: { ...g, kind: "lxc", newid: 101, name: "copy", full: true },
      method: "POST",
      path: "/nodes/pve1/lxc/100/clone",
      body: { newid: "101", hostname: "copy", full: "1" },
    },
    {
      operation: "guest_migrate",
      params: { ...g, kind: "lxc", target: "pve2", online: true, targetStorage: "local-lvm" },
      method: "POST",
      path: "/nodes/pve1/lxc/100/migrate",
      body: { target: "pve2", restart: "1", "target-storage": "local-lvm" },
    },
    {
      operation: "guest_delete",
      params: { ...g, purge: true, deleteUnreferencedDisks: false },
      method: "DELETE",
      path: "/nodes/pve1/qemu/100?purge=1&destroy-unreferenced-disks=0",
    },
    {
      operation: "snapshot_create",
      params: { ...g, snapshot: "before-upgrade", vmstate: true },
      method: "POST",
      path: "/nodes/pve1/qemu/100/snapshot",
      body: { snapname: "before-upgrade", vmstate: "1" },
    },
    {
      operation: "snapshot_delete",
      params: { ...g, snapshot: "before-upgrade" },
      method: "DELETE",
      path: "/nodes/pve1/qemu/100/snapshot/before-upgrade",
    },
    {
      operation: "snapshot_rollback",
      params: { ...g, snapshot: "before-upgrade" },
      method: "POST",
      path: "/nodes/pve1/qemu/100/snapshot/before-upgrade/rollback",
    },
    {
      operation: "backup",
      params: { node: "pve1", vmid: 100, storage: "backup-store" },
      method: "POST",
      path: "/nodes/pve1/vzdump",
      body: {
        vmid: "100",
        storage: "backup-store",
        mode: "snapshot",
        compress: "zstd",
        remove: "0",
      },
    },
    {
      operation: "restore",
      params: { ...g, kind: "lxc", archive: "local:backup/vzdump-lxc-100.tar.zst" },
      method: "POST",
      path: "/nodes/pve1/lxc",
      body: { restore: "1", ostemplate: "local:backup/vzdump-lxc-100.tar.zst" },
    },
    {
      operation: "storage_config_update",
      params: {
        storage: "local",
        settings: { disable: false, content: "iso,backup" },
        digest: DIGEST,
      },
      method: "PUT",
      path: "/storage/local",
      body: { disable: "0", digest: DIGEST },
    },
    {
      operation: "storage_content_delete",
      params: { node: "pve1", storage: "local", volume: "local:iso/obsolete.iso" },
      method: "DELETE",
      path: "/nodes/pve1/storage/local/content/local%3Aiso%2Fobsolete.iso",
    },
    {
      operation: "storage_download",
      params: {
        node: "pve1",
        storage: "local",
        url: "https://example.test/demo.iso",
        filename: "demo.iso",
        content: "iso",
        checksum: "a".repeat(64),
      },
      method: "POST",
      path: "/nodes/pve1/storage/local/download-url",
      body: { "verify-certificates": "1", "checksum-algorithm": "sha256" },
    },
    {
      operation: "storage_create",
      params: { storage: "images", type: "lvmthin", vgname: "vg0", thinpool: "data" },
      method: "POST",
      path: "/storage",
      body: { storage: "images", type: "lvmthin" },
    },
    {
      operation: "storage_delete",
      params: { storage: "local" },
      method: "DELETE",
      path: "/storage/local",
    },
  ];
  for (const c of cases) {
    const result = (await proxmox.write(
      ctx,
      connectorWriteSchema.parse({
        connectorId: "fixture",
        operation: c.operation,
        params: c.params,
      }),
    )) as { upid: string; status: string };
    const req = mock.requests.at(-1);
    assert.ok(req);
    assert.equal(req.method, c.method, c.operation);
    assert.equal(req.url, `/api2/json${c.path}`, c.operation);
    for (const [key, value] of Object.entries(c.body ?? {}))
      assert.equal(req.body.get(key), value, `${c.operation}:${key}`);
    assert.equal(req.authorization, `PVEAPIToken=${TOKEN_ID}=${SECRET}`);
    assert.equal(result.status, "submitted");
    assert.equal(result.upid, UPID);
  }
  assert.deepEqual(new Set(cases.map((c) => c.operation)), new Set(proxmoxWriteOperations));
  const count = mock.requests.length;
  await assert.rejects(
    proxmox.write(ctx, {
      connectorId: "fixture",
      operation: "guest_create",
      params: { ...g, settings: { args: "-dangerous" } },
    }),
  );
  await assert.rejects(proxmox.run(ctx, "guest_power", { ...g, action: "start" }));
  await assert.rejects(proxmox.run(ctx, "storage_content", { node: "../bad", storage: "local" }));
  assert.equal(
    mock.requests.length,
    count,
    "Invalid input and write-via-read bypasses must not reach the provider",
  );
});

test("Proxmox mutating transport records an uncertain result instead of allowing an automatic retry", async (t) => {
  const mock = await provider(t, (req, res) => {
    if (req.method === "GET") return json(res, { digest: DIGEST, name: "demo" });
    req.socket.destroy();
  });
  assert.ok(proxmox.write);
  await assert.rejects(
    proxmox.write(
      { config: { baseUrl: mock.baseUrl }, secrets: { tokenId: TOKEN_ID, tokenSecret: SECRET } },
      connectorWriteSchema.parse({
        connectorId: "fixture",
        operation: "guest_power",
        params: { node: "pve1", kind: "qemu", vmid: 100, action: "start" },
      }),
    ),
    (e: unknown) => {
      assert.ok(e instanceof ConnectorError);
      assert.equal(e.code, "outcome_unknown");
      assert.ok(!e.message.includes(SECRET));
      return true;
    },
  );
  assert.equal(mock.requests.length, 1);
});

test("Proxmox reviewed writes work without Google, cannot bypass review, bind target versions and execute once", async (t) => {
  let digest = DIGEST,
    disconnect = false;
  const mock = await provider(t, (req, res, seen) => {
    if (seen.method === "GET" && seen.url === "/api2/json/nodes/pve1/qemu/100/config")
      return json(res, { digest, name: "demo", cores: 2, memory: 2048 });
    if (seen.method !== "GET") {
      if (disconnect) {
        req.socket.destroy();
        return;
      }
      setTimeout(() => json(res, UPID), 25);
      return;
    }
    json(res, {}, 404);
  });
  const directory = await mkdtemp(join(tmpdir(), "openmuse-proxmox-management-")),
    db = await createStore();
  t.after(async () => {
    await db.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir(), "openmuse-proxmox-management-")));
    await rm(directory, { recursive: true, force: true });
  });
  const { app, actions, connectors } = await createApp(db, {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    accessKey: "fixture-access-key-123456789",
    encryptionKey: randomBytes(32).toString("base64"),
  });
  const login = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey: "fixture-access-key-123456789" }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json(),
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const create = await app.request("/api/connectors", {
    method: "POST",
    headers,
    body: JSON.stringify({
      provider: "proxmox",
      name: "cluster",
      config: { baseUrl: mock.baseUrl },
      secrets: { tokenId: TOKEN_ID, tokenSecret: SECRET },
    }),
  });
  assert.equal(create.status, 201);
  const c = await create.json();
  const payload = {
    kind: "connector.write",
    data: {
      connectorId: c.id,
      operation: "guest_config_update",
      params: { node: "pve1", kind: "qemu", vmid: 100, settings: { cores: 4 } },
    },
  };
  const propose = async () => {
    const r = await app.request("/api/actions", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    assert.equal(r.status, 201);
    return r.json();
  };
  const decide = async (a: { id: string; hash: string }, decision = "approve", hash = a.hash) =>
    app.request(`/api/actions/${a.id}/decide`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision, hash }),
    });
  const writes = () => mock.requests.filter((r) => r.method !== "GET");
  assert.equal(
    (
      await app.request(`/api/connectors/${c.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          operation: "guest_power",
          params: { node: "pve1", kind: "qemu", vmid: 100, action: "start" },
        }),
      })
    ).status,
    422,
  );
  const metadata = await (
    await app.request(`/api/connectors/${c.id}/operations`, { headers })
  ).json();
  assert.ok(
    metadata.operations.some(
      (o: { name: string; kind: string }) => o.name === "storages" && o.kind === "read",
    ),
  );
  assert.ok(
    metadata.operations.some(
      (o: { name: string; kind: string }) => o.name === "guest_power" && o.kind === "write",
    ),
  );
  const denied = await propose();
  assert.equal(writes().length, 0);
  assert.equal((await (await decide(denied, "deny")).json()).status, "denied");
  assert.equal(writes().length, 0);
  const a = await propose();
  assert.equal(a.data.params.digest, DIGEST);
  assert.equal(JSON.stringify(a).includes(SECRET), false);
  assert.equal((await decide(a, "approve", "wrong-hash")).status, 409);
  const results = await Promise.all([decide(a), decide(a)]);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(writes().length, 1);
  const stored = await actions.get("local-user", a.id);
  assert.equal(stored.status, "succeeded");
  assert.equal(JSON.parse(stored.result ?? "{}").status, "submitted");
  await decide(a);
  assert.equal(writes().length, 1);
  const changed = await propose();
  digest = "b".repeat(40);
  assert.equal((await (await decide(changed)).json()).status, "failed");
  assert.equal(writes().length, 1);
  digest = DIGEST;
  const rotated = await propose();
  await connectors.update("local-user", c.id, {
    secrets: { tokenId: TOKEN_ID, tokenSecret: "rotated-token-secret" },
  });
  assert.equal((await (await decide(rotated)).json()).status, "failed");
  assert.equal(writes().length, 1);
  const uncertain = await propose();
  disconnect = true;
  const unknown = await (await decide(uncertain)).json();
  assert.equal(unknown.status, "outcome_unknown");
  assert.equal(writes().length, 2);
  await decide(uncertain);
  assert.equal(writes().length, 2);
  await assert.rejects(actions.get("other-owner", a.id), /not found/);
  await assert.rejects(
    connectors.executeWrite("other-owner", payload.data, a.targetVersion),
    /not found/,
  );
  const tools = connectorTools(connectors, "local-user", {
    prepare: (input) => actions.propose("local-user", { kind: "connector.write", data: input }),
  });
  assert.ok(tools.find((t) => t.name === "prepare_connector_action"));
  assert.equal(
    tools.some((t) => /approve|execute/.test(t.name)),
    false,
  );
});
