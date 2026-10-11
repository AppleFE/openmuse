import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import type { ModelProfile } from "../../../packages/domain/src/agent.ts";
import { validateEncryptionKey } from "../../../packages/integrations/src/vault.ts";
import { parseModelCatalog } from "./engine/models.ts";

/** .env keys whose file value loses to a different value already set in the environment. */
export function shadowedEnvKeys(
  file: Record<string, string | undefined>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.keys(file).filter((key) => env[key] !== undefined && env[key] !== file[key]);
}

if (existsSync(".env")) {
  // loadEnvFile never overrides existing variables. A stale shell or system-wide value
  // (for example OPENAI_API_KEY) would otherwise silently replace the .env setting.
  const shadowed = shadowedEnvKeys(parseEnv(readFileSync(".env", "utf8")));
  process.loadEnvFile(".env");
  if (shadowed.length)
    console.warn(
      `[OpenMuse] Using ${shadowed.join(", ")} from the environment instead of .env. ` +
        (shadowed.length === 1
          ? "Unset it to use the .env value."
          : "Unset them to use the .env values."),
    );
}
process.env.DO_NOT_TRACK ??= "1";
process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true";

export interface Config {
  mode: "sample" | "live";
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  databaseUrl?: string;
  accessKey?: string;
  /** Explicit single-workspace access without a user-entered key. */
  authMode?: "access-key" | "none";
  encryptionKey?: string;
  model?: string;
  /** Static profiles; OpenCodex discovery adds server-authorized profiles without exposing keys. */
  models?: ModelProfile[];
  openCodexBaseUrl?: string;
  openCodexApiKey?: string;
  /** Discover models from the configured OpenCodex data endpoint; defaults to true. */
  openCodexModelDiscovery?: boolean;
  /** Explicit local Ollama origin; no API key is sent. */
  ollamaBaseUrl?: string;
  /** Server-side Jev defaults; owner settings never expose the credential. */
  typesafeApiKey?: string;
  typesafeBaseUrl?: string;
  typesafeModel?: string;
  agentBackend: "sample" | "model" | "agui";
  agentUrl?: string;
  agentToken?: string;
  /** Hard limit for one foreground conversation run. */
  chatRunTimeoutMs?: number;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  /** Installed desktop app: allow importing the user's Google Desktop OAuth client. */
  desktop?: boolean;
  workerUrl?: string;
  workerToken?: string;
  taskWorkerEnabled?: boolean;
  computerEnabled?: boolean;
  computerImage?: string;
  computerDeploymentId?: string;
  allowedOrigins: string[];
}

export function required(name: string, message: string, value = process.env[name]): string {
  if (!value?.trim()) throw new Error(message);
  return value.trim();
}

export function normalizeOllamaBaseUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const url = new URL(value.trim());
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  )
    throw new Error("OLLAMA_BASE_URL must be a loopback HTTP origin without credentials");
  return url.origin;
}

// Provider SDKs retry transient failures before the response starts, with
// exponential backoff: OpenAI and Anthropic retry HTTP 408, 409, 429, 5xx and
// connection errors and honor retry-after; Gemini retries 408, 429, 500, 502,
// 503 and 504. Other 4xx responses such as 400, 401 and 403 fail on the first
// attempt, and a stream that fails after it starts is not retried. External
// writes never re-fire here: they are dispatched outside the model loop through
// reviewed, idempotency-keyed actions.
export const MODEL_MAX_RETRIES = 2;
export function readConfig(): Config {
  const authMode = process.env.OPENMUSE_AUTH_MODE ?? "access-key";
  if (authMode !== "access-key" && authMode !== "none")
    throw new Error("OPENMUSE_AUTH_MODE must be access-key or none");
  const mode = process.env.WORKSPACE_MODE ?? "sample";
  if (mode !== "sample" && mode !== "live")
    throw new Error("WORKSPACE_MODE must be sample or live");
  const backend = process.env.AGENT_BACKEND ?? (mode === "sample" ? "sample" : "model");
  if (backend !== "sample" && backend !== "model" && backend !== "agui")
    throw new Error("AGENT_BACKEND must be sample, model or agui");
  if (mode === "live" && backend === "sample")
    throw new Error("Live workspaces cannot use the sample agent");
  const port = Number(process.env.PORT ?? 8787);
  const publicUrl = process.env.PUBLIC_API_URL ?? `http://localhost:${port}`;
  const model = process.env.MODEL?.trim() || undefined;
  const config: Config = {
    mode,
    port,
    host: process.env.HOST ?? "127.0.0.1",
    publicUrl,
    dataDir: resolve(process.env.DATA_DIR ?? ".openmuse"),
    databaseUrl: process.env.DATABASE_URL,
    accessKey: process.env.OPENMUSE_ACCESS_KEY,
    authMode,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
    model,
    models: parseModelCatalog(process.env.OPENMUSE_MODELS, model),
    openCodexBaseUrl: process.env.OPENCODEX_BASE_URL,
    openCodexApiKey: process.env.OPENCODEX_API_KEY,
    openCodexModelDiscovery: process.env.OPENCODEX_MODEL_DISCOVERY !== "false",
    ollamaBaseUrl: normalizeOllamaBaseUrl(process.env.OLLAMA_BASE_URL),
    typesafeApiKey: process.env.TYPESAFE_API_KEY,
    typesafeBaseUrl: process.env.TYPESAFE_BASE_URL,
    typesafeModel: process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest",
    agentBackend: backend,
    agentUrl: process.env.AGENT_URL,
    agentToken: process.env.AGENT_TOKEN,
    chatRunTimeoutMs: Number(process.env.CHAT_RUN_TIMEOUT_MS ?? 10 * 60 * 1000),
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: `${publicUrl}/api/google/callback`,
    workerUrl: process.env.BROWSER_WORKER_URL,
    workerToken: process.env.WORKER_TOKEN,
    taskWorkerEnabled: process.env.TASK_WORKER_ENABLED !== "false",
    computerEnabled: process.env.COMPUTER_ENABLED === "true",
    computerImage: process.env.COMPUTER_IMAGE ?? "openmuse-computer:local",
    computerDeploymentId: process.env.COMPUTER_DEPLOYMENT_ID,
    allowedOrigins: (
      process.env.ALLOWED_ORIGINS ?? "http://localhost:8081,http://127.0.0.1:8081"
    ).split(","),
  };
  if (authMode !== "none" && config.accessKey && config.accessKey.length < 24)
    throw new Error("OPENMUSE_ACCESS_KEY must contain at least 24 characters");
  if (config.encryptionKey) {
    try {
      validateEncryptionKey(config.encryptionKey);
    } catch {
      throw new Error("TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes as base64");
    }
  }
  if (mode === "live" && ((authMode !== "none" && !config.accessKey) || !config.encryptionKey))
    throw new Error(
      "Live mode requires TOKEN_ENCRYPTION_KEY (32-byte base64) and OPENMUSE_ACCESS_KEY (24+ characters) unless OPENMUSE_AUTH_MODE=none",
    );
  if (mode === "sample" && !["127.0.0.1", "localhost", "::1"].includes(config.host))
    throw new Error("Sample workspace is local-only. HOST must be a loopback address.");
  const chatRunTimeoutMs = config.chatRunTimeoutMs ?? 10 * 60 * 1000;
  if (
    !Number.isFinite(chatRunTimeoutMs) ||
    chatRunTimeoutMs < 1_000 ||
    chatRunTimeoutMs > 60 * 60 * 1000
  )
    throw new Error("CHAT_RUN_TIMEOUT_MS must be between 1000 and 3600000");
  return config;
}
