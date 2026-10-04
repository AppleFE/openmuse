import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import ssh2 from "ssh2";
import { createHostAgent } from "../apps/host-agent/src/server.ts";
import { createApp } from "../apps/server/src/app.ts";
import { Auth } from "../apps/server/src/auth.ts";
import { BrowserService } from "../apps/server/src/browser.ts";
import { ConnectorService } from "../apps/server/src/connector-service.ts";
import { Files } from "../apps/server/src/files.ts";
import { connectorCreateSchema } from "../packages/domain/src/connectors.ts";
import { connectorWriteSchema } from "../packages/domain/src/proxmox.ts";
import { type RemoteJob, remoteHostConfigSchema } from "../packages/domain/src/remote-host.ts";
import {
  remoteHostAdapter,
  sshCommand,
} from "../packages/integrations/src/connectors/remote-host.ts";
import { localJobDriver, RemoteJobManager } from "../packages/integrations/src/remote-jobs.ts";
import { browserFixture } from "./helpers/browser.ts";

const token = "test-host-token-at-least-32-characters";
const { Server, utils } = ssh2;
const adapter = remoteHostAdapter();
const closers = new WeakMap<TestContext, (() => Promise<unknown>)[]>();
function closeAfter(t: TestContext, close: () => Promise<unknown>) {
  closers.set(t, [...(closers.get(t) ?? []), close]);
}
async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "openmuse-host-"));
  t.after(async () => {
    for (const close of (closers.get(t) ?? []).reverse()) await close();
    closers.set(t, []);
    await rm(path, { recursive: true, force: true });
  });
  return path;
}
async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  for (let i = 0; i < 150; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Job did not reach its expected state");
}
async function agent(t: TestContext) {
  const service = await createHostAgent({ token, dataDir: await directory(t) });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  closeAfter(t, () => service.close());
  const address = service.server.address();
  assert.ok(address && typeof address !== "string");
  return { service, baseUrl: `http://127.0.0.1:${address.port}` };
}

test("host contract requires explicit endpoint, pinned SSH fingerprint and valid credentials; reads cannot carry commands", () => {
  assert.equal(
    remoteHostConfigSchema.safeParse({
      mode: "ssh",
      platform: "linux",
      host: "server",
      username: "me",
    }).success,
    false,
  );
  assert.equal(
    remoteHostConfigSchema.safeParse({ baseUrl: "http://secret:token@host" }).success,
    false,
  );
  assert.equal(
    remoteHostConfigSchema.safeParse({ baseUrl: "http://host/?token=secret" }).success,
    false,
  );
  assert.equal(
    connectorCreateSchema.safeParse({
      provider: "remote_host",
      name: "Host",
      config: { baseUrl: "http://localhost:8791" },
      secrets: {},
    }).success,
    false,
  );
  assert.equal(
    connectorWriteSchema.safeParse({
      connectorId: "id",
      operation: "host_command",
      params: { command: "pwd", extra: "unreviewed" },
    }).success,
    false,
  );
  assert.equal(
    connectorWriteSchema.safeParse({
      connectorId: "id",
      operation: "host_input",
      params: { jobId: randomUUID(), text: "x", command: "anything" },
    }).success,
    false,
  );
});

test("PowerShell uses an encoded command and literal cwd; POSIX cwd is shell quoted", () => {
  const built = sshCommand({ platform: "windows" }, "Write-Output '한글'", "C:\\a'b $test");
  const script = Buffer.from(built.split(" ").at(-1)!, "base64").toString("utf16le");
  assert.match(script, /Set-Location -LiteralPath 'C:\\a''b \$test'/);
  assert.match(script, /Write-Output '한글'/);
  assert.match(sshCommand({ platform: "linux" }, "pwd", "/a'b $(nope)"), /cd /);
});

test("native Host Agent authenticates, reports actual OS and executes a Unicode command in a directory with spaces", async (t) => {
  const { baseUrl } = await agent(t);
  assert.equal((await fetch(`${baseUrl}/host`)).status, 401);
  assert.equal(
    (await fetch(`${baseUrl}/host`, { headers: { Authorization: "Bearer wrong-token" } })).status,
    401,
  );
  const ctx = {
    config: { baseUrl, platform: process.platform === "win32" ? "windows" : "linux" },
    secrets: { token },
  };
  const status = (await adapter.run(ctx, "host_status", {})) as {
    platform: string;
    capabilities: Record<string, boolean>;
  };
  assert.equal(status.platform, process.platform);
  assert.equal(status.capabilities.desktop, false);
  assert.equal(status.capabilities.pty, false);
  const cwd = join(await directory(t), "한글 space");
  await mkdir(cwd);
  const command =
    process.platform === "win32"
      ? `Write-Output '한글'; Get-Location | Select-Object -ExpandProperty Path`
      : "printf '한글\\n'; pwd";
  const { job } = (await adapter.write!(ctx, {
    connectorId: "id",
    operation: "host_command",
    params: { command, cwd },
  })) as { job: RemoteJob };
  const result = await poll(
    async () => ((await adapter.run(ctx, "host_job", { jobId: job.id })) as { job: RemoteJob }).job,
    (value) => value.status !== "running",
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /한글/);
  assert.ok(result.output.includes(cwd));
  assert.equal((await adapter.test(ctx)).ok, true);
  assert.equal(
    (
      await fetch(`${baseUrl}/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ command, pty: true }),
      })
    ).status,
    422,
  );
});

test("native command timeout stops the owned process tree and retains a truthful receipt", async (t) => {
  const manager = await new RemoteJobManager(await directory(t), localJobDriver).initialize();
  closeAfter(t, () => manager.close());
  const job = await manager.start({
    command: process.platform === "win32" ? "Start-Sleep -Seconds 20" : "sleep 20",
    timeoutSeconds: 1,
  });
  const result = await poll(
    async () => manager.get(job.id),
    (v) => v.status === "timed_out",
  );
  assert.equal(result.status, "timed_out");
});
test("native stdin sends Unicode input to the same running process", async (t) => {
  const manager = await new RemoteJobManager(await directory(t), localJobDriver).initialize();
  closeAfter(t, () => manager.close());
  const command =
    process.platform === "win32"
      ? "[Console]::WriteLine('READY'); $v = [Console]::ReadLine(); [Console]::WriteLine('INPUT:' + $v)"
      : 'printf "READY\\n"; IFS= read -r value; printf "INPUT:%s\\n" "$value"';
  const job = await manager.start({ command });
  await poll(
    async () => manager.get(job.id),
    (v) => v.output.includes("READY"),
  );
  manager.input(job.id, "한글 입력\n");
  const completed = await poll(
    async () => manager.get(job.id),
    (v) => v.status !== "running",
  );
  assert.equal(completed.exitCode, 0);
  assert.match(completed.output, /INPUT:한글 입력/);
});

test("persisted commands are idempotent, bounded and not replayed after restart", async (t) => {
  const path = await directory(t);
  let launches = 0;
  const driver = async (_input: unknown, output: (text: string) => void) => {
    launches++;
    output("x".repeat(200000));
    return { input: () => {}, stop: () => {} };
  };
  const manager = await new RemoteJobManager(path, driver).initialize();
  const id = randomUUID();
  await manager.start({ command: "one" }, id);
  await manager.start({ command: "one" }, id);
  await assert.rejects(() => manager.start({ command: "two" }, id));
  assert.equal(launches, 1);
  assert.equal(manager.get(id).output.length, 128 * 1024);
  assert.equal(manager.get(id).outputTruncated, true);
  await manager.close();
  const restored = await new RemoteJobManager(path, driver).initialize();
  closeAfter(t, () => restored.close());
  assert.equal(restored.get(id).status, "interrupted");
  assert.equal(launches, 1);
  assert.equal(
    JSON.parse(await readFile(join(path, `${id}.json`), "utf8")).job.status,
    "interrupted",
  );
});

test("SSH verifies the host key before remote execution and allocates a real PTY", async (t) => {
  const key = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const parsed = utils.parseKey(key);
  assert.ok(!(parsed instanceof Error));
  const hostFingerprint = `SHA256:${createHash("sha256").update(parsed.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
  let executions = 0,
    pty = false;
  const clients = new Set<import("ssh2").Connection>();
  const server = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client);
    client.on("error", () => {});
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) =>
      ctx.username === "tester" && ctx.method === "publickey" ? ctx.accept() : ctx.reject(),
    );
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (accept) => {
          pty = true;
          accept?.();
        });
        session.on("exec", (accept, _reject, info) => {
          executions++;
          const stream = accept();
          stream.write(
            info.command.includes("hostname")
              ? "fixture\nLinux\nx86_64\n/bin/sh\n"
              : "PTY command output\n",
          );
          stream.exit(0);
          stream.end();
        });
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const client of clients) client.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const ctx = {
    config: {
      mode: "ssh",
      platform: "linux",
      host: "127.0.0.1",
      port: address.port,
      username: "tester",
      hostFingerprint,
    },
    secrets: { privateKey: key },
    stateDir: await directory(t),
  };
  const wrong = { ...ctx, config: { ...ctx.config, hostFingerprint: `SHA256:${"A".repeat(43)}` } };
  assert.equal((await adapter.test(wrong)).ok, false);
  assert.equal(executions, 0);
  assert.equal((await adapter.test(ctx)).ok, true);
  const { job } = (await adapter.write!(ctx, {
    connectorId: "ssh",
    operation: "host_command",
    params: { command: "anything", pty: true },
  })) as { job: RemoteJob };
  const completed = await poll(
    async () => ((await adapter.run(ctx, "host_job", { jobId: job.id })) as { job: RemoteJob }).job,
    (v) => v.status !== "running",
  );
  assert.equal(completed.exitCode, 0);
  assert.equal(pty, true);
  assert.match(completed.output, /PTY command output/);
});

test("remote shell stays behind native reviews, scopes ownership and rejects a changed connection", async (t) => {
  const remote = await agent(t);
  const { db, config } = await browserFixture(t, () => ({ data: {} }));
  const { app, auth, agent: taskAgent, connectors } = await createApp(db, config);
  t.after(() => taskAgent.stop());
  const session = await auth.session();
  const headers = { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" };
  const connector = await connectors.create("local-user", {
    provider: "remote_host",
    name: "fixture",
    config: { baseUrl: remote.baseUrl },
    secrets: { token },
  });
  assert.ok(!JSON.stringify(connector).includes(token));
  const command = process.platform === "win32" ? "Write-Output 'reviewed'" : "printf reviewed";
  assert.equal(
    (
      await app.request(`/api/connectors/${connector.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ operation: "host_command", params: { command } }),
      })
    ).status,
    422,
  );
  await assert.rejects(() => connectors.run("other-owner", connector.id, "host_status", {}));
  const action = await (
    await app.request("/api/actions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "connector.write",
        data: { connectorId: connector.id, operation: "host_command", params: { command } },
      }),
    })
  ).json();
  assert.equal(action.status, "awaiting_review");
  assert.equal(
    ((await connectors.run("local-user", connector.id, "host_jobs", {})) as { jobs: unknown[] })
      .jobs.length,
    0,
  );
  const result = await (
    await app.request(`/api/actions/${action.id}/decide`, {
      method: "POST",
      headers,
      body: JSON.stringify({ hash: action.hash, decision: "approve" }),
    })
  ).json();
  assert.equal(result.status, "succeeded");
  assert.ok(JSON.parse(result.result).job.id);
  const duplicate = await (
    await app.request(`/api/actions/${action.id}/decide`, {
      method: "POST",
      headers,
      body: JSON.stringify({ hash: action.hash, decision: "approve" }),
    })
  ).json();
  assert.equal(duplicate.id, result.id);
  assert.equal(
    ((await connectors.run("local-user", connector.id, "host_jobs", {})) as { jobs: unknown[] })
      .jobs.length,
    1,
  );
  const prepared = await connectors.prepareWrite("local-user", {
    connectorId: connector.id,
    operation: "host_command",
    params: { command },
  });
  await connectors.update("local-user", connector.id, {
    config: { baseUrl: "http://127.0.0.1:1" },
  });
  await assert.rejects(
    () => connectors.executeWrite("local-user", prepared.input.data, prepared.targetVersion),
    /changed/,
  );
});

test("remote browsers retain their target, reject cross-owner access and honor user takeover", async (t) => {
  const calls: string[] = [];
  const provider = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push(req.url!);
    const id = input.id ?? req.url!.split("/")[2];
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id,
        title: "Remote",
        url: input.url ?? "https://example.com/",
        status: "active",
        updatedAt: new Date().toISOString(),
      }),
    );
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(async () => {
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
  });
  const addr = provider.address();
  assert.ok(addr && typeof addr !== "string");
  const { db, config } = await browserFixture(t, () => {
    throw new Error("Never fall back to the default worker");
  });
  const connectors = new ConnectorService(db, config),
    auth = new Auth(db, config, "host-test-key");
  const browser = new BrowserService(
    db,
    config,
    auth,
    new Files(db, config, auth),
    Date.now,
    connectors,
  );
  const host = await connectors.create("alice", {
    provider: "remote_host",
    name: "Host",
    config: { baseUrl: `http://127.0.0.1:${addr.port}` },
    secrets: { token },
  });
  const session = await browser.create("alice", "https://example.com/", host.id);
  assert.equal(session.connectorId, host.id);
  assert.ok(session.connectorRevision);
  assert.equal(session.control, "agent");
  await assert.rejects(() => browser.input("bob", session.id, { type: "key", key: "Enter" }));
  await browser.setControl("alice", session.id, "user");
  const count = calls.length;
  await assert.rejects(
    () => browser.input("alice", session.id, { type: "text", text: "agent" }, true),
    /사용자/,
  );
  assert.equal(calls.length, count);
  const own = await browser.input("alice", session.id, { type: "text", text: "user" });
  assert.equal(own.control, "user");
  assert.equal(own.connectorId, host.id);
  await browser.setControl("alice", session.id, "agent");
  await browser.input("alice", session.id, { type: "key", key: "Enter" }, true);
  await connectors.update("alice", host.id, { config: { baseUrl: "http://127.0.0.1:1" } });
  await assert.rejects(
    () => browser.input("alice", session.id, { type: "key", key: "Enter" }),
    /変更|변경/,
  );
});
