import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
const path = resolve(process.argv[2] ?? ".host-agent/config.json");
const config = JSON.parse(await readFile(path, "utf8"));
if (
  typeof config.token !== "string" ||
  config.token.length < 32 ||
  typeof config.host !== "string" ||
  !Number.isInteger(config.port) ||
  config.port < 1 ||
  config.port > 65535
)
  throw new Error("Invalid Host Agent configuration");
// Portable build and development checkout use the same config format.
const entry = resolve(directory, "apps/host-agent/src/index.js");
const child = spawn(process.execPath, [entry], {
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    HOST_AGENT_TOKEN: config.token,
    HOST_AGENT_HOST: config.host,
    HOST_AGENT_PORT: String(config.port),
    HOST_AGENT_DATA_DIR: resolve(config.dataDir),
    HOST_AGENT_CONFIG_PATH: path,
    HOST_AGENT_NOTIFY_PORT: String(config.notifyPort ?? 8792),
    ...(config.browserPath ? { PLAYWRIGHT_BROWSERS_PATH: resolve(config.browserPath) } : {}),
  },
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("error", () => {
  console.error("Host Agent could not start");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
