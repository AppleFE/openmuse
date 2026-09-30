import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { type Config, normalizeOllamaBaseUrl } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { JevRuntime } from "../apps/server/src/engine/jev-runtime.ts";
import { RuntimeSettingsService } from "../apps/server/src/engine/jev-settings.ts";
import { ModelRegistry, parseModelCatalog } from "../apps/server/src/engine/models.ts";
import { PiAgentRunner } from "../apps/server/src/engine/pi-agent.ts";
import { configuredPiModel } from "../apps/server/src/engine/pi-runtime.ts";
import type { AgentTask, ModelProfile } from "../packages/domain/src/agent.ts";

const ollamaConfig = (dataDir: string, ollamaBaseUrl: string): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "model",
  ollamaBaseUrl,
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
});

const ollamaProfile: ModelProfile = {
  id: "local-coder",
  label: "Local coder",
  provider: "ollama",
  model: "ollama/qwen3:4b",
  capabilities: ["chat", "coding", "tools"],
  enabled: true,
  available: true,
};

const agentTask = (): AgentTask => {
  const now = new Date().toISOString();
  return {
    id: "ollama-native-task",
    title: "Native tool continuation",
    prompt: "Use multiply once",
    kind: "agent",
    status: "running",
    modelId: ollamaProfile.id,
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
};

test("Ollama configuration accepts only explicit keyless loopback origins", () => {
  assert.equal(normalizeOllamaBaseUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(normalizeOllamaBaseUrl("http://localhost:11434/"), "http://localhost:11434");
  for (const value of [
    "https://127.0.0.1:11434",
    "http://ollama.example:11434",
    "http://user:secret@127.0.0.1:11434",
    "http://127.0.0.1:11434/api",
  ])
    assert.throws(() => normalizeOllamaBaseUrl(value), /loopback HTTP origin/);
});

test("the model catalog exposes configured Ollama without requiring credentials", async () => {
  const profiles = parseModelCatalog(undefined, "ollama/qwen3:4b");
  assert.equal(profiles[0]?.provider, "ollama");
  const db = await createStore();
  try {
    const registry = new ModelRegistry(db, {
      mode: "sample",
      port: 8787,
      host: "127.0.0.1",
      publicUrl: "http://localhost:8787",
      dataDir: ".openmuse",
      agentBackend: "model",
      model: "ollama/qwen3:4b",
      models: profiles,
      ollamaBaseUrl: "http://127.0.0.1:11434",
      googleRedirectUri: "http://localhost:8787/api/google/callback",
      allowedOrigins: ["http://localhost:8081"],
    });
    assert.equal(registry.list()[0]?.available, true);
    assert.equal(registry.require("default").model, "ollama/qwen3:4b");
  } finally {
    await db.close();
  }
});

test("Pi calls native Ollama chat with bounded non-thinking settings and no Authorization header", async () => {
  let requestPath = "";
  let authorization: string | undefined;
  let requestBody = "";
  const server = createServer(async (request, response) => {
    requestPath = request.url ?? "";
    authorization = request.headers.authorization;
    for await (const chunk of request) requestBody += chunk;
    response.writeHead(200, { "Content-Type": "application/x-ndjson" });
    response.write(
      `${JSON.stringify({
        model: "qwen3:4b",
        message: {
          role: "assistant",
          content: "Local response",
        },
        done: false,
      })}\n`,
    );
    response.end(
      `${JSON.stringify({
        model: "qwen3:4b",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "length",
        prompt_eval_count: 12,
        eval_count: 3,
      })}\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(join(tmpdir(), "openmuse-ollama-call-"));
  try {
    const { runtime, model } = await configuredPiModel(
      {
        mode: "sample",
        port: 8787,
        host: "127.0.0.1",
        publicUrl: "http://localhost:8787",
        dataDir: root,
        agentBackend: "model",
        ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
        googleRedirectUri: "http://localhost:8787/api/google/callback",
        allowedOrigins: ["http://localhost:8081"],
      },
      root,
      "ollama/qwen3:4b",
    );
    const response = await runtime.completeSimple(
      model,
      {
        systemPrompt: "Answer locally",
        messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
      },
      { maxTokens: 4096 },
    );
    assert.equal(requestPath, "/api/chat", JSON.stringify(response));
    assert.equal(authorization, undefined);
    assert.equal(JSON.parse(requestBody).model, "qwen3:4b");
    assert.equal(JSON.parse(requestBody).think, false);
    assert.deepEqual(JSON.parse(requestBody).options, { num_ctx: 8192, num_predict: 1024 });
    assert.equal(response.content.find((part) => part.type === "text")?.text, "Local response");
    assert.equal(response.stopReason, "length");
    assert.equal(response.usage.input, 12);
    assert.equal(response.usage.output, 3);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi registers the same keyless Ollama native chat transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-ollama-pi-"));
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: root,
    agentBackend: "model",
    ollamaBaseUrl: "http://127.0.0.1:11434",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  try {
    const { model } = await configuredPiModel(config, root, "ollama/qwen3:4b");
    assert.equal(model.id, "qwen3:4b");
    assert.equal(model.api, "openai-completions");
    assert.equal(model.baseUrl, "http://127.0.0.1:11434");
    assert.equal(model.contextWindow, 8192);
    assert.equal(model.maxTokens, 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real embedded Pi handles fragmented native Ollama tool continuation and final completion", async () => {
  const requests: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
  const writeFragmented = async (response: import("node:http").ServerResponse, value: object) => {
    const line = `${JSON.stringify(value)}\n`;
    const cuts = [7, Math.max(8, Math.floor(line.length / 2)), line.length];
    let offset = 0;
    for (const cut of cuts) {
      response.write(line.slice(offset, cut));
      offset = cut;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
    });
    response.writeHead(200, { "Content-Type": "application/x-ndjson" });
    if (requests.length === 1) {
      await writeFragmented(response, {
        model: "qwen3:4b",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "multiply", arguments: { a: 17, b: 23 } } }],
        },
        done: false,
      });
      await writeFragmented(response, {
        model: "qwen3:4b",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 20,
        eval_count: 8,
      });
    } else if (requests.length === 2) {
      await writeFragmented(response, {
        model: "qwen3:4b",
        message: { role: "assistant", content: "Native tool result is 391." },
        done: false,
      });
      await writeFragmented(response, {
        model: "qwen3:4b",
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 32,
        eval_count: 7,
      });
    } else {
      response.writeHead(500).end();
      return;
    }
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const root = await mkdtemp(join(tmpdir(), "openmuse-ollama-native-loop-"));
  const config = ollamaConfig(root, `http://127.0.0.1:${address.port}`);
  const db = await createStore({ dataDir: join(root, "db") });
  let executions = 0;
  try {
    const runner = new PiAgentRunner(
      db,
      config,
      new JevRuntime(new RuntimeSettingsService(db, config)),
    );
    const task = agentTask();
    const output = await runner.run({
      owner: "owner",
      profile: ollamaProfile,
      request: {
        owner: "owner",
        task,
        role: {
          id: "agent",
          label: "Agent",
          kind: "coder",
          modelId: ollamaProfile.id,
          systemPrompt: "Use reviewed tools only",
          dependsOn: [],
        },
        model: ollamaProfile.model,
        capabilities: ollamaProfile.capabilities,
        dependencyContext: {},
        signal: new AbortController().signal,
      },
      sessionKey: `task:${task.id}`,
      runKey: `task:${task.id}:first`,
      systemPrompt: "Use reviewed tools only",
      prompt: "Call multiply with 17 and 23, then report the observed result.",
      tools: [
        defineTool({
          name: "multiply",
          description: "Multiply two integers",
          parameters: z.object({ a: z.number().int(), b: z.number().int() }),
          execute: async ({ a, b }) => {
            executions += 1;
            return { product: a * b };
          },
        }),
      ],
    });
    assert.match(output, /391/);
    assert.equal(executions, 1);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.authorization === undefined));
    const secondMessages = requests[1]?.body.messages as Array<Record<string, unknown>>;
    assert.ok(secondMessages.some((message) => message.role === "assistant" && message.tool_calls));
    assert.ok(
      secondMessages.some(
        (message) =>
          message.role === "tool" &&
          message.tool_name === "multiply" &&
          /391/.test(String(message.content)),
      ),
    );
  } finally {
    await db.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("native Ollama transport reports upstream errors and closes timed-out streams", async () => {
  let calls = 0;
  let closed!: () => void;
  const responseClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer(async (_request, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(503, { "Content-Type": "text/plain" });
      response.end("temporarily unavailable");
      return;
    }
    if (calls === 2) {
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      response.end(`${JSON.stringify({ error: "model runner stopped" })}\n`);
      return;
    }
    if (calls === 3) {
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      response.end(
        `${JSON.stringify({
          model: "qwen3:4b",
          message: { role: "assistant", content: "partial but incomplete" },
          done: false,
        })}\n`,
      );
      return;
    }
    response.on("close", closed);
    response.writeHead(200, { "Content-Type": "application/x-ndjson" });
    response.write(
      `${JSON.stringify({
        model: "qwen3:4b",
        message: { role: "assistant", content: "partial" },
        done: false,
      })}\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const root = await mkdtemp(join(tmpdir(), "openmuse-ollama-native-errors-"));
  try {
    const { runtime, model } = await configuredPiModel(
      ollamaConfig(root, `http://127.0.0.1:${address.port}`),
      root,
      ollamaProfile.model,
    );
    const context = {
      systemPrompt: "Answer locally",
      messages: [{ role: "user" as const, content: "Hello", timestamp: Date.now() }],
    };
    const upstream = await runtime.completeSimple(model, context);
    assert.equal(upstream.stopReason, "error");
    assert.match(upstream.errorMessage ?? "", /HTTP 503/);
    const streamError = await runtime.completeSimple(model, context);
    assert.equal(streamError.stopReason, "error");
    assert.match(streamError.errorMessage ?? "", /Ollama stream error/);
    const incomplete = await runtime.completeSimple(model, context);
    assert.equal(incomplete.stopReason, "error");
    assert.match(incomplete.errorMessage ?? "", /final done marker/);
    const timedOut = await runtime.completeSimple(model, context, {
      signal: AbortSignal.timeout(50),
    });
    assert.equal(timedOut.stopReason, "aborted");
    await Promise.race([
      responseClosed,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Timed-out Ollama response was not closed")), 1000),
      ),
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
