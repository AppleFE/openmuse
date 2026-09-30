import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { executeModelTask } from "../apps/server/src/engine/model.ts";
import type { AgentTask, ModelProfile } from "../packages/domain/src/agent.ts";
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
