import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("validate-env.mjs", import.meta.url));
let root;
let envFile;
let outside;
const secret = "test-secret-that-must-not-appear";

function config(overrides = {}) {
  const values = {
    WORKSPACE_MODE: "sample",
    AGENT_BACKEND: "model",
    NODE_ENV: "production",
    PORT: "8787",
    HOST: "127.0.0.1",
    PUBLIC_API_URL: "http://100.80.94.16:8081",
    EXPO_PUBLIC_API_URL: "http://100.80.94.16:8081",
    ALLOWED_ORIGINS: "http://100.80.94.16:8081",
    DATA_DIR: join(root, "data", "app"),
    TASK_WORKER_ENABLED: "true",
    CPK_INTELLIGENCE_API_KEY: secret,
    OPENMUSE_ACCESS_KEY: "sample-owner-access-key-123456",
    MODEL: "openai/test-model",
    OPENAI_API_KEY: secret,
    BROWSER_WORKER_URL: "http://127.0.0.1:8790",
    WORKER_TOKEN: "worker-token-at-least-32-characters-long",
    WORKER_DATA_DIR: join(root, "data", "browser-profiles"),
    PLAYWRIGHT_BROWSERS_PATH: join(root, "caches", "playwright"),
    WEB_HOSTS: "127.0.0.1,100.80.94.16",
    WEB_PORT: "8081",
    WEB_ROOT: join(root, "repo", "apps", "mobile", "dist", "web"),
    API_PROXY_URL: "http://127.0.0.1:8787",
    COMPUTER_ENABLED: "false",
    ...overrides,
  };
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}

function validate(...extra) {
  return spawnSync(process.execPath, [script, "--env", envFile, "--root", root, ...extra], {
    encoding: "utf8",
  });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "openmuse-env-"));
  outside = await mkdtemp(join(tmpdir(), "openmuse-outside-"));
  envFile = join(root, ".env");
});
after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("accepts the private sample/model deployment without printing credentials", async () => {
  await writeFile(envFile, config());
  const result = validate();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Configuration valid/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
});

test("permits infrastructure preparation but explicitly blocks an uncredentialed API", async () => {
  await writeFile(
    envFile,
    config({ CPK_INTELLIGENCE_API_KEY: undefined, OPENAI_API_KEY: undefined }),
  );
  const result = validate("--infrastructure-only");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /API BLOCKED: CPK_INTELLIGENCE_API_KEY/);
  assert.match(result.stderr, /API BLOCKED: OPENAI_API_KEY/);
  assert.match(result.stdout, /Infrastructure configuration valid/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
});

test("rejects deployment paths that escape through an existing symlink", async () => {
  const link = join(root, "data-link");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  await writeFile(envFile, config({ DATA_DIR: join(link, "app") }));
  const result = validate();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATA_DIR must stay under the deployment root/);
});

test("names missing credentials and unsafe exposure without echoing other values", async () => {
  await writeFile(
    envFile,
    config({
      CPK_INTELLIGENCE_API_KEY: undefined,
      OPENMUSE_ACCESS_KEY: undefined,
      WEB_HOSTS: "0.0.0.0",
    }),
  );
  const result = validate();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CPK_INTELLIGENCE_API_KEY/);
  assert.match(result.stderr, /OPENMUSE_ACCESS_KEY/);
  assert.match(result.stderr, /specific Tailnet IPv4/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
});
