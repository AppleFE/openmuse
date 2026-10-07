import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AbstractAgent } from "@ag-ui/client";
import { CopilotKitCore, ProxiedCopilotRuntimeAgent } from "@copilotkit/core";
import { serve } from "@hono/node-server";
import { throwError } from "rxjs";
import { conversationHistorySubscriber } from "../apps/mobile/src/conversation-history.ts";
import { ConversationQueue } from "../apps/mobile/src/conversation-queue.ts";
import { runConversationTurn } from "../apps/mobile/src/conversation-run.ts";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";

test("a stale second client adopts server chronology before replying and on reconnect", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-two-clients-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(db, {
    mode: "sample",
    agentBackend: "sample",
    dataDir: directory,
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  const http = serve({ fetch: server.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => http.on("listening", resolve));
  t.after(async () => {
    if ("closeAllConnections" in http) http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    server.hostEvents.close();
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const { token } = await server.auth.session();
  const client = () => {
    const agent = new ProxiedCopilotRuntimeAgent({
      agentId: "default",
      threadId: "two-clients",
      runtimeUrl: `${url}/api/copilotkit`,
      headers: { Authorization: `Bearer ${token}` },
    });
    const core = new CopilotKitCore({ agents__unsafe_dev_only: { default: agent } });
    agent.subscribe(conversationHistorySubscriber);
    return { agent, core };
  };
  const first = client(),
    second = client();
  async function send(c: ReturnType<typeof client>, id: string) {
    c.agent.addMessage({ id, role: "user", content: `hello ${id}` });
    await runConversationTurn(
      "default",
      () => c.core.runAgent({ agent: c.agent }),
      (onError) => c.core.subscribe({ onError }),
    );
  }
  async function storedIds() {
    const r = await fetch(`${url}/api/copilotkit/threads/two-clients/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { messages } = (await r.json()) as { messages: { id: string }[] };
    return messages.map((m) => m.id);
  }
  await send(first, "initial");
  await second.core.connectAgent({ agent: second.agent });
  assert.deepEqual(
    second.agent.messages.map((m) => m.id),
    await storedIds(),
  );
  await send(first, "remote-turn");
  assert.ok(!second.agent.messages.some((m) => m.id === "remote-turn"));
  await send(second, "local-follow-up");
  assert.deepEqual(
    second.agent.messages.map((m) => m.id),
    await storedIds(),
  );
  assert.ok(
    second.agent.messages.findIndex((m) => m.id === "remote-turn") <
      second.agent.messages.findIndex((m) => m.id === "local-follow-up"),
  );
  // The first tab is now stale in the opposite direction. A snapshot must not
  // preserve its local order when an already-known message was misplaced.
  first.agent.setMessages([...second.agent.messages].reverse());
  await first.core.connectAgent({ agent: first.agent });
  first.agent.setMessages([...second.agent.messages].reverse());
  await first.core.connectAgent({ agent: first.agent });
  assert.deepEqual(
    first.agent.messages.map((m) => m.id),
    await storedIds(),
  );
});

test("an emitted CopilotKit run error stops the queue even when runAgent resolves", async () => {
  let attempts = 0;
  class FailingAgent extends AbstractAgent {
    run() {
      attempts++;
      return throwError(() => new Error("Connection interrupted"));
    }
  }
  const agent = new FailingAgent({ agentId: "default" });
  const core = new CopilotKitCore({ agents__unsafe_dev_only: { default: agent } });
  const queue = new ConversationQueue();
  queue.enqueue({ id: "first", text: "First task" });
  queue.enqueue({ id: "second", text: "Second task" });
  await assert.rejects(
    queue.flush(() =>
      runConversationTurn(
        "default",
        () => core.runAgent({ agent }),
        (onError) => core.subscribe({ onError }),
      ),
    ),
    /Connection interrupted/,
  );
  assert.equal(attempts, 1);
  assert.equal(queue.getSnapshot().paused, true);
  assert.deepEqual(
    queue.getSnapshot().pending.map((message) => message.id),
    ["second"],
  );
});
