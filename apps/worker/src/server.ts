import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { createBrowserManager, validateSessionId } from "./browser.ts";
import { createDesktopManager, type DesktopOptions } from "./desktop.ts";
import { WorkerError } from "./errors.ts";

export async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new WorkerError("INVALID_BODY", "A JSON request body is required.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 64 * 1024)
      throw new WorkerError("BODY_TOO_LARGE", "Request body exceeds 64 KiB.", 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Invalid object");
    return result as Record<string, unknown>;
  } catch {
    throw new WorkerError("INVALID_BODY", "A JSON object is required.");
  }
}

function requiredUrl(body: Record<string, unknown>): string {
  if (typeof body.url !== "string" || body.url.length > 8192)
    throw new WorkerError("INVALID_URL", "A URL of at most 8192 characters is required.");
  return body.url;
}

export async function createWorkerServer(options: {
  token: string;
  dataDir: string;
  maxSessions?: number;
  idleTimeoutMs?: number;
  desktop?: DesktopOptions;
  /** Optional authenticated extension, used by the portable Host Agent. */
  extension?: (
    request: IncomingMessage,
    pathname: string,
    json: (status: number, body: unknown) => void,
  ) => Promise<boolean>;
}) {
  if (options.token.length < 32)
    throw new Error("WORKER_TOKEN must contain at least 32 characters.");
  const tokenHash = createHash("sha256").update(`Bearer ${options.token}`).digest();
  const browser = await createBrowserManager(options);
  const desktop = await createDesktopManager(
    join(options.dataDir, "desktop"),
    options.desktop ?? {
      python: process.env.OPENMUSE_DESKTOP_PYTHON,
      driver: process.env.OPENMUSE_DESKTOP_DRIVER,
      virtualImage: process.env.OPENMUSE_DESKTOP_IMAGE,
      nativeProxyFile: process.env.HOST_AGENT_CONFIG_PATH,
      ...(process.env.OPENMUSE_DESKTOP_PROXY_URL && process.env.OPENMUSE_DESKTOP_PROXY_TOKEN
        ? {
            nativeProxy: {
              url: process.env.OPENMUSE_DESKTOP_PROXY_URL,
              token: process.env.OPENMUSE_DESKTOP_PROXY_TOKEN,
            },
          }
        : {}),
    },
  );
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    try {
      const pathname = new URL(request.url ?? "/", "http://worker").pathname;
      if (request.method === "GET" && pathname === "/health") {
        json(200, { status: "ok" });
        return;
      }
      const headerHash = createHash("sha256")
        .update(request.headers.authorization ?? "")
        .digest();
      if (!timingSafeEqual(headerHash, tokenHash))
        throw new WorkerError("UNAUTHORIZED", "Worker authentication is required.", 401);
      if (await options.extension?.(request, pathname, json)) return;
      if (pathname === "/capabilities" && request.method === "GET") {
        json(200, { browserToolset: true, desktop: await desktop.status() });
        return;
      }
      if (pathname === "/sessions" && request.method === "GET") {
        json(200, [...browser.list(), ...desktop.list()]);
        return;
      }
      if (pathname === "/sessions" && request.method === "POST") {
        const body = await readBody(request);
        if (body.kind === "desktop") {
          if (body.desktopMode !== "native" && body.desktopMode !== "virtual")
            throw new WorkerError("INVALID_MODE", "Choose native or virtual desktop", 422);
          if (browser.list().some((s) => s.id === body.id))
            throw new WorkerError("SESSION_MODE", "Session belongs to a browser", 409);
          json(201, await desktop.create(validateSessionId(body.id), body.desktopMode));
          return;
        }
        if (desktop.has(String(body.id)))
          throw new WorkerError("SESSION_MODE", "Session belongs to a desktop", 409);
        json(201, await browser.create(validateSessionId(body.id), requiredUrl(body)));
        return;
      }
      const match =
        /^\/sessions\/([^/]+)\/(navigate|close|delete|screenshot|frame|read|input|downloads|automation|state)(?:\/([^/]+))?$/.exec(
          pathname,
        );
      if (!match) throw new WorkerError("NOT_FOUND", "Worker endpoint not found.", 404);
      const id = validateSessionId(match[1]);
      const action = match[2];
      const downloadId = match[3];
      if (desktop.has(id)) {
        if (downloadId) throw new WorkerError("NOT_FOUND", "Desktop endpoint not found", 404);
        if (action === "automation" && request.method === "POST")
          json(200, { result: await desktop.action(id, await readBody(request)) });
        else if (action === "input" && request.method === "POST")
          json(200, await desktop.input(id, await readBody(request)));
        else if (action === "close" && request.method === "POST")
          json(200, await desktop.closeSession(id));
        else if (action === "delete" && request.method === "POST")
          json(200, await desktop.remove(id));
        else if ((action === "screenshot" || action === "frame") && request.method === "GET") {
          const bytes = await desktop.screenshot(id, action === "frame"),
            tag = '"' + createHash("sha256").update(bytes).digest("hex") + '"';
          if (request.headers["if-none-match"] === tag) {
            response.writeHead(304);
            response.end();
          } else {
            response.writeHead(200, {
              "content-type": action === "frame" ? "image/jpeg" : "image/png",
              "content-length": bytes.length,
              etag: tag,
            });
            response.end(bytes);
          }
        } else
          throw new WorkerError(
            "UNSUPPORTED_DESKTOP",
            "Desktop sessions use screenshots and computer_use, not browser DOM/navigation",
            422,
          );
        return;
      }
      if (action === "automation" && !downloadId && request.method === "POST")
        json(200, { result: await browser.automation(id, await readBody(request)) });
      else if (action === "state" && !downloadId && request.method === "GET")
        json(
          200,
          await browser.automationState(
            id,
            !new URL(request.url ?? "", "http://worker").searchParams.has("peek"),
          ),
        );
      else if (action === "navigate" && !downloadId && request.method === "POST")
        json(200, await browser.navigate(id, requiredUrl(await readBody(request))));
      else if (action === "close" && !downloadId && request.method === "POST")
        json(200, await browser.closeSession(id));
      else if (action === "delete" && !downloadId && request.method === "POST")
        json(200, await browser.remove(id));
      else if (action === "input" && !downloadId && request.method === "POST")
        json(200, await browser.input(id, await readBody(request)));
      else if (action === "read" && !downloadId && request.method === "GET")
        json(200, await browser.read(id));
      else if (action === "frame" && !downloadId && request.method === "GET") {
        const frame = await browser.frame(id);
        if (request.headers["if-none-match"] === frame.tag) {
          response.writeHead(304);
          response.end();
        } else {
          response.writeHead(200, {
            "content-type": "image/jpeg",
            "content-length": frame.bytes.length,
            etag: frame.tag,
          });
          response.end(frame.bytes);
        }
      } else if (action === "screenshot" && !downloadId && request.method === "GET") {
        const bytes = await browser.screenshot(id);
        response.writeHead(200, { "content-type": "image/png", "content-length": bytes.length });
        response.end(bytes);
      } else if (action === "downloads" && request.method === "GET") {
        if (!downloadId) json(200, await browser.downloads(id));
        else {
          const result = await browser.download(id, downloadId);
          response.writeHead(200, {
            "content-type": "application/pdf",
            "content-length": result.bytes.length,
            "content-disposition": `attachment; filename="${result.metadata.name}"`,
          });
          response.end(result.bytes);
        }
      } else throw new WorkerError("NOT_FOUND", "Worker endpoint not found.", 404);
    } catch (error) {
      const safe =
        error instanceof WorkerError
          ? error
          : error instanceof z.ZodError
            ? new WorkerError(
                "INVALID_INPUT",
                "화면 동작의 형식 또는 좌표가 올바르지 않습니다.",
                422,
              )
            : new WorkerError(
                "WORKER_FAILURE",
                "The browser operation failed. Check worker health and reopen the session.",
                500,
              );
      if (!response.headersSent && !response.destroyed)
        json(safe.status, { error: { code: safe.code, message: safe.message } });
      else response.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return {
    desktopStatus: () => desktop.status(),
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await browser.close();
      await desktop.close();
    },
  };
}
