import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("serve-web.mjs", import.meta.url));
let api;
let proxy;
let root;
let apiPort;
let proxyPort;
let outsideRoot;
const requests = [];
let cancelled;

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "openmuse-web-"));
  await mkdir(join(root, "_expo", "static"), { recursive: true });
  await writeFile(join(root, "index.html"), "<h1>OpenMuse</h1>");
  await writeFile(join(root, "_expo", "static", "app.js"), "export default 1;");
  outsideRoot = await mkdtemp(join(tmpdir(), "openmuse-web-outside-"));
  await writeFile(join(outsideRoot, "leak.txt"), "must not be served");
  await symlink(
    outsideRoot,
    join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  api = createServer((request, response) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      origin: request.headers.origin,
    });
    if (request.url === "/api/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      setTimeout(() => response.end("data: second\n\n"), 60);
      return;
    }
    if (request.url === "/api/cancel") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: started\n\n");
      const timer = setInterval(() => response.write("data: waiting\n\n"), 20);
      request.on("close", () => {
        clearInterval(timer);
        cancelled?.();
      });
      return;
    }
    if (request.url === "/api/private" && !request.headers.authorization) {
      response.writeHead(401);
      response.end("owner key required");
      return;
    }
    if (request.headers.origin === "https://denied.example") {
      response.writeHead(403);
      response.end("denied");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ url: request.url }));
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  apiPort = address.port;
  proxyPort = await freePort();
  proxy = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      WEB_ROOT: root,
      WEB_HOSTS: "127.0.0.1",
      WEB_PORT: String(proxyPort),
      API_PROXY_URL: `http://127.0.0.1:${apiPort}`,
      PUBLIC_API_URL: `http://127.0.0.1:${proxyPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proxy.stdout.on("data", (chunk) => (output += chunk));
  await Promise.race([
    new Promise((resolve) => {
      const poll = setInterval(() => {
        if (output.includes("OpenMuse web ready")) {
          clearInterval(poll);
          resolve();
        }
      }, 10);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("proxy did not start")), 5000)),
  ]);
});

after(async () => {
  if (proxy) {
    proxy.kill("SIGTERM");
    await once(proxy, "exit");
  }
  if (api) {
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
});

test("serves exported assets, SPA routes, and health with safe cache policy", async () => {
  const index = await fetch(`http://127.0.0.1:${proxyPort}/`);
  assert.equal(index.status, 200);
  assert.equal(index.headers.get("cache-control"), "no-cache");
  assert.match(await index.text(), /OpenMuse/);
  const asset = await fetch(`http://127.0.0.1:${proxyPort}/_expo/static/app.js`);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
  const route = await fetch(`http://127.0.0.1:${proxyPort}/workspace/thread/1`, {
    headers: { accept: "text/html" },
  });
  assert.match(await route.text(), /OpenMuse/);
  assert.equal((await fetch(`http://127.0.0.1:${proxyPort}/missing.js`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${proxyPort}/linked/leak.txt`)).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${proxyPort}/healthz`)).status, 200);
});

test("rejects encoded traversal and non-API writes", async () => {
  const traversal = await new Promise((resolve, reject) => {
    const request = get(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path: "/%2e%2e/secret",
        headers: { accept: "text/plain" },
      },
      resolve,
    );
    request.on("error", reject);
  });
  assert.equal(traversal.statusCode, 403);
  const authorityTarget = await new Promise((resolve, reject) => {
    const request = get(
      { host: "127.0.0.1", port: proxyPort, path: "//untrusted.example/api/private" },
      resolve,
    );
    request.on("error", reject);
  });
  assert.equal(authorityTarget.statusCode, 400);
  assert.equal(
    (await fetch(`http://127.0.0.1:${proxyPort}/upload`, { method: "POST" })).status,
    405,
  );
});

test("preserves authorization, origin, signed query strings, and upstream status", async () => {
  const signed = "/api/files/report?owner=local-user&expires=123&signature=abc";
  const response = await fetch(`http://127.0.0.1:${proxyPort}${signed}`, {
    headers: { authorization: "Bearer test-session", origin: "http://127.0.0.1:8081" },
  });
  assert.equal(response.status, 200);
  assert.equal(requests.at(-1).url, signed);
  assert.equal(requests.at(-1).authorization, "Bearer test-session");
  assert.equal(requests.at(-1).origin, "http://127.0.0.1:8081");
  assert.equal((await fetch(`http://127.0.0.1:${proxyPort}/api/private`)).status, 401);
  const denied = await fetch(`http://127.0.0.1:${proxyPort}/api/workspace`, {
    headers: { origin: "https://denied.example" },
  });
  assert.equal(denied.status, 403);
});

test("streams SSE without buffering and cancels upstream work when the client leaves", async () => {
  const response = await fetch(`http://127.0.0.1:${proxyPort}/api/stream`);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /first/);
  const second = new TextDecoder().decode((await reader.read()).value);
  assert.match(second, /second/);

  const cancelledPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("upstream request was not cancelled")), 2000);
    cancelled = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
  await new Promise((resolve, reject) => {
    const request = get(`http://127.0.0.1:${proxyPort}/api/cancel`, (stream) => {
      stream.once("data", () => {
        stream.destroy();
        resolve();
      });
    });
    request.on("error", reject);
  });
  await cancelledPromise;
});
