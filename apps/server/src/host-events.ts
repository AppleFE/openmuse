import { createHash, randomUUID } from "node:crypto";
import { AbstractAgent, type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import { Hono } from "hono";
import { Observable } from "rxjs";
import {
  type HostEvent,
  hostEventInputSchema,
  hostEventMessage,
} from "../../../packages/domain/src/host-events.ts";
import type { ConnectorService } from "./connector-service.ts";
import type { ConversationStoreRunner } from "./conversations.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";
import { backgroundFailure } from "./log.ts";

const kind = "host-events";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
class ReportOnlyAgent extends AbstractAgent {
  constructor(readonly openMuseOwner: string) {
    super({ agentId: "default" });
  }
  clone() {
    return new ReportOnlyAgent(this.openMuseOwner);
  }
  run(input: RunAgentInput) {
    return new Observable<BaseEvent>((s) => {
      s.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
      s.next({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
      s.complete();
    });
  }
}

/** Push-driven durable inbox. No remote process polling; busy chats resume on runner completion. */
export class HostEventService {
  private readonly draining = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private readonly listeners = new Map<string, Set<(event: HostEvent) => void>>();
  private readonly closeListeners = new Set<() => void>();
  private readonly rate = new Map<string, { since: number; count: number }>();
  private unsubscribe: () => void;
  private closed = false;
  constructor(
    private readonly db: Store,
    private readonly connectors: ConnectorService,
    private readonly conversations: ConversationStoreRunner,
    private readonly makeAgent: (owner: string) => Promise<AbstractAgent>,
  ) {
    this.unsubscribe = conversations.onSettled((owner, thread) => this.wake(owner, thread));
  }
  async recover() {
    for (const { owner, value } of await this.db.scan<HostEvent>(kind)) {
      if (value.status === "running") {
        const run = await this.db.get<{ status: string; events: BaseEvent[] }>(
          owner,
          "conversation-runs",
          `${value.threadId}:${value.runId}`,
        );
        const complete =
          run?.status === "completed" && !run.events.some((e) => e.type === EventType.RUN_ERROR);
        await this.update(owner, value, {
          status: complete ? "delivered" : "interrupted",
          ...(complete
            ? {}
            : { error: "서버가 재시작되어 응답이 중단되었습니다. 대화 기록을 확인하세요." }),
        });
      }
    }
    for (const { owner, value } of await this.db.scan<HostEvent>(kind))
      if (value.status === "queued") this.wake(owner, value.threadId);
  }
  subscribe(owner: string, listener: (event: HostEvent) => void, onClose?: () => void) {
    let set = this.listeners.get(owner);
    if (!set) {
      set = new Set();
      this.listeners.set(owner, set);
    }
    set.add(listener);
    if (onClose) this.closeListeners.add(onClose);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(owner);
      if (onClose) this.closeListeners.delete(onClose);
    };
  }
  private publish(owner: string, event: HostEvent) {
    for (const listener of this.listeners.get(owner) ?? []) listener(event);
  }
  async list(owner: string) {
    return (await this.db.list<HostEvent>(owner, kind))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, 100);
  }
  async get(owner: string, id: string, connectorId?: string) {
    const event = await this.db.get<HostEvent>(owner, kind, id);
    if (!event || (connectorId && event.connectorId !== connectorId))
      throw new AppError("호스트 보고를 찾을 수 없습니다", 404);
    return event;
  }
  async accept(
    owner: string,
    connector: { id: string; name: string },
    raw: unknown,
  ): Promise<{ event: HostEvent; duplicate: boolean }> {
    const input = hostEventInputSchema.parse(raw),
      id = hash(`${connector.id}\0${input.key}`);
    const old = await this.db.get<HostEvent>(owner, kind, id);
    if (old) {
      if (JSON.stringify(hostEventInputSchema.parse(oldInput(old))) !== JSON.stringify(input))
        throw new AppError("같은 중복 방지 키에 다른 보고가 등록되어 있습니다", 409);
      return { event: old, duplicate: true };
    }
    const current = this.rate.get(connector.id),
      now = Date.now();
    const window = current && now - current.since < 60000 ? current : { since: now, count: 0 };
    this.rate.set(connector.id, window);
    if (++window.count > 30)
      throw new AppError("보고는 호스트별 분당 30건까지 보낼 수 있습니다", 429);
    // An installed, reachable Host Agent must prove possession of the registered credential.
    await this.connectors.run(owner, connector.id, "host_status", {});
    const records = await this.db.list<HostEvent>(owner, kind);
    if (
      records.filter(
        (e) => e.connectorId === connector.id && ["queued", "running"].includes(e.status),
      ).length >= 100
    )
      throw new AppError("이 호스트의 대기 보고가 가득 찼습니다", 429);
    let threadId = input.target;
    if (input.target === "main") {
      await this.db.insertIfAbsent(owner, "conversation-settings", {
        id: "main",
        threadId: randomUUID(),
      });
      threadId = (await this.db.get<{ threadId: string }>(owner, "conversation-settings", "main"))!
        .threadId;
      await this.conversations.ensure(owner, threadId);
    } else if (input.target === "host") {
      threadId = `host-${connector.id}`;
      const thread = await this.conversations.ensure(owner, threadId);
      if (!thread.name)
        await this.conversations.rename(
          owner,
          threadId,
          `${connector.name.slice(0, 170)} 보고 (${connector.id.slice(0, 8)})`,
        );
    } else {
      threadId = (await this.conversations.resolveTarget(owner, input.target)).id;
    }
    const thread = await this.conversations.get(owner, threadId);
    if (thread.archived)
      throw new AppError("보관된 대화에는 보고를 보낼 수 없습니다. 대화를 복원하세요", 409);
    const event: HostEvent = {
      ...input,
      id,
      connectorId: connector.id,
      hostName: connector.name,
      threadId,
      messageId: `host-report-${id}`,
      runId: randomUUID(),
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const inserted = await this.db.insertIfAbsent(owner, kind, event);
    if (!inserted) return this.accept(owner, connector, input);
    this.publish(owner, event);
    this.wake(owner, threadId);
    const terminal = records
      .filter((e) => !["queued", "running"].includes(e.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const expired of terminal.slice(999)) await this.db.remove(owner, kind, expired.id);
    return { event, duplicate: false };
  }
  private async update(owner: string, event: HostEvent, patch: Partial<HostEvent>) {
    const saved = await this.db.compareAndSwap<HostEvent>(
      owner,
      kind,
      event.id,
      { status: event.status },
      { ...patch, updatedAt: new Date().toISOString() },
    );
    if (saved) this.publish(owner, saved);
    return saved;
  }
  wake(owner: string, threadId: string) {
    if (this.closed) return;
    const key = `${owner}\0${threadId}`;
    if (this.draining.has(key)) {
      this.dirty.add(key);
      return;
    }
    const job = this.drain(owner, threadId)
      .catch((e) => backgroundFailure("host event delivery", e))
      .finally(() => {
        this.draining.delete(key);
        if (this.dirty.delete(key)) this.wake(owner, threadId);
      });
    this.draining.set(key, job);
  }
  private async drain(owner: string, threadId: string) {
    while (!this.closed) {
      const event = (await this.db.list<HostEvent>(owner, kind))
        .filter((e) => e.threadId === threadId && e.status === "queued")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
      if (!event) return;
      try {
        const thread = await this.conversations.get(owner, threadId);
        if (thread.activeRunId) return;
        if (thread.archived) throw new AppError("대화가 보관되어 보고 전달을 중단했습니다", 409);
        const host = await this.connectors.get(owner, event.connectorId);
        if (
          host.provider !== "remote_host" ||
          (host.config.mode ?? "agent") !== "agent" ||
          !host.hasSecret
        )
          throw new AppError("Host Agent 연결이 해제되었습니다", 409);
        const agent = event.reply ? await this.makeAgent(owner) : new ReportOnlyAgent(owner);
        const running = await this.update(owner, event, { status: "running" });
        if (!running) continue;
        let error: string | undefined;
        await new Promise<void>((resolve) => {
          this.conversations
            .run({
              threadId,
              agent,
              input: {
                threadId,
                runId: event.runId,
                messages: [
                  {
                    id: event.messageId,
                    role: "user",
                    name: `원격 · ${event.hostName} · ${event.source}`.slice(0, 100),
                    content: hostEventMessage(event),
                  },
                ],
                state: {},
                tools: [],
                context: [],
                forwardedProps: {},
              },
            })
            .subscribe({
              next: (e) => {
                if (e.type === EventType.RUN_ERROR) error = String(e.message);
                if (e.type === EventType.RUN_STARTED)
                  this.publish(owner, { ...running, updatedAt: new Date().toISOString() });
              },
              error: (e) => {
                error = e instanceof Error ? e.message : "보고 응답 실패";
                resolve();
              },
              complete: resolve,
            });
        });
        if (error === "Conversation already has an active run") {
          await this.update(owner, running, { status: "queued" });
          return;
        }
        const run = await this.db.get<{ status: string }>(
          owner,
          "conversation-runs",
          `${threadId}:${event.runId}`,
        );
        const stopped = run?.status === "stopped";
        await this.update(owner, running, {
          status: stopped ? "interrupted" : error ? "failed" : "delivered",
          ...(error || stopped
            ? { error: error ?? "AI 응답이 중지되었습니다. 대화 기록을 확인하세요." }
            : {}),
        });
      } catch (e) {
        const latest = await this.get(owner, event.id);
        await this.update(owner, latest, {
          status: "failed",
          error: e instanceof Error ? e.message : "보고 전달 실패",
        });
      }
    }
  }
  close() {
    this.closed = true;
    this.unsubscribe();
    for (const close of this.closeListeners) close();
    this.closeListeners.clear();
    this.listeners.clear();
  }
}
function oldInput(e: HostEvent) {
  return {
    key: e.key,
    target: e.target,
    type: e.type,
    source: e.source,
    task: e.task,
    message: e.message,
    reply: e.reply,
  };
}

export function hostEventRoutes(service: HostEventService) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) => c.json({ events: await service.list(c.get("owner")) }));
  app.get("/stream", (c) => {
    const encoder = new TextEncoder(),
      owner = c.get("owner");
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          cleanup();
          try {
            controller.close();
          } catch {}
        };
        const send = (value: unknown) => {
          if (closed) return;
          if ((controller.desiredSize ?? 0) < -50) return close();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
        };
        const unsubscribe = service.subscribe(owner, (event) => send({ event }), close);
        const heartbeat = setInterval(() => send({ heartbeat: true }), 20000);
        const expiry = setTimeout(close, 15 * 60000);
        cleanup = () => {
          unsubscribe();
          clearInterval(heartbeat);
          clearTimeout(expiry);
          c.req.raw.signal.removeEventListener("abort", close);
        };
        c.req.raw.signal.addEventListener("abort", close, { once: true });
        void service
          .list(owner)
          .then((events) => send({ events }))
          .catch(close);
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  });
  return app;
}
