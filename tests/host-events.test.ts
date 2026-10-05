import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AbstractAgent, type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { Observable } from "rxjs";
import { createNotificationGateway } from "../apps/host-agent/src/notifications.ts";
import { createApp } from "../apps/server/src/app.ts";
import { HostEventService } from "../apps/server/src/host-events.ts";
import { type HostEvent, hostEventInputSchema } from "../packages/domain/src/host-events.ts";
import { browserFixture } from "./helpers/browser.ts";

const hostStatus = {
  hostname: "fixture-pc",
  platform: "win32",
  arch: "x64",
  shell: "powershell.exe",
  capabilities: { shell: true, browser: true, pty: false, desktop: false },
};
const token = "host-event-test-token-".repeat(3);
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  for (let n = 0; n < 200; n++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("Timed out");
}
const input = (key: string, extra = {}) => ({
  key,
  message: "검증 보고입니다",
  source: "codex",
  reply: false,
  ...extra,
});

test("host callbacks require registered machine credentials, deduplicate and persist labeled main/side chat reports", async (t) => {
  const f = await browserFixture(t, () => ({ data: hostStatus }));
  const a = await createApp(f.db, { ...f.config, authMode: "none" });
  t.after(() => {
    a.hostEvents.close();
    return a.agent.stop();
  });
  const host = await a.connectors.create("local-user", {
    provider: "remote_host",
    name: "테스트 PC",
    config: { mode: "agent", platform: "windows", baseUrl: f.config.workerUrl },
    secrets: { token },
  });
  const session = await a.auth.session(),
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const url = `/api/host-agent/${host.id}/events`;
  for (const h of [
    {},
    { Authorization: `Bearer ${session.token}` },
    { Authorization: "Bearer wrong" },
  ] as Record<string, string>[])
    assert.equal(
      (
        await a.app.request(url, {
          method: "POST",
          headers: { ...h, "Content-Type": "application/json" },
          body: JSON.stringify(input("auth")),
        })
      ).status,
      401,
    );
  const post = (value: unknown) =>
    a.app.request(url, { method: "POST", headers, body: JSON.stringify(value) });
  assert.equal((await post({ ...input("role"), role: "system" })).status, 422);
  const response = await post(input("one"));
  assert.equal(response.status, 202);
  const { event } = (await response.json()) as { event: HostEvent };
  const complete = await until(
    () => a.hostEvents.get("local-user", event.id),
    (e) => e.status === "delivered",
  );
  const thread = await a.conversations.get("local-user", complete.threadId);
  assert.equal(thread.messages.length, 1);
  assert.match(String(thread.messages[0].content), /원격 호스트 보고/);
  assert.match(String((thread.messages[0] as { name?: string }).name), /테스트 PC.*codex/);
  assert.equal(thread.approvalMode, "review");
  const duplicate = await post(input("one"));
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => post(input("concurrent"))));
  assert.equal(concurrent.filter((r) => r.status === 202).length, 1);
  const concurrentEvent = (await concurrent[0].json()).event as HostEvent;
  await until(
    () => a.hostEvents.get("local-user", concurrentEvent.id),
    (e) => e.status === "delivered",
  );
  assert.equal(
    (await a.conversations.get("local-user", concurrentEvent.threadId)).messages.filter(
      (m) => m.id === concurrentEvent.messageId,
    ).length,
    1,
  );
  assert.equal((await post({ ...input("one"), message: "different" })).status, 409);
  await a.conversations.create("local-user", { id: "side-report" });
  const side = await post(input("side", { target: "side-report", reply: true }));
  assert.equal(side.status, 202);
  const sideEvent = (await side.json()).event as HostEvent;
  await until(
    () => a.hostEvents.get("local-user", sideEvent.id),
    (e) => e.status === "delivered",
  );
  assert.ok(
    (await a.conversations.get("local-user", "side-report")).messages.some(
      (m) => m.role === "assistant",
    ),
  );
  await a.conversations.create("someone-else", { id: "private-thread" });
  assert.equal((await post(input("other", { target: "private-thread" }))).status, 404);
  await a.conversations.setArchived("local-user", "side-report", true);
  assert.equal((await post(input("archived", { target: "side-report" }))).status, 409);
  const second = await a.connectors.create("local-user", {
    provider: "remote_host",
    name: "Other",
    config: { mode: "agent", platform: "windows", baseUrl: f.config.workerUrl },
    secrets: { token },
  });
  assert.equal(
    (await a.app.request(`/api/host-agent/${second.id}/events/${event.id}`, { headers })).status,
    404,
  );
  const apiHeaders = { Authorization: `Bearer ${session.token}` };
  assert.equal((await a.app.request("/api/host-events")).status, 401);
  const stream = await a.app.request("/api/host-events/stream", { headers: apiHeaders });
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  const reader = stream.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /テスト|테스트 PC/);
  await reader.cancel();
  const rotatedToken = token + "-rotated";
  await a.connectors.update("local-user", host.id, { secrets: { token: rotatedToken } });
  assert.equal((await post(input("rotated"))).status, 401);
  const ssh = await a.connectors.create("local-user", {
    provider: "remote_host",
    name: "SSH only",
    config: {
      mode: "ssh",
      platform: "linux",
      host: "127.0.0.1",
      username: "tester",
      authMethod: "password",
      hostFingerprint: "SHA256:" + "A".repeat(43),
    },
    secrets: { password: "test-password" },
  });
  assert.equal(
    (
      await a.app.request(`/api/host-agent/${ssh.id}/events`, {
        method: "POST",
        headers,
        body: JSON.stringify(input("ssh")),
      })
    ).status,
    401,
  );
  await a.connectors.remove("local-user", host.id);
  assert.equal((await post(input("deleted"))).status, 401);
});

class HeldAgent extends AbstractAgent {
  release: () => void = () => {};
  constructor(readonly openMuseOwner: string) {
    super({ agentId: "default" });
  }
  clone() {
    return this;
  }
  run(i: RunAgentInput) {
    return new Observable<BaseEvent>((s) => {
      s.next({ type: EventType.RUN_STARTED, threadId: i.threadId, runId: i.runId });
      this.release = () => {
        s.next({ type: EventType.RUN_FINISHED, threadId: i.threadId, runId: i.runId });
        s.complete();
      };
    });
  }
}
test("reports wait for active chat, preserve history and replay only queued records after restart", async (t) => {
  const f = await browserFixture(t, () => ({ data: hostStatus })),
    a = await createApp(f.db, f.config);
  t.after(() => {
    a.hostEvents.close();
    return a.agent.stop();
  });
  const host = await a.connectors.create("local-user", {
    provider: "remote_host",
    name: "Host",
    config: { mode: "agent", platform: "linux", baseUrl: f.config.workerUrl },
    secrets: { token },
  });
  const held = new HeldAgent("local-user"),
    threadId = "busy-thread",
    runId = randomUUID();
  await a.conversations.ensure("local-user", threadId);
  a.conversations
    .run({
      threadId,
      agent: held,
      input: {
        threadId,
        runId,
        messages: [{ id: "first-user", role: "user", content: "진행 중" }],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      },
    })
    .subscribe();
  await until(
    () => a.conversations.get("local-user", threadId),
    (v) => !!v.activeRunId,
  );
  const report = await a.hostEvents.accept(
    "local-user",
    host,
    input("during-run", { target: threadId }),
  );
  assert.equal(report.event.status, "queued");
  held.release();
  await until(
    () => a.hostEvents.get("local-user", report.event.id),
    (v) => v.status === "delivered",
  );
  const messages = (await a.conversations.get("local-user", threadId)).messages;
  assert.equal(messages[0].id, "first-user");
  assert.equal(messages.filter((m) => m.id === report.event.messageId).length, 1);
  a.hostEvents.close();
  const queued = {
    ...report.event,
    id: "a".repeat(64),
    key: "restart",
    messageId: "host-report-restart",
    runId: randomUUID(),
    status: "queued" as const,
  };
  const interrupted = {
    ...report.event,
    id: "b".repeat(64),
    key: "interrupted",
    messageId: "host-report-interrupted",
    runId: randomUUID(),
    status: "running" as const,
  };
  await f.db.put("local-user", "host-events", queued);
  await f.db.put("local-user", "host-events", interrupted);
  const recovered = new HostEventService(
    f.db,
    a.connectors,
    a.conversations,
    async () => new HeldAgent("local-user"),
  );
  t.after(() => recovered.close());
  await recovered.recover();
  await until(
    () => recovered.get("local-user", queued.id),
    (v) => v.status === "delivered",
  );
  assert.equal((await recovered.get("local-user", interrupted.id)).status, "interrupted");
  assert.equal(
    (await a.conversations.get("local-user", threadId)).messages.some(
      (m) => m.id === interrupted.messageId,
    ),
    false,
  );
});

test("local gateway rejects browser/rebinding calls; durable retries and CLI file/stdin reports use one idempotency key", async (t) => {
  const f = await browserFixture(t, () => ({ data: hostStatus })),
    a = await createApp(f.db, f.config);
  t.after(() => {
    a.hostEvents.close();
    return a.agent.stop();
  });
  const host = await a.connectors.create("local-user", {
    provider: "remote_host",
    name: "CLI PC",
    config: { mode: "agent", platform: "linux", baseUrl: f.config.workerUrl },
    secrets: { token },
  });
  const cfg = { token, connectorId: host.id, enrollmentOrigin: "http://openmuse.test" };
  let online = false,
    sends = 0;
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!online) throw Error("offline");
    sends++;
    return a.app.request(String(url), init);
  }) as typeof fetch;
  const directory = join(f.config.dataDir, "outbox");
  const gateway = await createNotificationGateway({
    dataDir: directory,
    config: async () => cfg,
    fetch: request,
    retryMs: 30,
  });
  t.after(() => gateway.close());
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const port = (gateway.server.address() as { port: number }).port,
    base = `http://127.0.0.1:${port}`,
    headers = { "X-OpenMuse-Client": "cli", "Content-Type": "application/json" };
  assert.equal((await fetch(base + "/status")).status, 403);
  assert.equal(
    (await fetch(base + "/status", { headers: { ...headers, Origin: "http://evil.test" } })).status,
    403,
  );
  assert.equal(
    await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        base + "/status",
        { headers: { ...headers, Host: "evil.test" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    }),
    403,
  );
  const accepted = await fetch(base + "/events", {
    method: "POST",
    headers,
    body: JSON.stringify(input("retry-key")),
  });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).status, "queued");
  await gateway.close();
  online = true;
  const restarted = await createNotificationGateway({
    dataDir: directory,
    config: async () => cfg,
    fetch: request,
    retryMs: 30,
  });
  restarted.server.listen(0, "127.0.0.1");
  await once(restarted.server, "listening");
  t.after(() => restarted.close());
  await until(
    async () => JSON.parse(await readFile(join(directory, "notifications.json"), "utf8")),
    (r) => r[0].status === "accepted",
  );
  assert.equal(sends, 1);
  const cli = resolve("infra/remote-host/cli.mjs"),
    cliPort = String((restarted.server.address() as { port: number }).port),
    file = join(directory, "message.txt");
  await writeFile(file, "한글 보고\n테스트 통과", "utf8");
  const exec = promisify(execFile),
    env = { ...process.env, OPENMUSE_CLI_HOME: join(directory, "cli-config") };
  const args = [
    cli,
    "send",
    "--file",
    file,
    "--source",
    "codex",
    "--type",
    "question",
    "--idempotency-key",
    "cli-key",
    "--target",
    "host",
    "--no-reply",
    "--port",
    cliPort,
  ];
  const result = JSON.parse((await exec(process.execPath, args, { env })).stdout);
  assert.equal(result.ok, true);
  assert.equal(result.data.input.message, "한글 보고\n테스트 통과");
  await exec(process.execPath, args, { env });
  assert.equal(sends, 2);
  const receipts = await a.hostEvents.list("local-user");
  assert.equal(receipts.filter((e) => e.key === "cli-key").length, 1);
  const bad = await fetch(`http://127.0.0.1:${cliPort}/events`, {
    method: "POST",
    headers,
    body: JSON.stringify(input("cli-key", { message: "different" })),
  });
  assert.equal(bad.status, 409);
  assert.equal(
    hostEventInputSchema.safeParse(input("big", { message: "가".repeat(11000) })).success,
    false,
  );
  assert.equal(JSON.stringify(result).includes(token), false);
  const stdinResult = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [cli, "send", "--stdin", "--no-reply", "--idempotency-key", "stdin-key", "--port", cliPort],
      { env },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin!.end(Buffer.from("표준 입력 확인", "utf8"));
  });
  assert.equal(JSON.parse(stdinResult).data.input.message, "표준 입력 확인");
});
