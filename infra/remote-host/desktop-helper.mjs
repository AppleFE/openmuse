import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createWorkerServer } from "./apps/worker/src/server.js";

// This listener has no host command, jobs or notification extension. Its random
// bearer token is shared only with the already enrolled local Host Agent.
const path = resolve(process.argv[2]);
const config = JSON.parse(await readFile(path, "utf8"));
if (
  typeof config.token !== "string" ||
  config.token.length < 32 ||
  !Number.isInteger(config.port) ||
  config.port < 1024 ||
  config.port > 65535
)
  throw Error("Invalid desktop helper configuration");
const worker = await createWorkerServer({
  token: config.token,
  dataDir: config.dataDir,
  desktop: { python: config.python, driver: config.driver },
  extension: async (_request, pathname, json) => {
    if (pathname === "/capabilities" || pathname.startsWith("/sessions")) return false;
    json(404, { error: { message: "Desktop helper endpoint not found" } });
    return true;
  },
});
worker.server.listen(config.port, "127.0.0.1");
worker.server.on("error", async () => {
  await appendFile(config.log, "Desktop helper could not bind loopback port.\n");
  process.exit(1);
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
