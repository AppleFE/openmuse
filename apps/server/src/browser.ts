import { createHash, randomUUID } from "node:crypto";
import type { BetaBrowserState } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import { z } from "zod";
import type { BrowserSession, ProposalInput } from "../../../packages/domain/src/index.ts";
import { browserInputSchema } from "../../../packages/domain/src/remote-host.ts";
import {
  browserBatchSchema,
  desktopBatchSchema,
  observationActions,
} from "../../worker/src/automation-schema.ts";
import type { ActionService } from "./actions.ts";
import type { Auth } from "./auth.ts";
import { browserConsole } from "./browser-console.ts";
import { runBrowserBatch } from "./browser-sdk.ts";
import type { Config } from "./config.ts";
import type { ConnectorService } from "./connector-service.ts";
import type { Store } from "./db.ts";
import { runDesktopBatch } from "./desktop-sdk.ts";
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
class BrowserWorkerError extends AppError {
  constructor(
    message: string,
    readonly upstreamStatus: number,
  ) {
    super(message, 502);
  }
}

export class BrowserService {
  private actions?: ActionService;
  configureActions(actions: ActionService) {
    this.actions = actions;
  }
  private automationVersion(session: BrowserSession) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          session.id,
          session.connectorRevision,
          session.updatedAt,
          session.control,
          session.url,
        ]),
      )
      .digest("hex");
  }
  async automationConnection(owner: string, sessionId: string) {
    const session = await this.get(owner, sessionId);
    return { id: session.id, account: `${session.title} · ${session.url}` };
  }
  async prepareAutomation(
    owner: string,
    input: Extract<ProposalInput, { kind: "automation.write" }>,
  ) {
    const s = await this.get(owner, input.data.sessionId);
    const data = (s.kind === "desktop" ? desktopBatchSchema : browserBatchSchema).parse(input.data);
    await this.agentAccess(owner, data.sessionId);
    const session = await this.get(owner, data.sessionId);
    if (session.status !== "active") throw new AppError("먼저 브라우저 세션을 여세요", 409);
    return { input: { ...input, data }, targetVersion: this.automationVersion(session) };
  }
  async automation(
    owner: string,
    threadId: string,
    raw: unknown,
    signal?: AbortSignal,
    kind: "browser" | "desktop" = "browser",
  ) {
    const data = (kind === "desktop" ? desktopBatchSchema : browserBatchSchema).parse(raw);
    const session = await this.get(owner, data.sessionId);
    if ((session.kind ?? "browser") !== kind)
      throw new AppError(
        "선택한 세션은 다른 종류의 화면입니다. browser_use / computer_use를 확인하세요.",
        422,
      );
    if (
      data.actions.some(
        (a) =>
          !observationActions.has(a.action) &&
          !(
            kind === "browser" &&
            [
              "navigate",
              "new_tab",
              "switch_tab",
              "scroll",
              "scroll_to",
              "hover",
              "mouse_move",
              "close_tab",
            ].includes(a.action)
          ),
      )
    ) {
      if (!this.actions) throw new AppError("화면 조작 승인 서비스를 사용할 수 없습니다", 503);
      const action = await this.actions.proposeForConversation(
        owner,
        threadId,
        {
          kind: "automation.write",
          data,
        },
        undefined,
        undefined,
        signal,
      );
      if (action.status === "succeeded" && action.result) return JSON.parse(action.result);
      return action;
    }
    return this.runAutomation(owner, data, undefined, signal);
  }
  async runAutomation(owner: string, raw: unknown, targetVersion?: string, signal?: AbortSignal) {
    const id = z.object({ sessionId: z.uuid() }).parse(raw).sessionId;
    const desktop = (await this.get(owner, id)).kind === "desktop";
    const data = (desktop ? desktopBatchSchema : browserBatchSchema).parse(raw);
    return this.serial(data.sessionId, async () => {
      const session = await this.get(owner, data.sessionId);
      if (targetVersion && targetVersion !== this.automationVersion(session))
        throw new AppError(
          "검토 이후 화면 또는 제어권이 변경됐습니다. 다시 확인한 후 요청하세요.",
          409,
        );
      if (desktop) {
        const result = await runDesktopBatch(
          {
            confirm: async (action) => {
              signal?.throwIfAborted();
              if (!observationActions.has(action.action)) await this.agentAccess(owner, id);
              return true;
            },
            action: async (input) => {
              if (!observationActions.has(input.action)) await this.agentAccess(owner, id);
              const request = () =>
                this.sessionRequest(owner, id, `/sessions/${id}/automation`, input, signal);
              let response: Response;
              try {
                response = await request();
              } catch (error) {
                // A restarted helper loses its in-memory session, not the logged-in desktop.
                // Reattach only observations to the same owned host. Never replay input.
                if (
                  !(error instanceof BrowserWorkerError) ||
                  !(
                    error.upstreamStatus === 404 ||
                    // Older Host Agents wrap the helper's missing-session response as 409.
                    (error.upstreamStatus === 409 &&
                      ["Desktop not found", "Open the desktop first"].includes(error.message))
                  ) ||
                  session.desktopMode !== "native" ||
                  session.status !== "active" ||
                  !["screenshot", "zoom"].includes(input.action)
                )
                  throw error;
                await this.openOwned(owner, id, undefined, signal);
                response = await request();
              }
              return (await response.json()).result;
            },
          },
          desktopBatchSchema.parse(data).actions,
          signal,
        );
        if (data.actions.some((a) => !observationActions.has(a.action)))
          await this.save(owner, { ...session, updatedAt: new Date().toISOString() }, id);
        return result;
      }
      const state = async () =>
        (await (
          await this.sessionRequest(
            owner,
            session.id,
            `/sessions/${session.id}/state`,
            undefined,
            signal,
          )
        ).json()) as BetaBrowserState;
      const result = await runBrowserBatch(
        {
          state,
          confirm: async (action) => {
            signal?.throwIfAborted();
            if (!observationActions.has(action.action)) await this.agentAccess(owner, session.id);
            return true;
          },
          action: async (input) => {
            if (!observationActions.has(input.action) || ("tab_id" in input && input.tab_id))
              await this.agentAccess(owner, id);
            const response = await this.sessionRequest(
              owner,
              session.id,
              `/sessions/${session.id}/automation`,
              input,
              signal,
            );
            return (await response.json()).result;
          },
        },
        browserBatchSchema.parse(data).actions,
        signal,
      );
      const latest = await state();
      const active = latest.tabs.find((t) => t.active);
      if (active)
        await this.save(
          owner,
          { ...session, title: active.title, url: active.url, updatedAt: new Date().toISOString() },
          session.id,
        );
      return result;
    });
  }
  async capabilities(owner: string, connectorId?: string) {
    const target = connectorId
      ? await this.connectors?.browserTarget(owner, connectorId)
      : undefined;
    try {
      return await (await this.request("/capabilities", undefined, undefined, target)).json();
    } catch (error) {
      return {
        browserToolset: false,
        desktop: { virtual: { available: false }, native: { available: false } },
        message: error instanceof Error ? error.message : "호스트 업데이트 필요",
      };
    }
  }
  async tabs(owner: string, id: string) {
    const session = await this.get(owner, id);
    if (session.kind === "desktop") return { tabs: [] };
    return (await this.sessionRequest(owner, id, `/sessions/${id}/state?peek=1`)).json();
  }
  async userTab(owner: string, id: string, value: unknown) {
    const input = z
      .discriminatedUnion("action", [
        z.object({ action: z.literal("new_tab") }),
        z.object({ action: z.literal("switch_tab"), tab_id: z.string().min(1).max(100) }),
        z.object({ action: z.literal("close_tab"), tab_id: z.string().min(1).max(100) }),
      ])
      .parse(value);
    return this.serial(id, async () => {
      const session = await this.get(owner, id);
      if (session.kind === "desktop" || session.control !== "user")
        throw new AppError("브라우저 제어를 가져온 뒤 탭을 변경하세요", 409);
      await this.sessionRequest(owner, id, `/sessions/${id}/automation`, input);
      const state = await this.tabs(owner, id);
      const tab = state.tabs.find((t: { active: boolean }) => t.active);
      if (tab)
        await this.save(
          owner,
          { ...session, title: tab.title, url: tab.url, updatedAt: new Date().toISOString() },
          id,
        );
      return state;
    });
  }
  async createDesktop(owner: string, mode: "virtual" | "native", connectorId?: string) {
    await this.cleanup(owner, connectorId);
    await this.checkHistoryLimit(owner, connectorId);
    const target = connectorId
      ? await this.connectors?.browserTarget(owner, connectorId)
      : undefined;
    const existing = (await this.db.list<BrowserSession>(owner, "browsers")).find(
      (s) =>
        s.kind === "desktop" &&
        s.desktopMode === mode &&
        (s.connectorId ?? "") === (connectorId ?? "") &&
        s.status === "active" &&
        (!connectorId || s.connectorRevision === target?.revision),
    );
    if (existing) return this.reopen(owner, existing.id);
    const id = randomUUID();
    await this.db.put(owner, "browsers", {
      id,
      kind: "desktop",
      desktopMode: mode,
      url: "desktop://" + mode,
      title: mode === "native" ? "호스트 데스크톱" : "가상 데스크톱",
      status: "idle",
      control: "agent",
      updatedAt: new Date().toISOString(),
      ...(connectorId ? { connectorId, connectorRevision: target?.revision } : {}),
    });
    return this.reopen(owner, id);
  }
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pendingPointers = new Map<
    string,
    { owner: string; value: unknown; moving: boolean; started: boolean; promise: Promise<unknown> }
  >();
  private readonly pointerButtons = new Map<string, number>();
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
    // Any new HTTP/key/control operation is an ordering boundary for pointer merging.
    this.pendingPointers.delete(id);
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
    frameOptions?: { allowMissing?: boolean; tag?: string },
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
          ...(frameOptions?.tag ? { "If-None-Match": frameOptions.tag } : {}),
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
    if (frameOptions?.allowMissing && [304, 404].includes(response.status)) return response;
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new BrowserWorkerError(
        typeof payload?.error?.message === "string"
          ? payload.error.message.split(workerToken).join("[redacted]")
          : "Browser request failed",
        response.status,
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
    frameOptions?: { allowMissing?: boolean; tag?: string },
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
    return this.request(path, body, signal, target, frameOptions);
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
        {
          id,
          url: target,
          ...(value.kind === "desktop" ? { kind: "desktop", desktopMode: value.desktopMode } : {}),
        },
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
  async liveFrame(owner: string, id: string, tag?: string) {
    const response = await this.sessionRequest(
      owner,
      id,
      `/sessions/${id}/frame`,
      undefined,
      undefined,
      { allowMissing: true, tag },
    );
    // Older Host Agents keep working until their package is updated.
    return response.status === 404 ? this.preview(owner, id) : response;
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
      return parsed.type.startsWith("vnc_") || (await this.get(owner, id)).kind === "desktop"
        ? this.decorate(owner, await this.get(owner, id))
        : this.save(owner, payload, id);
    });
  }
  streamInput(owner: string, id: string, value: unknown): Promise<unknown> {
    const event = browserInputSchema.parse(value);
    const pointerKey = `${owner}:${id}`;
    const pointer = event.type === "vnc_mouse" && event.buttons <= 7;
    const moving = pointer && this.pointerButtons.get(pointerKey) === event.buttons;
    if (event.type === "vnc_mouse") this.pointerButtons.set(pointerKey, event.buttons);
    if (event.type === "vnc_reset") this.pointerButtons.delete(pointerKey);
    const previous = this.pendingPointers.get(id);
    if (moving && previous?.owner === owner && previous.moving && !previous.started) {
      previous.value = event;
      return previous.promise;
    }
    const slot = {
      owner,
      value: event as unknown,
      moving,
      started: false,
      promise: undefined as unknown as Promise<unknown>,
    };
    const promise = this.serial(id, async () => {
      slot.started = true;
      const session = await this.get(owner, id);
      if (session.control !== "user")
        throw new AppError("브라우저 제어를 가져온 뒤 조작하세요", 409);
      const parsed = browserInputSchema.parse(slot.value);
      const payload = await (
        await this.sessionRequest(owner, id, `/sessions/${id}/input`, parsed)
      ).json();
      if (!parsed.type.startsWith("vnc_") && session.kind !== "desktop")
        return this.save(owner, payload, id);
      return payload;
    });
    slot.promise = promise;
    if (pointer) this.pendingPointers.set(id, slot);
    void promise
      .finally(() => {
        if (this.pendingPointers.get(id) === slot) this.pendingPointers.delete(id);
      })
      .catch(() => {});
    return promise;
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
