import assert from "node:assert/strict";
import { test } from "node:test";
import { type Config, readConfig, shadowedEnvKeys } from "../apps/server/src/config.ts";

const sampleConfig: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: ".openmuse",
  agentBackend: "sample",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
};

test("API configuration has no CopilotKit cloud-key prerequisite", () => {
  assert.ok(!("intelligenceApiKey" in sampleConfig));
  assert.doesNotThrow(
    () => ({ ...sampleConfig, mode: "live", agentBackend: "model" }) satisfies Config,
  );
});

test("environment variables that override a different .env value are reported by name", () => {
  const file = { OPENAI_API_KEY: "sk-or-file", MODEL: "openai/gpt-5", PORT: "8787", EMPTY: "" };
  const env = { OPENAI_API_KEY: "sk-proj-system", MODEL: "openai/gpt-5", EMPTY: "set" };
  assert.deepEqual(shadowedEnvKeys(file, env), ["OPENAI_API_KEY", "EMPTY"]);
  assert.deepEqual(shadowedEnvKeys(file, {}), []);
});

test("sample-mode startup validates a configured vault key and permits its absence", () => {
  const names = ["WORKSPACE_MODE", "AGENT_BACKEND", "HOST", "TOKEN_ENCRYPTION_KEY"];
  const previous = names.map((name) => process.env[name]);
  try {
    Object.assign(process.env, {
      WORKSPACE_MODE: "sample",
      AGENT_BACKEND: "sample",
      HOST: "127.0.0.1",
      TOKEN_ENCRYPTION_KEY: "a".repeat(64),
    });
    assert.throws(readConfig, /TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes as base64/);
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
    assert.equal(readConfig().encryptionKey, process.env.TOKEN_ENCRYPTION_KEY);
    delete process.env.TOKEN_ENCRYPTION_KEY;
    assert.equal(readConfig().encryptionKey, undefined);
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});
