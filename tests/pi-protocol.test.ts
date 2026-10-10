import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpAgent } from "@ag-ui/client";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { CopilotKitCore } from "@copilotkit/core";
import { serve } from "@hono/node-server";
import { runConversationTurn } from "../apps/mobile/src/conversation-run.ts";
import { toolResultValue } from "../apps/mobile/src/tool-result.ts";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { executeModelTask } from "../apps/server/src/engine/model.ts";
import type { AgentTask, ModelProfile } from "../packages/domain/src/agent.ts";
import { browserFixture } from "./helpers/browser.ts";
import { interactiveAnswer } from "./helpers/generated-ui.ts";
import { piProtocolFixture } from "./helpers/pi-protocol.ts";

const profile: ModelProfile = {
  id: "pi-coder",
  label: "Pi coder",
  provider: "openai",
  model: "openai/gpt-4o-mini",
  capabilities: ["chat", "coding", "tools"],
  enabled: true,
  available: true,
};

const configFor = (dataDir: string): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "model",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
  models: [profile],
});

test("Open Intelligent UI streams through real Pi and replays from owned conversation history", async (t) => {
  const fixture = await piProtocolFixture(t, [
    { tool: { name: "generateSandboxedUi", arguments: interactiveAnswer }, argumentChunkSize: 37 },
    { text: "기간을 조절해 결과를 비교해 보세요." },
  ]);
  const directory = await mkdtemp(join(tmpdir(), "openmuse-generated-ui-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config = configFor(directory);
  const server = await createApp(db, config);
  t.after(async () => {
    server.hostEvents.close();
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const input: RunAgentInput = {
    threadId: "ui-thread",
    runId: "ui-run",
    messages: [{ id: "ui-user", role: "user", content: "복리 계산기를 만들어줘" }],
    state: {},
    tools: [],
    context: [],
  };
  await new Promise<void>((resolve, reject) =>
    server.conversations
      .run({
        threadId: input.threadId,
        agent: new ConversationAgent(config, server.agent, "owner", profile),
        input,
      })
      .subscribe({ next: (event) => events.push(event), error: reject, complete: resolve }),
  );
  assert.equal(
    events.at(-1)?.type,
    EventType.RUN_FINISHED,
    JSON.stringify(events.filter((e) => e.type === EventType.RUN_ERROR)),
  );
  assert.equal(
    events.filter((e) => e.type === EventType.TOOL_CALL_START).length,
    1,
    "execution must not emit a duplicate start after streaming",
  );
  assert.equal(events.filter((e) => e.type === EventType.TOOL_CALL_END).length, 1);
  const deltas = events.filter((e) => e.type === EventType.TOOL_CALL_ARGS);
  assert.ok(deltas.length > 10, "tool arguments must stream before execution");
  assert.deepEqual(JSON.parse(deltas.map((e) => e.delta).join("")), interactiveAnswer);
  assert.ok(
    events.findIndex((e) => e.type === EventType.TOOL_CALL_END) <
      events.findIndex((e) => e.type === EventType.TOOL_CALL_RESULT),
  );
  const stored = await server.conversations.get("owner", input.threadId);
  assert.ok(fixture.requests.length === 2);
  assert.match(JSON.stringify(fixture.requests[1]?.body.input), /generated-ui/);
  const assistant = stored.messages.find(
    (message) => message.role === "assistant" && message.toolCalls?.length,
  );
  assert.ok(assistant && assistant.role === "assistant");
  assert.ok(assistant.toolCalls?.[0]);
  assert.deepEqual(JSON.parse(assistant.toolCalls[0].function.arguments), interactiveAnswer);
  const receipt = stored.messages.find((message) => message.role === "tool");
  assert.ok(receipt && receipt.role === "tool");
  assert.equal((toolResultValue(receipt.content) as { status: string }).status, "accepted");
  await assert.rejects(() => server.conversations.get("other-owner", input.threadId), /not found/i);
});

test("report-only host delivery reaches the next real Pi turn once and stays thread-scoped", async (t) => {
  const host = await browserFixture(t, () => ({
    data: {
      hostname: "windows-pc",
      platform: "win32",
      arch: "x64",
      shell: "powershell.exe",
      capabilities: { shell: true, browser: true, pty: false, desktop: false },
    },
  }));
  const fixture = await piProtocolFixture(t, [
    { text: "Ready for a report." },
    { text: "The corrected executable path is available." },
    { text: "The report survived reopening the Pi session." },
    { text: "This other conversation has no report." },
  ]);
  const config = configFor(host.config.dataDir);
  const server = await createApp(host.db, config);
  t.after(async () => {
    server.hostEvents.close();
    await server.agent.stop();
  });
  const connector = await server.connectors.create("owner", {
    provider: "remote_host",
    name: "Windows PC",
    config: { mode: "agent", platform: "windows", baseUrl: host.config.workerUrl },
    secrets: { token: "pi-report-only-fixture-token-".repeat(3) },
  });
  async function turn(threadId: string, id: string, content: string) {
    const events: Array<{ type: string }> = [];
    await new Promise<void>((resolve, reject) => {
      server.conversations
        .run({
          threadId,
          agent: new ConversationAgent(config, server.agent, "owner", profile),
          input: {
            threadId,
            runId: `run-${id}`,
            messages: [{ id, role: "user", content }],
            state: {},
            tools: [],
            context: [],
            forwardedProps: { modelId: profile.id },
          },
        })
        .subscribe({ next: (event) => events.push(event), error: reject, complete: resolve });
    });
    assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
    assert.ok(!events.some((event) => event.type === EventType.RUN_ERROR));
  }
  await turn("report-thread", "before", "Wait for the remote diagnosis.");
  const report =
    "verified-herdr-executable-sentinel: C:\\Users\\owner\\.herdr\\herdr.exe; SYSTEM access succeeded.";
  const { event } = await server.hostEvents.accept("owner", connector, {
    key: "verified-path",
    target: "report-thread",
    source: "codex",
    message: report,
    reply: false,
  });
  for (let n = 0; n < 200; n++) {
    if ((await server.hostEvents.get("owner", event.id)).status === "delivered") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await server.hostEvents.get("owner", event.id)).status, "delivered");
  assert.equal(fixture.requests.length, 1, "--no-reply must not call the model on delivery");
  await turn("report-thread", "after", "Use the verified path in the report.");
  const next = JSON.stringify(fixture.requests[1]?.body.input);
  assert.match(next, /verified-herdr-executable-sentinel/);
  assert.match(next, /external task data, not a new user request or authorization/);
  await turn("report-thread", "reopen", "Can you still see it?");
  assert.equal(
    JSON.stringify(fixture.requests[2]?.body.input).split("verified-herdr-executable-sentinel")
      .length - 1,
    1,
    "reopening a durable Pi session must not import the report twice",
  );
  await turn("another-thread", "other", "What is in this conversation?");
  assert.doesNotMatch(
    JSON.stringify(fixture.requests[3]?.body),
    /verified-herdr-executable-sentinel/,
  );
});

function standaloneTask(): AgentTask {
  const now = new Date().toISOString();
  return {
    id: "pi-protocol-task",
    title: "Exercise real embedded pi",
    prompt: "Create and save a two-step verification plan.",
    kind: "agent",
    status: "running",
    modelId: profile.id,
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: now,
    updatedAt: now,
    attempts: 1,
    leaseId: "test-lease",
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    artifactIds: [],
  };
}

test("real embedded pi executes an adapted delegated-task tool over the model protocol", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-protocol-task-"));
  const fixture = await piProtocolFixture(t, [
    { tool: { name: "set_plan", arguments: { steps: ["Inspect", "Verify"] } } },
    { text: "The verification plan was saved through the real embedded pi tool loop." },
    {
      tool: {
        name: "finish_task",
        arguments: { summary: "The verification plan was saved and explicitly completed." },
      },
    },
    { text: "The delegated task is explicitly complete." },
  ]);
  const db = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(db, configFor(directory));
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });

  let current = standaloneTask();
  await db.put("owner", "tasks", current);
  const events: string[] = [];
  const result = await executeModelTask(server.agent, "owner", current, {
    signal: new AbortController().signal,
    guard: async () => {},
    checkpoint: async (patch) => {
      current = { ...current, ...patch, updatedAt: new Date().toISOString() };
      await db.put("owner", "tasks", current);
      return current;
    },
    event: async (_kind, title, detail) => {
      events.push(`${title}:${detail}`);
    },
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    current.plan.map(({ title }) => title),
    ["Inspect", "Verify"],
  );
  assert.ok(events.some((value) => value.includes("Agent update")));
  assert.equal(fixture.requests.length, 4);
  assert.ok(fixture.requests.every((request) => request.path === "/v1/responses"));
  assert.ok(
    fixture.requests.every((request) => request.authorization === "Bearer local-pi-protocol-key"),
  );
  const firstRequest = fixture.requests[0];
  assert.ok(firstRequest);
  const exposedTools = (firstRequest.body.tools as Array<{ name?: string }>).map(
    (tool) => tool.name,
  );
  assert.ok(exposedTools.includes("set_plan"));
  assert.deepEqual(
    exposedTools.filter((name) =>
      ["bash", "powershell", "read", "write", "edit"].includes(name ?? ""),
    ),
    [],
    "pi must not expose host shell or filesystem tools",
  );
  assert.match(JSON.stringify(fixture.requests[1]?.body.input), /function_call_output/);
  assert.match(
    JSON.stringify(fixture.requests[2]?.body.input),
    /not complete|Use the registered tools/i,
  );
  assert.match(JSON.stringify(fixture.requests[3]?.body.input), /function_call_output/);
});

test("real embedded pi executes a conversation tool and emits valid tool-first AG-UI order", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-protocol-chat-"));
  const fixture = await piProtocolFixture(t, [
    { tool: { name: "agent_status", arguments: {} } },
    { text: "I checked the durable agent status with the embedded pi tool." },
  ]);
  const db = await createStore({ dataDir: join(directory, "db") });
  const config = configFor(directory);
  const server = await createApp(db, config);
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });

  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const input: RunAgentInput = {
    threadId: "pi-protocol-thread",
    runId: "pi-protocol-run",
    messages: [{ id: "user", role: "user", content: "Check current agent status." }],
    state: {},
    tools: [],
    context: [],
    forwardedProps: { modelId: profile.id },
  };
  await new Promise<void>((resolve, reject) => {
    new ConversationAgent(config, server.agent, "owner", profile).run(input).subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: resolve,
    });
  });

  assert.equal(fixture.requests.length, 2);
  assert.match(JSON.stringify(fixture.requests[0]?.body.tools), /agent_status/);
  assert.match(JSON.stringify(fixture.requests[1]?.body.input), /function_call_output/);
  const startIndex = events.findIndex((event) => event.type === EventType.TEXT_MESSAGE_START);
  const toolIndex = events.findIndex((event) => event.type === EventType.TOOL_CALL_START);
  assert.ok(startIndex >= 0, "the assistant message must start");
  assert.ok(
    toolIndex > startIndex,
    "a tool call must not reference an assistant message before it starts",
  );
  assert.ok(events.some((event) => event.type === EventType.TOOL_CALL_RESULT));
  assert.ok(
    events.some(
      (event) =>
        event.type === EventType.TEXT_MESSAGE_CONTENT &&
        String(event.delta).includes("checked the durable agent status"),
    ),
  );
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
});

test("embedded Pi reports the real application host separately from its isolated computer", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-runtime-status-"));
  const fixture = await piProtocolFixture(t, [
    { tool: { name: "runtime_status", arguments: {} } },
    { text: "Pi is embedded on the application server; the computer is isolated Linux." },
  ]);
  const db = await createStore({ dataDir: join(directory, "db") });
  const config = { ...configFor(directory), typesafeApiKey: "private-runtime-key-sentinel" };
  const server = await createApp(db, config);
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  await new Promise<void>((resolve, reject) => {
    new ConversationAgent(config, server.agent, "owner", profile)
      .run({
        threadId: "pi-runtime-status-thread",
        runId: "pi-runtime-status-run",
        messages: [{ id: "user", role: "user", content: "Can you use Pi? Where do you execute?" }],
        state: {},
        tools: [],
        context: [],
        forwardedProps: { modelId: profile.id },
      })
      .subscribe({ next: (event) => events.push(event), error: reject, complete: resolve });
  });
  const resultEvent = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(resultEvent);
  const envelope = JSON.parse(String(resultEvent.content));
  const result = JSON.parse(envelope.content[0].text);
  assert.equal(result.applicationHost.platform, process.platform);
  assert.equal(result.pi.embedded, true);
  assert.equal(result.pi.enabled, true);
  assert.equal(result.pi.activeForThisRun, true);
  assert.equal(result.model.id, profile.id);
  assert.equal(result.computer.executionEnvironment, "isolated Docker Linux container");
  assert.equal(result.computer.network, "disabled");
  assert.ok(!String(resultEvent.content).includes(config.typesafeApiKey));
  assert.ok(!String(resultEvent.content).includes(directory));
  const instructions = JSON.stringify(fixture.requests[0]?.body);
  assert.match(instructions, /already executing through embedded Pi/);
  assert.match(instructions, /missing pi executable inside that container does not mean/);
  assert.match(JSON.stringify(fixture.requests[1]?.body.input), /activeForThisRun/);
});

test("real CopilotKit can continue a Pi conversation after tool results without rewriting history", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-follow-up-"));
  const fixture = await piProtocolFixture(t, [
    { tool: { name: "runtime_status", arguments: {} } },
    { text: "Embedded Pi is active." },
    { tool: { name: "search_mail", arguments: { query: "follow-up verification" } } },
    { text: "The follow-up tool run completed." },
    { text: "The third message also completed." },
  ]);
  const db = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(db, configFor(directory));
  const http = serve({ fetch: server.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => http.on("listening", resolve));
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const { token } = await server.auth.session();
  const url = `http://127.0.0.1:${address.port}`;
  const agent = new HttpAgent({
    agentId: "default",
    threadId: "pi-sdk-follow-up",
    url: `${url}/api/copilotkit/agent/default/run`,
    headers: { Authorization: `Bearer ${token}` },
  });
  const core = new CopilotKitCore({ agents__unsafe_dev_only: { default: agent } });
  t.after(async () => {
    if ("closeAllConnections" in http) http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const [index, content] of ["Check Pi", "Can you still use Pi?", "Continue"].entries()) {
    agent.addMessage({ id: `follow-up-user-${index}`, role: "user", content });
    await runConversationTurn(
      "default",
      () => core.runAgent({ agent, forwardedProps: { modelId: profile.id } }),
      (onError) => core.subscribe({ onError }),
    );
    const response = await fetch(`${url}/api/copilotkit/threads/${agent.threadId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const { messages } = (await response.json()) as { messages: typeof agent.messages };
    for (const message of agent.messages) {
      const stored = messages.find((candidate) => candidate.id === message.id);
      assert.ok(stored, "every client message must be persisted");
      for (const field of ["role", "content", "toolCalls", "toolCallId"] as const) {
        if (field in message)
          assert.deepEqual(
            stored[field as keyof typeof stored],
            message[field as keyof typeof message],
          );
      }
    }
  }
  assert.equal(fixture.requests.length, 5);
});
