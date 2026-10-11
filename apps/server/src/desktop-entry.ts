import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createWorkerServer } from "../../worker/src/server.ts";
import { createApp } from "./app.ts";
import { attachBrowserStreams } from "./browser-stream.ts";
import type { Config } from "./config.ts";
import { createStore } from "./db.ts";
import { listenDesktop } from "./desktop-listener.ts";

// Electron's utility process runs this entry with a clean environment and an isolated cwd.
const parent = (
  process as unknown as {
    parentPort: {
      once(name: string, fn: (event: { data: Bootstrap }) => void): void;
      postMessage(data: unknown): void;
    };
  }
).parentPort;
interface Bootstrap {
  dataDir: string;
  webRoot: string;
  accessKey: string;
  encryptionKey: string;
  gatewayUrl: string;
  gatewayKey: string;
}
const options = await new Promise<Bootstrap>((resolve) =>
  parent.once("message", (event) => resolve(event.data)),
);
let handler: ReturnType<typeof getRequestListener> | undefined;
const server: Server = createServer((req, res) => {
  if (handler) handler(req, res);
  else res.writeHead(503).end();
});
const publicUrl = await listenDesktop(server, options.dataDir);
const address = server.address();
if (!address || typeof address === "string") throw new Error("Local server could not start");
const workerToken = randomBytes(32).toString("hex");
const worker = await createWorkerServer({
  token: workerToken,
  dataDir: `${options.dataDir}/browser-profiles`,
  desktop: {},
});
await new Promise<void>((resolve, reject) => {
  worker.server.once("error", reject);
  worker.server.listen(0, "127.0.0.1", () => {
    worker.server.removeListener("error", reject);
    resolve();
  });
});
const workerAddress = worker.server.address();
if (!workerAddress || typeof workerAddress === "string")
  throw new Error("Browser worker could not start");
const config: Config = {
  mode: "live",
  host: "127.0.0.1",
  port: address.port,
  publicUrl,
  dataDir: options.dataDir,
  accessKey: options.accessKey,
  authMode: "access-key",
  encryptionKey: options.encryptionKey,
  models: [],
  openCodexBaseUrl: options.gatewayUrl,
  openCodexApiKey: options.gatewayKey,
  openCodexModelDiscovery: true,
  agentBackend: "model",
  taskWorkerEnabled: true,
  computerEnabled: false,
  desktop: true,
  workerUrl: `http://127.0.0.1:${workerAddress.port}`,
  workerToken,
  googleRedirectUri: `${publicUrl}/api/google/callback`,
  allowedOrigins: [publicUrl],
};
const db = await createStore({ dataDir: `${config.dataDir}/postgres` });
await db.recoverInterruptedActions();
const runtime = await createApp(db, config);
const app = new Hono();
app.use("*", async (c, next) => {
  if (c.req.header("host") !== new URL(publicUrl).host) return c.text("Invalid host", 403);
  const origin = c.req.header("origin");
  if (origin && origin !== publicUrl) return c.text("Invalid origin", 403);
  return next();
});
// Preserve the API's absolute route paths (including signed attachments and noVNC).
app.all("/api/*", (c) => runtime.app.fetch(c.req.raw));
app.get("/health", (c) => runtime.app.fetch(c.req.raw));
app.use("*", serveStatic({ root: options.webRoot }));
app.get("*", serveStatic({ path: `${options.webRoot}/index.html` }));
handler = getRequestListener(app.fetch);
const streams = attachBrowserStreams(server, runtime.auth, runtime.browser);
runtime.agent.models.discovery.start();
runtime.agent.start();
parent.postMessage({ ready: true, url: publicUrl });
let closing = false;
parent.once("message", () => {
  void shutdown();
});
async function shutdown() {
  if (closing) return;
  closing = true;
  runtime.hostEvents.close();
  streams.close();
  server.close();
  await runtime.agent.stop();
  await worker.close();
  await db.close();
  process.exit(0);
}
