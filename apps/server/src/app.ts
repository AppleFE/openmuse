import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventType, MessageSchema } from "@ag-ui/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  type Connection,
  emailDraftSchema,
  proposalSchema,
} from "../../../packages/domain/src/index.ts";
import { threadNameSchema } from "../../../packages/domain/src/thread-name.ts";
import { ActionService } from "./actions.ts";
import { agentConfigured, makeConversationAgent, makeRuntime } from "./agent.ts";
import { attachmentRoutes } from "./attachments.ts";
import { createAuth } from "./auth.ts";
import { BrowserService } from "./browser.ts";
import { chatStreamResponse } from "./chat-stream.ts";
import { ComputerService, type DockerRunner } from "./computer.ts";
import { computerRoutes } from "./computer-routes.ts";
import type { Config } from "./config.ts";
import { connectorRoutes } from "./connector-routes.ts";
import { ConnectorService } from "./connector-service.ts";
import { ConversationStoreRunner } from "./conversations.ts";
import type { Store } from "./db.ts";
import { agentRoutes } from "./engine/routes.ts";
import { AgentService } from "./engine/service.ts";
import { AppError } from "./errors.ts";
import { Files } from "./files.ts";
import { GoogleAuth } from "./google-auth.ts";
import { HostEventService, hostEventRoutes } from "./host-events.ts";
import { hostInstallerRoutes } from "./host-installer.ts";
import { HostMetricsService, hostMetricsRoutes } from "./host-metrics.ts";
import { skillRoutes } from "./skills.ts";
import { UsageService } from "./usage.ts";
import { WorkspaceService } from "./workspace.ts";

export async function createApp(
  db: Store,
  config: Config,
  options: { docker?: DockerRunner } = {},
) {
  const auth = await createAuth(db, config),
    files = new Files(db, config, auth),
    google = new GoogleAuth(db, config),
    workspace = new WorkspaceService(db, config, files, google);
  const connectors = new ConnectorService(db, config);
  const browser = new BrowserService(db, config, auth, files, Date.now, connectors);
  const actions = new ActionService(db, {
    execute: (owner, input, connectionId, targetVersion, signal) =>
      input.kind === "automation.write"
        ? browser.runAutomation(owner, input.data, targetVersion, signal).then((result) => {
            if (result.isError)
              throw new AppError(
                JSON.stringify(result.content.filter((b) => b.type === "text")),
                422,
              );
            return JSON.stringify(result);
          })
        : input.kind === "connector.write"
          ? connectors.executeWrite(owner, input.data, targetVersion)
          : workspace.execute(owner, input, connectionId, targetVersion),
    prepare: (owner, input, connectionId) =>
      input.kind === "automation.write"
        ? browser.prepareAutomation(owner, input)
        : input.kind === "connector.write"
          ? connectors.prepareWrite(owner, input.data)
          : workspace.prepare(owner, input, connectionId),
    connected: async (owner, input) =>
      input.kind === "automation.write"
        ? Boolean(await browser.get(owner, input.data.sessionId))
        : input.kind === "connector.write"
          ? Boolean(await connectors.actionConnection(owner, input.data))
          : workspace.connected(owner),
    connection: (owner, input) =>
      input.kind === "automation.write"
        ? browser.automationConnection(owner, input.data.sessionId)
        : input.kind === "connector.write"
          ? connectors.actionConnection(owner, input.data)
          : workspace.connection(owner),
  });
  browser.configureActions(actions);
  const computer = new ComputerService(db, config, options.docker);
  const agent = new AgentService(
    db,
    config,
    workspace,
    files,
    actions,
    browser,
    computer,
    connectors,
  );
  const conversations = new ConversationStoreRunner(db, auth, config, agent.attachments);
  await conversations.prepareNames();
  await conversations.recoverInterrupted();
  const hostEvents = new HostEventService(db, connectors, conversations, (owner) =>
    makeConversationAgent(config, agent, owner),
  );
  await hostEvents.recover();
  const runtime = makeRuntime(config, agent, auth, conversations);
  const app = new Hono<{ Variables: { owner: string } }>();
  const origins = new Set([...config.allowedOrigins, new URL(config.publicUrl).origin]);
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !origins.has(origin)) return c.json({ error: "Origin is not allowed" }, 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin) => (origins.has(origin) ? origin : undefined),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );
  app.use("*", (c, next) =>
    bodyLimit({
      maxSize: c.req.path === "/api/attachments" ? 102 * 1024 * 1024 : 12 * 1024 * 1024,
      onError: (c) =>
        c.json(
          {
            error:
              c.req.path === "/api/attachments"
                ? "첨부 파일 합계는 100MB 이하여야 합니다."
                : "요청이 너무 큽니다. 업로드 파일은 합계 10MB 이하여야 합니다.",
          },
          413,
        ),
    })(c, next),
  );
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json({ error: error.issues.map((i) => i.message).join("; ") }, 422);
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    if (error.name === "PdfError" || error.name === "RecurringEventError")
      return c.json({ error: error.message }, 422);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid request data" }, 400);
    // Provider and document errors are useful, but raw stack traces and token-bearing responses are not.
    console.error(`[OpenMuse] ${error.name}`);
    return c.json(
      {
        error:
          error.name === "PdfError" || error.name === "GoogleApiError"
            ? error.message
            : "Request failed. Check the server setup and try again.",
      },
      502,
    );
  });
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      mode: config.mode,
      agentConfigured: agentConfigured(config),
      browserConfigured: Boolean(config.workerUrl && config.workerToken),
    }),
  );
  let loginWindow = 0,
    loginAttempts = 0;
  app.post("/api/session", async (c) => {
    if (Date.now() - loginWindow > 60000) {
      loginWindow = Date.now();
      loginAttempts = 0;
    }
    if (++loginAttempts > 30)
      throw new AppError("Too many sign-in attempts. Try again in a minute.", 429);
    const body = z.object({ accessKey: z.string().optional() }).parse(await c.req.json());
    const session = await auth.session(body.accessKey);
    await workspace.ensureSample("local-user", actions);
    await agent.ensure("local-user");
    if (config.mode === "sample") await agent.refreshIdeas("local-user");
    return c.json(session);
  });
  app.get("/api/google/callback", async (c) => {
    if (c.req.query("error"))
      return c.html("<h1>Google connection cancelled</h1><p>You can return to OpenMuse.</p>", 400);
    const state = c.req.query("state"),
      code = c.req.query("code");
    if (!state || !code) throw new AppError("Google callback is incomplete");
    await google.callback(state, code);
    return c.html(
      "<h1>Google is connected</h1><p>Return to OpenMuse and refresh your workspace.</p>",
    );
  });
  app.use("/api/*", async (c, next) => {
    if (/^\/api\/host-agent\/[a-f0-9-]{36}\/events(?:\/[a-f0-9]{64})?$/.test(c.req.path))
      return next();
    if (
      /^\/api\/host-agent\/install\/[a-f0-9]{64}\/(install\.sh|install\.ps1|bundle\.tar\.gz|manifest|enroll)$/.test(
        c.req.path,
      )
    )
      return next();
    if (c.req.path.startsWith("/api/novnc/")) return next();
    const signedRoute =
      /^\/api\/(?:files|attachments)\/[^/]+\/content$|^\/api\/browsers\/[^/]+\/(?:preview|console)$/.test(
        c.req.path,
      );
    const owner =
      signedRoute && c.req.query("signature")
        ? auth.verify(new URL(c.req.url))
        : await auth.owner(c.req.header("authorization"));
    c.set("owner", owner);
    await next();
  });
  app.get("/api/workspace", async (c) => {
    const [snapshot, reachable, connectorConnections] = await Promise.all([
      workspace.snapshot(c.get("owner"), c.req.query("q")),
      browser.reachable(),
      connectors.connections(c.get("owner")),
    ]);
    snapshot.browsers = snapshot.browsers.map((s) => browser.decorate(c.get("owner"), s));
    // A configured worker that does not answer is offline, not ready.
    snapshot.connections = snapshot.connections.map((connection) =>
      connection.id === "browser" && connection.status === "connected" && !reachable
        ? { ...connection, status: "unavailable" }
        : connection,
    );
    snapshot.connections.push(...(connectorConnections as Connection[]));
    return c.json(snapshot);
  });
  app.get("/api/novnc/*", async (c) => {
    const root = dirname(dirname(fileURLToPath(import.meta.resolve("@novnc/novnc"))));
    const part = c.req.path.slice("/api/novnc/".length);
    if (!/^(core|vendor)\/[a-zA-Z0-9_./-]+\.(js|wasm)$/.test(part))
      throw new AppError("Not found", 404);
    const path = resolve(root, part);
    if (relative(root, path).startsWith("..")) throw new AppError("Not found", 404);
    const bytes = await readFile(path).catch(() => {
      throw new AppError("Not found", 404);
    });
    c.header(
      "Content-Type",
      path.endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8",
    );
    return c.body(bytes);
  });
  app.route("/api/agent", agentRoutes(agent));
  app.route("/api/computer", computerRoutes(computer, files));
  app.route("/api/skills", skillRoutes(agent.skills));
  app.route("/api/attachments", attachmentRoutes(agent.attachments, auth));
  app.route("/api/hosts", hostMetricsRoutes(new HostMetricsService(db, connectors), connectors));
  app.route("/api/connectors", connectorRoutes(connectors));
  app.route("/api/host-agent", hostInstallerRoutes(db, config, connectors));
  app.route("/api/host-events", hostEventRoutes(hostEvents));
  app.post("/api/host-agent/:connectorId/events", async (c) => {
    const { owner, connector } = await connectors.authenticateHostAgent(
      c.req.param("connectorId"),
      c.req.header("authorization"),
    );
    const result = await hostEvents.accept(owner, connector, await c.req.json());
    return c.json(result, result.duplicate ? 200 : 202);
  });
  app.get("/api/host-agent/:connectorId/events/:id", async (c) => {
    const { owner, connector } = await connectors.authenticateHostAgent(
      c.req.param("connectorId"),
      c.req.header("authorization"),
    );
    const event = await hostEvents.get(owner, c.req.param("id"), connector.id);
    return c.json({ event });
  });
  app.get("/api/calendars", async (c) => c.json(await workspace.calendars(c.get("owner"))));
  app.get("/api/calendar/events", async (c) => {
    const query = z
      .object({
        calendarId: z.string().min(1).max(1024).optional(),
        timeMin: z.iso.datetime({ offset: true }).optional(),
        timeMax: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(c.req.query());
    if (
      query.timeMin &&
      query.timeMax &&
      (Date.parse(query.timeMax) <= Date.parse(query.timeMin) ||
        Date.parse(query.timeMax) - Date.parse(query.timeMin) > 366 * 86400000)
    )
      throw new AppError("Choose a calendar range between one moment and 366 days", 422);
    return c.json(await workspace.events(c.get("owner"), query));
  });
  app.get("/api/mail/threads/:id", async (c) =>
    c.json(await workspace.thread(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/actions", async (c) => {
    const input = proposalSchema.parse(await c.req.json());
    if (input.kind === "email.send")
      for (const id of input.data.attachmentIds) await files.get(c.get("owner"), id);
    return c.json(await actions.propose(c.get("owner"), input), 201);
  });
  app.post("/api/actions/:id/decide", async (c) => {
    const body = z
      .object({ hash: z.string(), decision: z.enum(["approve", "deny"]) })
      .parse(await c.req.json());
    return c.json(
      await actions.decide(c.get("owner"), c.req.param("id"), body.hash, body.decision),
    );
  });
  app.get("/api/drafts", async (c) => c.json(await db.list(c.get("owner"), "drafts")));
  app.post("/api/drafts", async (c) => {
    const body = emailDraftSchema.extend({ id: z.string().optional() }).parse(await c.req.json());
    const existing = body.id
      ? await db.get<{ createdAt: string }>(c.get("owner"), "drafts", body.id)
      : null;
    if (body.id && !existing) throw new AppError("Draft not found", 404);
    return c.json(
      await db.put(c.get("owner"), "drafts", {
        ...body,
        id: body.id ?? randomUUID(),
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      }),
      201,
    );
  });
  app.get("/api/main-thread", async (c) => {
    const owner = c.get("owner");
    await db.insertIfAbsent(owner, "conversation-settings", {
      id: "main",
      threadId: randomUUID(),
      existing: false,
    });
    const main = await db.get<{ threadId: string }>(owner, "conversation-settings", "main");
    if (!main) throw new AppError("Main conversation could not be loaded", 503);
    await conversations.ensure(owner, main.threadId, "default");
    return c.json({ threadId: main.threadId, existing: true });
  });
  app.get("/api/copilotkit/threads", async (c) => {
    const limit = c.req.query("limit");
    return c.json(
      await conversations.list(c.get("owner"), {
        agentId: c.req.query("agentId"),
        includeArchived:
          c.req.query("includeArchived") === "true" || c.req.query("archived") === "true",
        archived:
          c.req.query("archived") === undefined
            ? undefined
            : z.enum(["true", "false"]).parse(c.req.query("archived")) === "true",
        query: z.string().trim().max(200).optional().parse(c.req.query("query")),
        limit:
          limit === undefined ? undefined : z.coerce.number().int().min(1).max(100).parse(limit),
        cursor: c.req.query("cursor"),
      }),
    );
  });
  app.post("/api/copilotkit/threads", async (c) => {
    const body = z
      .object({
        id: z.string().min(1).max(200).optional(),
        name: threadNameSchema.optional(),
        agentId: z.string().min(1).max(100).optional(),
      })
      .parse(await c.req.json());
    return c.json(conversations.metadata(await conversations.create(c.get("owner"), body)), 201);
  });
  app.post("/api/copilotkit/threads/clear", (c) =>
    c.json(
      { error: "Bulk thread deletion is not supported; delete owner-scoped threads by ID" },
      405,
    ),
  );
  app.patch("/api/copilotkit/threads/:id", async (c) => {
    const body = z.object({ name: threadNameSchema }).parse(await c.req.json());
    return c.json(
      conversations.metadata(
        await conversations.rename(c.get("owner"), c.req.param("id"), body.name),
      ),
    );
  });
  app.get("/api/copilotkit/threads/:id/approval", async (c) => {
    const thread = await conversations.get(c.get("owner"), c.req.param("id"));
    return c.json({ mode: thread.approvalMode ?? "review" });
  });
  app.get("/api/copilotkit/threads/:id", async (c) =>
    c.json(conversations.metadata(await conversations.get(c.get("owner"), c.req.param("id")))),
  );
  app.get("/api/copilotkit/threads/:id/knowledge", async (c) =>
    c.json(await agent.knowledge.get(c.get("owner"), c.req.param("id"))),
  );
  app.put("/api/copilotkit/threads/:id/knowledge", async (c) =>
    c.json(await agent.knowledge.save(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  app.put("/api/copilotkit/threads/:id/approval", async (c) => {
    const { mode } = z
      .object({ mode: z.enum(["review", "bypass"]) })
      .strict()
      .parse(await c.req.json());
    const thread = await conversations.setApprovalMode(c.get("owner"), c.req.param("id"), mode);
    return c.json({ mode: thread.approvalMode });
  });
  app.delete("/api/copilotkit/threads/:id", async (c) => {
    await conversations.remove(c.get("owner"), c.req.param("id"));
    return c.json({ threadId: c.req.param("id"), deleted: true });
  });
  app.post("/api/copilotkit/threads/:id/archive", async (c) =>
    c.json(
      conversations.metadata(
        await conversations.setArchived(c.get("owner"), c.req.param("id"), true),
      ),
    ),
  );
  app.post("/api/copilotkit/threads/:id/restore", async (c) =>
    c.json(
      conversations.metadata(
        await conversations.setArchived(c.get("owner"), c.req.param("id"), false),
      ),
    ),
  );
  app.get("/api/copilotkit/threads/:id/messages", async (c) => {
    const thread = await conversations.get(c.get("owner"), c.req.param("id"));
    return c.json({ messages: thread.messages });
  });
  app.get("/api/copilotkit/threads/:id/runs/:runId", async (c) =>
    c.json(await conversations.runStatus(c.get("owner"), c.req.param("id"), c.req.param("runId"))),
  );
  app.get("/api/usage", async (c) =>
    c.json(await new UsageService(db).summary(c.get("owner"), c.req.query("threadId"))),
  );
  app.get("/api/copilotkit/threads/:id/events", async (c) => {
    const thread = await conversations.get(c.get("owner"), c.req.param("id"));
    return c.json({ events: thread.events });
  });
  app.get("/api/copilotkit/threads/:id/state", async (c) => {
    const thread = await conversations.get(c.get("owner"), c.req.param("id"));
    return c.json({ state: thread.state });
  });
  app.post("/api/copilotkit/agent/:agentId/stop/:threadId", async (c) => {
    const stopped = await conversations.stopOwner(c.get("owner"), c.req.param("threadId"));
    return c.json(
      stopped
        ? {
            stopped: true,
            interrupt: {
              type: EventType.RUN_ERROR,
              message: "Run stopped by user",
              code: "STOPPED",
            },
          }
        : { stopped: false, message: `No active run for thread '${c.req.param("threadId")}'.` },
    );
  });
  app.get("/api/conversation", async (c) =>
    c.json((await db.get(c.get("owner"), "conversations", "default")) ?? { messages: [] }),
  );
  app.put("/api/conversation", async (c) => {
    const body = await c.req.json();
    const messages = z.array(z.unknown()).max(1000).parse(body.messages);
    for (const message of messages) MessageSchema.parse(message);
    await db.put(c.get("owner"), "conversations", { id: "default", messages });
    return c.json({ ok: true });
  });
  app.post("/api/files", async (c) => {
    const data = await c.req.parseBody();
    const file = data.file;
    if (!(file instanceof File)) throw new AppError("Choose a PDF file");
    return c.json(
      await files.import(
        c.get("owner"),
        file.name,
        new Uint8Array(await file.arrayBuffer()),
        "Uploaded by you",
      ),
      201,
    );
  });
  app.get("/api/files/:id/content", async (c) => {
    const file = await files.get(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", "application/pdf");
    c.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return c.body(await files.bytes(c.get("owner"), file.id));
  });
  app.post("/api/files/:id/fill", async (c) => {
    const body = z
      .object({ fields: z.record(z.string(), z.union([z.string(), z.boolean()])) })
      .parse(await c.req.json());
    return c.json(await files.fill(c.get("owner"), c.req.param("id"), body.fields), 201);
  });
  app.post("/api/mail/import-attachment", async (c) => {
    const body = z.object({ reference: z.string() }).parse(await c.req.json());
    return c.json(await workspace.importAttachment(c.get("owner"), body.reference), 201);
  });
  app.post("/api/google/connect", async (c) => {
    const body = z.object({ capability: z.enum(["read", "write"]) }).parse(await c.req.json());
    if (config.mode === "sample") {
      await db.put(c.get("owner"), "settings", {
        id: "google",
        enabled: true,
        connectionId: randomUUID(),
      });
      return c.json({ url: null, connected: true });
    }
    return c.json(await google.connect(c.get("owner"), body.capability === "write"));
  });
  app.post("/api/google/disconnect", async (c) => {
    if (config.mode === "sample")
      await db.put(c.get("owner"), "settings", { id: "google", enabled: false });
    else await google.disconnect(c.get("owner"));
    return c.json({ ok: true });
  });
  app.post("/api/browsers", async (c) => {
    const body = z
      .object({ url: z.url().max(4096), connectorId: z.string().min(1).max(120).optional() })
      .parse(await c.req.json());
    return c.json(await browser.create(c.get("owner"), body.url, body.connectorId), 201);
  });
  app.get("/api/automation/capabilities", async (c) =>
    c.json(
      await browser.capabilities(
        c.get("owner"),
        z.string().max(120).optional().parse(c.req.query("connectorId")),
      ),
    ),
  );
  app.post("/api/desktops", async (c) => {
    const body = z
      .object({
        mode: z.enum(["virtual", "native"]),
        connectorId: z.string().min(1).max(120).optional(),
      })
      .parse(await c.req.json());
    return c.json(await browser.createDesktop(c.get("owner"), body.mode, body.connectorId), 201);
  });
  app.delete("/api/browsers/:id", async (c) =>
    c.json(await browser.remove(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/browsers/delete", async (c) => {
    const body = z
      .strictObject({ ids: z.array(z.uuid()).min(1).max(100) })
      .parse(await c.req.json());
    const results = [];
    for (const id of body.ids) {
      try {
        await browser.remove(c.get("owner"), id);
        results.push({ id, ok: true });
      } catch (error) {
        results.push({
          id,
          ok: false,
          error: error instanceof Error ? error.message : "삭제 실패",
        });
      }
    }
    return c.json({ results });
  });
  app.get("/api/browsers/:id", async (c) => {
    const owner = c.get("owner");
    return c.json(browser.decorate(owner, await browser.get(owner, c.req.param("id"))));
  });
  app.post("/api/browsers/:id/navigate", async (c) => {
    const body = z.object({ url: z.url().max(4096) }).parse(await c.req.json());
    return c.json(await browser.navigate(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/close", async (c) =>
    c.json(await browser.close(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/read", async (c) =>
    c.json(await browser.read(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/tabs", async (c) =>
    c.json(await browser.tabs(c.get("owner"), c.req.param("id"))),
  );
  app.post("/api/browsers/:id/tabs", async (c) =>
    c.json(await browser.userTab(c.get("owner"), c.req.param("id"), await c.req.json())),
  );
  app.post("/api/browsers/:id/control", async (c) => {
    const body = z.strictObject({ control: z.enum(["agent", "user"]) }).parse(await c.req.json());
    return c.json(await browser.setControl(c.get("owner"), c.req.param("id"), body.control));
  });
  app.post("/api/browsers/:id/reopen", async (c) => {
    const raw = await c.req.text();
    const body = z.object({ url: z.url().max(4096).optional() }).parse(raw ? JSON.parse(raw) : {});
    return c.json(await browser.reopen(c.get("owner"), c.req.param("id"), body.url));
  });
  app.post("/api/browsers/:id/import-downloads", async (c) =>
    c.json(await browser.imports(c.get("owner"), c.req.param("id"))),
  );
  app.get("/api/browsers/:id/preview", async (c) => {
    const response = await browser.preview(c.get("owner"), c.req.param("id"));
    c.header("Content-Type", "image/png");
    return c.body(await response.arrayBuffer());
  });
  app.get("/api/browsers/:id/console", async (c) => {
    await browser.get(c.get("owner"), c.req.param("id"));
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob: data:; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:",
    );
    return c.html(browser.console(c.get("owner"), c.req.param("id")));
  });
  app.post("/api/browsers/:id/console", async (c) => {
    const body = await c.req.json();
    if (body.op === "state") {
      const session = await browser.get(c.get("owner"), c.req.param("id"));
      return c.json({ control: session.control, status: session.status });
    }
    if (body.op === "control") {
      const input = z
        .strictObject({ op: z.literal("control"), control: z.enum(["agent", "user"]) })
        .parse(body);
      return c.json(await browser.setControl(c.get("owner"), c.req.param("id"), input.control));
    }
    await browser.streamInput(c.get("owner"), c.req.param("id"), body);
    return c.json({ ok: true });
  });
  app.all("/api/copilotkit/*", async (c) => {
    if (!agentConfigured(config))
      throw new AppError(
        "Configure a model and provider API key, or a valid AG-UI endpoint, to start chat",
        503,
      );
    return chatStreamResponse(await runtime.fetch(c.req.raw));
  });
  app.get("/", (c) =>
    c.json({ name: "OpenMuse", app: "http://localhost:8081", health: "/api/health" }),
  );
  return {
    app,
    auth,
    files,
    actions,
    workspace,
    agent,
    computer,
    connectors,
    conversations,
    browser,
    hostEvents,
  };
}
