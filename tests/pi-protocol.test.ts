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
  intelligenceApiKey: "test-project-key-never-sent",
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

  assert.equal(result.status, "waiting_input");
  assert.deepEqual(
    current.plan.map(({ title }) => title),
    ["Inspect", "Verify"],
  );
  assert.ok(events.some((value) => value.includes("Agent update")));
  assert.equal(fixture.requests.length, 2);
  assert.ok(fixture.requests.every((request) => request.path === "/v1/responses"));
  assert.ok(
    fixture.requests.every((request) => request.authorization === "Bearer local-pi-protocol-key"),
  );
  assert.match(JSON.stringify(fixture.requests[0]?.body.tools), /set_plan/);
  assert.match(JSON.stringify(fixture.requests[1]?.body.input), /function_call_output/);
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
