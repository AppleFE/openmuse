import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Config, normalizeOllamaBaseUrl } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ModelRegistry, parseModelCatalog } from "../apps/server/src/engine/models.ts";
import { configuredPiModel } from "../apps/server/src/engine/pi-runtime.ts";

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

test("Pi calls Ollama chat completions with no Authorization header", async () => {
  let requestPath = "";
  let authorization: string | undefined;
  let requestBody = "";
  const server = createServer(async (request, response) => {
    requestPath = request.url ?? "";
    authorization = request.headers.authorization;
    for await (const chunk of request) requestBody += chunk;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finishReason: string | null) =>
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-local",
          object: "chat.completion.chunk",
          created: 1,
          model: "qwen3:4b",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      );
    chunk({ role: "assistant", content: "Local response" }, null);
    chunk({}, "stop");
    response.end("data: [DONE]\n\n");
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
    const response = await runtime.completeSimple(model, {
      systemPrompt: "Answer locally",
      messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
    });
    assert.equal(requestPath, "/v1/chat/completions", JSON.stringify(response));
    assert.equal(authorization, undefined);
    assert.equal(JSON.parse(requestBody).model, "qwen3:4b");
    assert.equal(JSON.parse(requestBody).think, false);
    assert.equal(response.content.find((part) => part.type === "text")?.text, "Local response");
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi registers the same keyless Ollama chat-completions transport", async () => {
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
    assert.equal(model.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(model.contextWindow, 8192);
    assert.equal(model.maxTokens, 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
