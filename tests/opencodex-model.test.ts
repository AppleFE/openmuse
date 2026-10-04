import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { agentConfigured } from "../apps/server/src/agent.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { ModelRegistry } from "../apps/server/src/engine/models.ts";
import type { AgentService } from "../apps/server/src/engine/service.ts";
import { TeamModelExecutor } from "../apps/server/src/engine/team-model.ts";
import type { AgentTask, AgentTeamRole, ModelProfile } from "../packages/domain/src/agent.ts";

function responseEvents(model: string, text: string) {
  const base = {
    id: "resp_test",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "in_progress",
    model,
    output: [],
    output_text: "",
  };
  const item = {
    id: "msg_test",
    type: "message",
    status: "in_progress",
    role: "assistant",
    content: [],
  };
  const completedItem = {
    ...item,
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    { type: "response.created", sequence_number: 0, response: base },
    { type: "response.output_item.added", sequence_number: 1, output_index: 0, item },
    {
      type: "response.content_part.added",
      sequence_number: 2,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 3,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: "response.output_text.done",
      sequence_number: 4,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    },
    {
      type: "response.output_item.done",
      sequence_number: 5,
      output_index: 0,
      item: completedItem,
    },
    {
      type: "response.completed",
      sequence_number: 6,
      response: { ...base, status: "completed", output: [completedItem], output_text: text },
    },
  ];
}

function task(): AgentTask {
  const now = new Date().toISOString();
  return {
    id: "opencodex-task",
    title: "Test routing",
    prompt: "Return the routed model",
    kind: "agent",
    status: "running",
    plan: [],
    evidence: [],
    input: {},
    state: {},
    createdAt: now,
    updatedAt: now,
    attempts: 1,
    leaseId: "lease",
    leaseUntil: new Date(Date.now() + 60000).toISOString(),
    artifactIds: [],
  };
}

test("OpenCodex profiles use its native Responses endpoint, data key, and selected routed model", async () => {
  const requests: { authorization?: string; body: Record<string, unknown>; url?: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push({ authorization: request.headers.authorization, body, url: request.url });
    const model = String(body.model);
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "x-opencodex-request-id": "ocx-0123456789abcdef0123456789abcdef",
    });
    for (const event of responseEvents(model, `served:${model}`))
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const previousUrl = process.env.OPENCODEX_BASE_URL;
  const previousKey = process.env.OPENCODEX_API_KEY;
  process.env.OPENCODEX_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENCODEX_API_KEY = "ocx-test-data-key";
  const db = await createStore();
  try {
    const models: ModelProfile[] = ["alpha", "beta"].map((id) => ({
      id,
      label: id,
      provider: "opencodex",
      model: `opencodex/provider/${id}`,
      capabilities: ["chat", "coding"],
      enabled: true,
      available: true,
    }));
    const config: Config = {
      mode: "sample",
      port: 1,
      host: "127.0.0.1",
      publicUrl: "http://localhost:1",
      dataDir: ".",
      agentBackend: "model",
      googleRedirectUri: "http://localhost:1/api/google/callback",
      allowedOrigins: [],
      models,
      openCodexBaseUrl: process.env.OPENCODEX_BASE_URL,
      openCodexApiKey: process.env.OPENCODEX_API_KEY,
    };
    assert.equal(agentConfigured(config), true);
    const registry = new ModelRegistry(db, config);
    const executor = new TeamModelExecutor(registry);
    for (const modelId of ["alpha", "beta"]) {
      const role: AgentTeamRole = {
        id: `role-${modelId}`,
        label: modelId,
        kind: "coder",
        modelId,
        systemPrompt: "Reply once",
        dependsOn: [],
      };
      const result = await executor.execute({
        owner: "owner",
        task: task(),
        role,
        dependencyContext: {},
        signal: new AbortController().signal,
      });
      assert.equal(result.output, `served:provider/${modelId}`);
    }
    assert.deepEqual(
      requests.map((request) => request.body.model),
      ["provider/alpha", "provider/beta"],
    );
    assert.ok(requests.every((request) => request.url === "/v1/responses"));
    assert.ok(requests.every((request) => request.authorization === "Bearer ocx-test-data-key"));

    requests.length = 0;
    const service = {
      db,
      models: registry,
      computer: {},
      files: {},
      workspace: {},
      browser: {},
    } as unknown as AgentService;
    const conversation = new ConversationAgent(
      config,
      service,
      "owner",
      "opencodex/provider/alpha",
    );
    const run = (modelId?: string) =>
      new Promise<void>((resolve, reject) => {
        const input: RunAgentInput = {
          threadId: "thread",
          runId: `run-${modelId ?? "default"}`,
          messages: [{ id: "user", role: "user", content: "Which route?" }],
          state: {},
          tools: [],
          context: [],
          forwardedProps: modelId ? { modelId } : {},
        };
        conversation.run(input).subscribe({
          next: (event) => {
            if (event.type === EventType.RUN_ERROR)
              reject(new Error("message" in event ? String(event.message) : "run failed"));
          },
          error: reject,
          complete: resolve,
        });
      });
    await run();
    await run("beta");
    await assert.rejects(run("not-allowed"), /not configured or enabled/);
    assert.deepEqual(
      requests.map((request) => request.body.model),
      ["provider/alpha", "provider/beta"],
    );
  } finally {
    await db.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (previousUrl === undefined) delete process.env.OPENCODEX_BASE_URL;
    else process.env.OPENCODEX_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.OPENCODEX_API_KEY;
    else process.env.OPENCODEX_API_KEY = previousKey;
  }
});
