import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs, parseEnv } from "node:util";

const { values } = parseArgs({
  options: {
    env: { type: "string", default: ".env" },
    root: { type: "string", default: "/Volumes/p41-1tb/openmuse" },
    "infrastructure-only": { type: "boolean", default: false },
  },
});
const deploymentRoot = resolve(values.root);
const canonicalDeploymentRoot = realpathSync(deploymentRoot);
let env;
try {
  env = parseEnv(readFileSync(values.env, "utf8"));
} catch (error) {
  console.error(
    `ERROR: could not read ${values.env}: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
}

const errors = [];
const credentialErrors = [];
const warnings = [];
const requiredInto = (target, name, minimum = 1) => {
  const value = env[name]?.trim() ?? "";
  if (value.length < minimum || /^REQUIRED(?:_|$)/.test(value))
    target.push(
      `${name} must be present${minimum > 1 ? ` and at least ${minimum} characters` : ""}`,
    );
  return value;
};
const required = (name, minimum = 1) => requiredInto(errors, name, minimum);
const requiredCredential = (name, minimum = 1) => requiredInto(credentialErrors, name, minimum);
const optional = (name) => env[name]?.trim() ?? "";
const canonicalDestination = (path) => {
  let existing = resolve(path);
  const remainder = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`no existing ancestor for ${path}`);
    remainder.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...remainder);
};
const withinRoot = (name) => {
  const value = required(name);
  if (!value || !isAbsolute(value)) {
    if (value) errors.push(`${name} must be an absolute path`);
    return;
  }
  let destination;
  try {
    destination = canonicalDestination(value);
  } catch {
    errors.push(`${name} could not be resolved safely`);
    return;
  }
  const child = relative(canonicalDeploymentRoot, destination);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    errors.push(`${name} must stay under the deployment root`);
};
const url = (name) => {
  const value = required(name);
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new Error("must use HTTP(S) and contain no credentials");
    return parsed;
  } catch {
    errors.push(`${name} must be a valid credential-free HTTP(S) URL`);
    return undefined;
  }
};

const mode = required("WORKSPACE_MODE");
if (mode && !["sample", "live"].includes(mode))
  errors.push("WORKSPACE_MODE must be sample or live");
if (required("AGENT_BACKEND") !== "model")
  errors.push("AGENT_BACKEND must be model for this deployment");
if (required("HOST") !== "127.0.0.1")
  errors.push("HOST must remain 127.0.0.1 behind the web proxy");
if (optional("PORT") !== "8787") errors.push("PORT must be 8787 for the launchd wiring");
if (optional("NODE_ENV") !== "production") errors.push("NODE_ENV must be production");
if (optional("TASK_WORKER_ENABLED") !== "true")
  errors.push("TASK_WORKER_ENABLED must be true so the API owns the embedded PGlite task worker");
if (optional("DATABASE_URL"))
  errors.push("DATABASE_URL must be unset for the single-process PGlite deployment");

const authMode = optional("OPENMUSE_AUTH_MODE") || "access-key";
if (!["access-key", "none"].includes(authMode))
  errors.push("OPENMUSE_AUTH_MODE must be access-key or none");
if (authMode !== "none") requiredCredential("OPENMUSE_ACCESS_KEY", 24);
{
  const encryptionKey =
    mode === "live" ? requiredCredential("TOKEN_ENCRYPTION_KEY") : optional("TOKEN_ENCRYPTION_KEY");
  const decoded = Buffer.from(encryptionKey, "base64");
  if (encryptionKey && (decoded.length !== 32 || decoded.toString("base64") !== encryptionKey))
    credentialErrors.push("TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes as base64");
}

const publicUrl = url("PUBLIC_API_URL");
const webApiUrl = url("EXPO_PUBLIC_API_URL");
if (publicUrl && (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash))
  errors.push("PUBLIC_API_URL must be an origin without a path, query, or fragment");
if (webApiUrl && (webApiUrl.pathname !== "/" || webApiUrl.search || webApiUrl.hash))
  errors.push("EXPO_PUBLIC_API_URL must be an origin without a path, query, or fragment");
if (webApiUrl && webApiUrl.origin !== publicUrl?.origin)
  errors.push("EXPO_PUBLIC_API_URL must match PUBLIC_API_URL for same-origin web access");
const origins = optional("ALLOWED_ORIGINS")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
if (publicUrl && !origins.includes(publicUrl.origin))
  errors.push("ALLOWED_ORIGINS must include the PUBLIC_API_URL origin");

withinRoot("DATA_DIR");
withinRoot("WORKER_DATA_DIR");
withinRoot("PLAYWRIGHT_BROWSERS_PATH");
withinRoot("WEB_ROOT");
const browserWorkerUrl = url("BROWSER_WORKER_URL");
if (
  browserWorkerUrl?.origin !== "http://127.0.0.1:8790" ||
  browserWorkerUrl.pathname !== "/" ||
  browserWorkerUrl.search ||
  browserWorkerUrl.hash
)
  errors.push("BROWSER_WORKER_URL must be http://127.0.0.1:8790");
required("WORKER_TOKEN", 32);
const proxyUrl = url("API_PROXY_URL");
if (proxyUrl?.origin !== "http://127.0.0.1:8787" || proxyUrl.pathname !== "/")
  errors.push("API_PROXY_URL must be http://127.0.0.1:8787");
if (optional("WEB_PORT") !== "8081") errors.push("WEB_PORT must be 8081 for the launchd wiring");
const webHosts = optional("WEB_HOSTS")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
if (!webHosts.includes("127.0.0.1"))
  errors.push("WEB_HOSTS must include 127.0.0.1 for local health checks");
const isTailnetV4 = (host) => {
  const octets = host.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false;
  const numbers = octets.map(Number);
  return (
    numbers[0] === 100 && numbers[1] >= 64 && numbers[1] <= 127 && numbers.every((n) => n <= 255)
  );
};
if (webHosts.some((host) => host !== "127.0.0.1" && !isTailnetV4(host)))
  errors.push("WEB_HOSTS may contain only 127.0.0.1 and specific Tailnet IPv4 addresses");

let models = [];
const catalog = optional("OPENMUSE_MODELS");
if (catalog) {
  try {
    const parsed = JSON.parse(catalog);
    if (!Array.isArray(parsed)) throw new Error();
    models = parsed
      .filter((entry) => entry && typeof entry === "object" && entry.enabled !== false)
      .map((entry) => entry.model)
      .filter((model) => typeof model === "string" && model.trim());
    if (!models.length)
      credentialErrors.push("OPENMUSE_MODELS must contain at least one enabled model");
  } catch {
    credentialErrors.push("OPENMUSE_MODELS must be a valid JSON array");
  }
} else if (optional("MODEL")) models = [optional("MODEL")];
else credentialErrors.push("MODEL or OPENMUSE_MODELS must configure at least one model");

const providers = new Set(models.map((model) => model.split(/[/:]/, 1)[0]?.toLowerCase()));
for (const provider of providers) {
  if (provider === "ollama") {
    const ollamaUrl = url("OLLAMA_BASE_URL");
    if (
      ollamaUrl &&
      (ollamaUrl.protocol !== "http:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(ollamaUrl.hostname) ||
        !["", "/"].includes(ollamaUrl.pathname) ||
        ollamaUrl.search ||
        ollamaUrl.hash)
    )
      errors.push(
        "OLLAMA_BASE_URL must be a loopback HTTP origin without a path, query, or fragment",
      );
  } else if (provider === "openai") requiredCredential("OPENAI_API_KEY");
  else if (provider === "anthropic") requiredCredential("ANTHROPIC_API_KEY");
  else if (provider === "google") {
    if (
      !["GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"].some((name) =>
        optional(name),
      )
    )
      credentialErrors.push(
        "a Google model requires GOOGLE_API_KEY, GEMINI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY",
      );
  } else if (provider === "opencodex") {
    if (optional("OPENCODEX_BASE_URL")) url("OPENCODEX_BASE_URL");
    else credentialErrors.push("OPENCODEX_BASE_URL must be present");
    requiredCredential("OPENCODEX_API_KEY");
  } else if (provider) credentialErrors.push(`unsupported model provider ${provider}`);
}

if (optional("COMPUTER_ENABLED") === "true") {
  required("COMPUTER_IMAGE");
  required("COMPUTER_DEPLOYMENT_ID");
  required("DOCKER_CONTEXT");
} else if (optional("COMPUTER_ENABLED") !== "false")
  errors.push("COMPUTER_ENABLED must be true or false");

if (authMode !== "none" && mode === "sample" && !optional("OPENMUSE_ACCESS_KEY"))
  credentialErrors.push("the proxied sample workspace must set OPENMUSE_ACCESS_KEY");
if (mode === "sample" && webHosts.length === 1 && webHosts[0] === "127.0.0.1")
  warnings.push(
    "WEB_HOSTS is loopback-only; use an SSH tunnel or add the specific Tailnet address",
  );

for (const warning of warnings) console.warn(`WARNING: ${warning}`);
if (values["infrastructure-only"] && credentialErrors.length) {
  for (const error of credentialErrors) console.warn(`API BLOCKED: ${error}`);
  console.warn("API launch remains disabled until every API configuration issue is resolved.");
} else errors.push(...credentialErrors);
for (const error of errors) console.error(`ERROR: ${error}`);
if (errors.length) {
  console.error(
    `Configuration invalid (${errors.length} issue${errors.length === 1 ? "" : "s"}); no secret values were printed.`,
  );
  process.exit(1);
}
console.log(
  credentialErrors.length
    ? "Infrastructure configuration valid; API configuration remains blocked and no secret values were printed."
    : "Configuration valid; no secret values were printed.",
);
