import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const webRoot = resolve(process.env.WEB_ROOT ?? "apps/mobile/dist/web");
const canonicalWebRoot = await realpath(webRoot);
const hosts = (process.env.WEB_HOSTS ?? "127.0.0.1")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
const port = Number(process.env.WEB_PORT ?? 8081);
const api = new URL(process.env.API_PROXY_URL ?? "http://127.0.0.1:8787");

if (!hosts.length) throw new Error("WEB_HOSTS must contain at least one address");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("WEB_PORT must be an integer from 1 through 65535");
if (!["http:", "https:"].includes(api.protocol) || api.username || api.password)
  throw new Error("API_PROXY_URL must be an HTTP(S) URL without embedded credentials");
if (api.pathname !== "/" || api.search || api.hash)
  throw new Error("API_PROXY_URL must be an origin without a path, query, or fragment");

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const mimeTypes = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function safeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) => value !== undefined && !hopByHopHeaders.has(name),
    ),
  );
}

function proxyApi(clientRequest, clientResponse) {
  const target = new URL(`${api.origin}${clientRequest.url ?? "/api"}`);
  const headers = safeHeaders(clientRequest.headers);
  headers.host = api.host;
  headers["x-forwarded-host"] = clientRequest.headers.host ?? "";
  headers["x-forwarded-proto"] = process.env.PUBLIC_API_URL?.startsWith("https:")
    ? "https"
    : "http";

  const upstream = (api.protocol === "https:" ? httpsRequest : httpRequest)(
    target,
    { method: clientRequest.method, headers },
    (upstreamResponse) => {
      clientResponse.writeHead(
        upstreamResponse.statusCode ?? 502,
        safeHeaders(upstreamResponse.headers),
      );
      upstreamResponse.pipe(clientResponse);
      upstreamResponse.on("aborted", () => clientResponse.destroy());
    },
  );
  upstream.on("error", (error) => {
    if (clientResponse.destroyed) return;
    if (!clientResponse.headersSent) {
      clientResponse.writeHead(502, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      clientResponse.end(JSON.stringify({ error: "OpenMuse API is unavailable" }));
    } else clientResponse.destroy(error);
  });
  clientRequest.on("aborted", () => upstream.destroy());
  clientResponse.on("close", () => {
    if (!clientResponse.writableEnded) upstream.destroy();
  });
  clientRequest.pipe(upstream);
}

function hasTraversal(rawPath) {
  try {
    const decoded = decodeURIComponent(rawPath);
    return decoded.includes("\0") || decoded.split("/").some((part) => part === "..");
  } catch {
    return true;
  }
}

async function staticPath(request) {
  const rawPath = (request.url ?? "/").split("?", 1)[0];
  if (hasTraversal(rawPath)) return { status: 403 };
  const decoded = decodeURIComponent(rawPath);
  const candidate = resolve(webRoot, `.${decoded}`);
  const child = relative(webRoot, candidate);
  if (
    child.startsWith(`..${sep}`) ||
    child === ".." ||
    resolve(candidate) === resolve(webRoot, "..")
  )
    return { status: 403 };
  try {
    const metadata = await stat(candidate);
    if (metadata.isFile()) {
      const canonical = await realpath(candidate);
      const canonicalChild = relative(canonicalWebRoot, canonical);
      if (
        canonicalChild === ".." ||
        canonicalChild.startsWith(`..${sep}`) ||
        isAbsolute(canonicalChild)
      )
        return { status: 403 };
      return { path: canonical, metadata };
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const acceptsHtml = (request.headers.accept ?? "")
    .split(",")
    .some((value) => ["text/html", "*/*"].includes(value.split(";", 1)[0].trim()));
  if (request.method !== "GET" && request.method !== "HEAD") return { status: 405 };
  if (!acceptsHtml || extname(decoded)) return { status: 404 };
  const indexPath = resolve(webRoot, "index.html");
  try {
    const canonical = await realpath(indexPath);
    const canonicalChild = relative(canonicalWebRoot, canonical);
    if (
      canonicalChild === ".." ||
      canonicalChild.startsWith(`..${sep}`) ||
      isAbsolute(canonicalChild)
    )
      return { status: 403 };
    return { path: canonical, metadata: await stat(canonical) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { status: 503 };
    throw error;
  }
}

async function handle(request, response) {
  const requestTarget = request.url ?? "/";
  if (!requestTarget.startsWith("/") || requestTarget.startsWith("//")) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Invalid request target");
    return;
  }
  const url = new URL(requestTarget, "http://openmuse.invalid");
  if (url.pathname === "/healthz") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end('{"status":"ok"}');
    return;
  }
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    proxyApi(request, response);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }
  const result = await staticPath(request);
  if (!result.path || !result.metadata) {
    response.writeHead(result.status ?? 500, { "content-type": "text/plain; charset=utf-8" });
    response.end(result.status === 503 ? "OpenMuse web build is unavailable" : "Not found");
    return;
  }
  const immutable = result.path.includes(`${sep}_expo${sep}static${sep}`);
  response.writeHead(200, {
    "content-type": mimeTypes.get(extname(result.path).toLowerCase()) ?? "application/octet-stream",
    "content-length": result.metadata.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(result.path).pipe(response);
}

const servers = [];
try {
  for (const host of hosts) {
    const server = createServer((request, response) => {
      void handle(request, response).catch((error) => {
        console.error(error);
        if (!response.headersSent)
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        if (!response.destroyed) response.end("Internal server error");
      });
    });
    server.headersTimeout = 15_000;
    server.requestTimeout = 0;
    server.keepAliveTimeout = 5_000;
    server.maxRequestsPerSocket = 500;
    await new Promise((resolveListening, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolveListening();
      });
    });
    servers.push(server);
    console.log(`OpenMuse web ready at http://${host}:${port}`);
  }
} catch (error) {
  for (const server of servers) server.close();
  throw error;
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const server of servers) server.closeAllConnections();
  await Promise.all(
    servers.map((server) => new Promise((resolveClose) => server.close(resolveClose))),
  );
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
