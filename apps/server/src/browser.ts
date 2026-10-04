import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserSession } from "../../../packages/domain/src/index.ts";
import { browserInputSchema } from "../../../packages/domain/src/remote-host.ts";
import type { Auth } from "./auth.ts";
import { browserConsole } from "./browser-console.ts";
import type { Config } from "./config.ts";
import type { ConnectorService } from "./connector-service.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";

const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.enum(["idle", "active", "closed", "error"]),
  updatedAt: z.string(),
});
const readSchema = z.object({
  url: z.string(),
  title: z.string().max(300),
  text: z.string().max(100_000),
  truncated: z.boolean(),
  elements: z
    .array(z.object({ label: z.string(), role: z.string(), x: z.number(), y: z.number() }))
    .max(100)
    .optional(),
});
const failureSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  message: z.string(),
  createdAt: z.string(),
});
type ChatBrowser = { id: string; sessionId: string };

export class BrowserService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private health?: { checkedAt: number; reachable: Promise<boolean> };
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly auth: Auth,
    private readonly files: Files,
    private readonly now: () => number = Date.now,
    private readonly connectors?: ConnectorService,
  ) {}
  /** Whether the configured worker answers its health check, cached briefly for snapshots. */
  reachable(): Promise<boolean> {
    if (!this.config.workerUrl || !this.config.workerToken) return Promise.resolve(false);
    const now = this.now();
    if (this.health && now - this.health.checkedAt < 15_000) return this.health.reachable;
    const reachable = fetch(`${this.config.workerUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    }).then(
      (response) => response.ok,
      () => false,
    );
    this.health = { checkedAt: now, reachable };
    return reachable;
  }
  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(id, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }
  private async request(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    target?: { url: string; token: string },
  ) {
    signal?.throwIfAborted();
    const workerUrl = target?.url ?? this.config.workerUrl,
      workerToken = target?.token ?? this.config.workerToken;
    if (!workerUrl || !workerToken)
      throw new AppError("Browser worker is not configured. Start it using the setup guide.", 503);
    let response: Response;
    try {
      response = await fetch(`${workerUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${workerToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
          : AbortSignal.timeout(45000),
      });
    } catch {
      signal?.throwIfAborted();
      throw new AppError(
        "Browser worker is unavailable. Check that its container is running.",
        503,
      );
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new AppError(
        typeof payload?.error?.message === "string"
          ? payload.error.message.split(workerToken).join("[redacted]")
          : "Browser request failed",
        502,
      );
    }
    return response;
  }
  private async sessionRequest(
    owner: string,
    id: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const session = await this.get(owner, id);
    const target = session.connectorId
      ? await this.connectors?.browserTarget(owner, session.connectorId)
      : undefined;
    if (session.connectorId && !target)
      throw new AppError("원격 호스트 브라우저를 사용할 수 없습니다", 503);
    if (target && session.connectorRevision !== target.revision)
      throw new AppError(
        "호스트 주소 또는 인증 정보가 변경되었습니다. 새 브라우저 세션을 여세요",
        409,
      );
    return this.request(path, body, signal, target);
  }
  async setControl(owner: string, id: string, control: "agent" | "user") {
    return this.serial(id, async () => {
      const session = await this.get(owner, id);
      if (session.control === "user" && control === "agent" && session.status === "active")
        await this.sessionRequest(owner, id, `/sessions/${id}/input`, { type: "vnc_reset" });
      const saved = { ...session, control, updatedAt: new Date().toISOString() };
      await this.db.put(owner, "browsers", saved);
      return this.decorate(owner, saved);
    });
  }
  private async agentAccess(owner: string, id: string) {
    if ((await this.get(owner, id)).control === "user")
      throw new AppError(
        "사용자가 브라우저를 직접 제어 중입니다. 사용자가 에이전트 제어로 돌려줄 때까지 기다리세요",
        409,
      );
  }
  async get(owner: string, id: string) {
    const value = await this.db.get<BrowserSession>(owner, "browsers", id);
    if (!value) throw new AppError("Browser session not found", 404);
    return value;
  }
  decorate(owner: string, session: BrowserSession) {
    return {
      ...session,
      consoleUrl: this.auth.sign(owner, `/api/browsers/${session.id}/console`),
      previewUrl: this.auth.sign(owner, `/api/browsers/${session.id}/preview`),
    };
  }
  private async save(owner: string, payload: unknown, expectedId: string) {
    const session = sessionSchema.parse(payload);
    if (session.id !== expectedId)
      throw new AppError("Browser worker returned a different session", 502);
    const existing = await this.get(owner, expectedId);
    const saved = { ...existing, ...session };
    await this.db.put(owner, "browsers", saved);
    return this.decorate(owner, saved);
  }
  async create(owner: string, url: string, connectorId?: string) {
    await this.cleanup(owner, connectorId);
    await this.checkHistoryLimit(owner, connectorId);
    const target = connectorId
      ? await this.connectors?.browserTarget(owner, connectorId)
      : undefined;
    const id = randomUUID();
    // Record ownership before calling the worker, including when its response is lost.
    await this.db.put(owner, "browsers", {
      id,
      url,
      title: "New browser session",
      status: "idle",
      ...(connectorId ? { connectorId, connectorRevision: target?.revision } : {}),
      control: "agent",
      updatedAt: new Date().toISOString(),
    });
    return this.reopen(owner, id, url);
  }
  private async openOwned(owner: string, id: string, url?: string, signal?: AbortSignal) {
    const value = await this.get(owner, id);
    const target = url ?? value.url;
    try {
      const response = await this.sessionRequest(
        owner,
        id,
        "/sessions",
        { id, url: target },
        signal,
      );
      return await this.save(owner, await response.json(), id);
    } catch (error) {
      await this.save(
        owner,
        { ...value, url: target, status: "error", updatedAt: new Date().toISOString() },
        id,
      );
      throw error;
    }
  }
  reopen(owner: string, id: string, url?: string) {
    return this.serial(id, () => this.openOwned(owner, id, url));
  }
  navigate(owner: string, id: string, url: string) {
    return this.reopen(owner, id, url);
  }
  private async readOwned(owner: string, id: string, signal?: AbortSignal) {
    const session = await this.get(owner, id);
    const result = readSchema.parse(
      await (
        await this.sessionRequest(owner, id, `/sessions/${id}/read`, undefined, signal)
      ).json(),
    );
    await this.save(
      owner,
      {
        ...session,
        url: result.url,
        title: result.title,
        status: "active",
        updatedAt: new Date().toISOString(),
      },
      id,
    );
    return result;
  }
  read(owner: string, id: string) {
    return this.serial(id, () => this.readOwned(owner, id));
  }
  async observe(owner: string, url: string, existingId?: string) {
    const id = existingId ?? (await this.create(owner, url)).id;
    return this.serial(id, async () => {
      if (existingId) await this.openOwned(owner, id, url);
      return { sessionId: id, ...(await this.readOwned(owner, id)) };
    });
  }
  async observeForThread(
    owner: string,
    threadId: string,
    url: string,
    signal?: AbortSignal,
    connectorId?: string,
  ) {
    signal?.throwIfAborted();
    await this.cleanup(owner, connectorId);
    // Persist the association before contacting the worker so failed/lost responses
    // and later chat turns keep using the same profile instead of exhausting its limit.
    const associationId = connectorId ? `${threadId}:${connectorId}` : threadId;
    const target = connectorId
      ? await this.connectors?.browserTarget(owner, connectorId)
      : undefined;
    const association =
      (await this.db.get<ChatBrowser>(owner, "chat-browsers", associationId)) ??
      (await this.db.insertIfAbsent(owner, "chat-browsers", {
        id: associationId,
        sessionId: randomUUID(),
      })) ??
      (await this.db.get<ChatBrowser>(owner, "chat-browsers", associationId));
    if (!association) throw new AppError("Could not reserve the chat browser session", 500);
    const id = association.sessionId;
    if (!(await this.db.get(owner, "browsers", id)))
      await this.checkHistoryLimit(owner, connectorId);
    await this.db.insertIfAbsent(owner, "browsers", {
      id,
      url,
      title: "New browser session",
      status: "idle",
      ...(connectorId ? { connectorId, connectorRevision: target?.revision } : {}),
      control: "agent",
      updatedAt: new Date().toISOString(),
    });
    return this.serial(id, async () => {
      signal?.throwIfAborted();
      await this.agentAccess(owner, id);
      await this.openOwned(owner, id, url, signal);
      signal?.throwIfAborted();
      const page = await this.readOwned(owner, id, signal);
      signal?.throwIfAborted();
      return {
        sessionId: id,
        ...page,
        text: page.text.slice(0, 30_000),
        truncated: page.truncated || page.text.length > 30_000,
      };
    });
  }
  async close(owner: string, id: string) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      return this.save(
        owner,
        await (await this.sessionRequest(owner, id, `/sessions/${id}/close`, {})).json(),
        id,
      );
    });
  }
  async preview(owner: string, id: string) {
    await this.get(owner, id);
    return this.sessionRequest(owner, id, `/sessions/${id}/screenshot`);
  }
  async input(owner: string, id: string, value: unknown, agent = false, signal?: AbortSignal) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      if (agent) await this.agentAccess(owner, id);
      signal?.throwIfAborted();
      const parsed = browserInputSchema.parse(value);
      const payload = await (
        await this.sessionRequest(owner, id, `/sessions/${id}/input`, parsed, signal)
      ).json();
      return parsed.type.startsWith("vnc_")
        ? this.decorate(owner, await this.get(owner, id))
        : this.save(owner, payload, id);
    });
  }
  async streamInput(owner: string, id: string, value: unknown) {
    return this.serial(id, async () => {
      const session = await this.get(owner, id);
      if (session.control !== "user")
        throw new AppError("브라우저 제어를 가져온 뒤 조작하세요", 409);
      const parsed = browserInputSchema.parse(value);
      const payload = await (
        await this.sessionRequest(owner, id, `/sessions/${id}/input`, parsed)
      ).json();
      if (!parsed.type.startsWith("vnc_")) return this.save(owner, payload, id);
      return payload;
    });
  }
  async remove(owner: string, id: string) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      await this.sessionRequest(owner, id, `/sessions/${id}/delete`, {});
      await this.db.remove(owner, "browsers", id);
      for (const link of await this.db.list<ChatBrowser>(owner, "chat-browsers"))
        if (link.sessionId === id) await this.db.remove(owner, "chat-browsers", link.id);
      return { ok: true };
    });
  }
  async cleanup(owner: string, connectorId?: string) {
    const all = (await this.db.list<BrowserSession>(owner, "browsers"))
      .filter((s) => (s.connectorId ?? "") === (connectorId ?? ""))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const inactive = all.filter((s) => s.status !== "active" && s.status !== "idle");
    for (const [index, session] of inactive.entries())
      if (index >= 12 || this.now() - Date.parse(session.updatedAt) > 30 * 86400000)
        await this.remove(owner, session.id).catch(() => {});
  }
  private async checkHistoryLimit(owner: string, connectorId?: string) {
    const rows = (await this.db.list<BrowserSession>(owner, "browsers")).filter(
      (s) => (s.connectorId ?? "") === (connectorId ?? ""),
    );
    if (rows.length >= 50)
      throw new AppError(
        "브라우저 기록 한도에 도달했습니다. 호스트 연결을 확인하고 기존 기록을 정리하세요",
        409,
      );
  }
  async imports(owner: string, id: string) {
    await this.get(owner, id);
    const { downloads, failures } = z
      .object({
        downloads: z.array(
          z.object({ id: z.string(), name: z.string(), size: z.number(), mimeType: z.string() }),
        ),
        failures: z.array(failureSchema),
      })
      .parse(await (await this.sessionRequest(owner, id, `/sessions/${id}/downloads`)).json());
    const saved = [];
    for (const download of downloads) {
      const existing = await this.db.get<{ fileId: string }>(
        owner,
        "browser-downloads",
        download.id,
      );
      if (existing) {
        saved.push(this.files.signed(owner, await this.files.get(owner, existing.fileId)));
        continue;
      }
      const response = await this.sessionRequest(
        owner,
        id,
        `/sessions/${id}/downloads/${encodeURIComponent(download.id)}`,
      );
      const file = await this.files.import(
        owner,
        download.name,
        new Uint8Array(await response.arrayBuffer()),
        `Browser · ${id}`,
      );
      await this.db.put(owner, "browser-downloads", { id: download.id, fileId: file.id });
      saved.push(file);
    }
    return { files: saved, failures };
  }
  console(owner: string, id: string) {
    return browserConsole(this.auth.sign(owner, `/api/browsers/${id}/stream`));
  }
}
