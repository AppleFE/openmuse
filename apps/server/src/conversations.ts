import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type AbstractAgent,
  type BaseEvent,
  compactEvents,
  EventType,
  type Message,
} from "@ag-ui/client";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  finalizeRunEvents,
} from "@copilotkit/runtime/v2";
import { Observable, ReplaySubject } from "rxjs";
import type { ThreadKnowledge } from "../../../packages/domain/src/thread-knowledge.ts";
import { threadNameKey, threadNameSchema } from "../../../packages/domain/src/thread-name.ts";
import type { ChatAttachments } from "./attachments.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

const MAX_THREADS_PER_PAGE = 100;
const MAX_MESSAGES = 1_000;
const MAX_NEW_USER_MESSAGES = 50;
const MAX_USER_MESSAGE_BYTES = 256 * 1024;
const MAX_EVENTS_PER_RUN = 5_000;
const MAX_RUN_BYTES = 8 * 1024 * 1024;
const MAX_THREAD_EVENTS = 20_000;
const MAX_THREAD_BYTES = 16 * 1024 * 1024;
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface ConversationThread {
  id: string;
  name: string | null;
  nameKey?: string | null;
  agentId: string;
  organizationId: "";
  createdById: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  activeRunId: string | null;
  messages: Message[];
  events: BaseEvent[];
  state: Record<string, unknown> | null;
  messageTimes?: Record<string, string>;
  approvalMode?: "review" | "bypass";
  knowledge?: ThreadKnowledge;
}

interface ConversationRun {
  id: string;
  threadId: string;
  runId: string;
  agentId: string;
  status: "running" | "completed" | "stopped" | "failed" | "interrupted";
  events: BaseEvent[];
  messages: Message[];
  state: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

interface ActiveRun {
  owner: string;
  threadId: string;
  runId: string;
  agent: AbstractAgent;
  inputMessages: Message[];
  subject: ReplaySubject<BaseEvent>;
  stopRequested: boolean;
  resolveStop: () => void;
  stopped: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

type OwnerBoundAgent = AbstractAgent & { openMuseOwner?: string };

function assertThreadId(threadId: string) {
  if (!THREAD_ID.test(threadId)) throw new AppError("Invalid conversation thread ID", 422);
}

function nameConflict(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
function duplicateName() {
  return new AppError(
    "이미 사용 중인 대화 이름입니다. 보관함을 포함해 다른 이름을 지정하세요.",
    409,
  );
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function eventState(events: BaseEvent[]): Record<string, unknown> | null {
  const compacted = compactEvents(events);
  for (let index = compacted.length - 1; index >= 0; index--) {
    const event = compacted[index];
    if (event.type !== EventType.STATE_SNAPSHOT) continue;
    const snapshot = event.snapshot;
    return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? { ...snapshot }
      : null;
  }
  return null;
}

function mergeMessages(stored: Message[], incoming: Message[]) {
  const merged = new Map(stored.map((message) => [message.id, message]));
  for (const message of incoming) if (!merged.has(message.id)) merged.set(message.id, message);
  return [...merged.values()].slice(-MAX_MESSAGES);
}

function trustedInputMessages(stored: Message[], incoming: Message[]) {
  const authoritative = new Map(stored.map((message) => [message.id, message]));
  const seen = new Set<string>();
  let newUsers = 0;
  for (const candidate of incoming) {
    if (!candidate || typeof candidate !== "object" || !THREAD_ID.test(candidate.id))
      throw new AppError("Invalid conversation message ID", 422);
    if (seen.has(candidate.id)) throw new AppError("Duplicate conversation message ID", 422);
    seen.add(candidate.id);
    const existing = authoritative.get(candidate.id);
    if (existing) {
      const supplied = candidate as unknown as Record<string, unknown>;
      const canonical = existing as unknown as Record<string, unknown>;
      const fields = ["role", "content", "toolCalls", "toolCallId", "name", "speakerRole"] as const;
      for (const field of fields) {
        if (field in supplied && !isDeepStrictEqual(supplied[field], canonical[field]))
          throw new AppError("Stored conversation history cannot be modified by the client", 422);
      }
      continue;
    }
    if (candidate.role !== "user")
      throw new AppError("Only new user messages may be submitted by the client", 422);
    if (typeof candidate.content !== "string" && !Array.isArray(candidate.content))
      throw new AppError("Invalid user message content", 422);
    if (jsonBytes(candidate.content) > MAX_USER_MESSAGE_BYTES)
      throw new AppError("User message is too large", 413);
    newUsers += 1;
    if (newUsers > MAX_NEW_USER_MESSAGES)
      throw new AppError("Too many new user messages in one run", 413);
    authoritative.set(candidate.id, {
      id: candidate.id,
      role: "user",
      content: structuredClone(candidate.content),
      ...(typeof candidate.name === "string" && candidate.name.length <= 100
        ? { name: candidate.name }
        : {}),
    } as Message);
  }
  return [...authoritative.values()].slice(-MAX_MESSAGES);
}

function trustedInputState(stored: Record<string, unknown> | null, incoming: unknown) {
  if (stored) return structuredClone(stored);
  if (incoming === undefined || incoming === null) return {};
  if (typeof incoming !== "object" || Array.isArray(incoming))
    throw new AppError("Conversation state must be an object", 422);
  if (jsonBytes(incoming) > MAX_USER_MESSAGE_BYTES)
    throw new AppError("Conversation state is too large", 413);
  const copy = structuredClone(incoming) as Record<string, unknown>;
  const stack: unknown[] = [copy];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:__proto__|prototype|constructor|_?openmuse|\$openmuse)$/i.test(key))
        throw new AppError("Conversation state contains a reserved field", 422);
      stack.push(child);
    }
  }
  return copy;
}

function boundedThreadEvents(
  events: BaseEvent[],
  messages?: Message[],
  state?: Record<string, unknown> | null,
) {
  let compacted = compactEvents(events);
  let dropped = false;
  const snapshots = () =>
    messages
      ? ([
          { type: EventType.MESSAGES_SNAPSHOT, messages },
          ...(state ? [{ type: EventType.STATE_SNAPSHOT, snapshot: state }] : []),
        ] as BaseEvent[])
      : [];
  while (
    compacted.length + snapshots().length > MAX_THREAD_EVENTS ||
    jsonBytes([...compacted, ...snapshots()]) > MAX_THREAD_BYTES
  ) {
    dropped = true;
    const nextRun = compacted.findIndex(
      (event, index) => index > 0 && event.type === EventType.RUN_STARTED,
    );
    if (nextRun < 0) {
      if (!compacted.length) break;
      const target = Math.min(
        MAX_THREAD_EVENTS - snapshots().length,
        Math.max(0, Math.floor(compacted.length * 0.75)),
      );
      compacted = target ? compacted.slice(-target) : [];
      continue;
    }
    compacted = compacted.slice(nextRun);
  }
  return dropped ? compactEvents([...compacted, ...snapshots()]) : compacted;
}

function materializeMessages(
  input: Message[],
  events: BaseEvent[],
  retainOnlyInput = false,
): Message[] {
  const messages = new Map(input.map((message) => [message.id, structuredClone(message)]));
  const textStarted = new Set<string>();
  const toolsStarted = new Set<string>();
  for (const baseEvent of events) {
    const event = baseEvent as BaseEvent & {
      messages?: Message[];
      messageId?: string;
      role?: Message["role"];
      name?: string;
      delta?: string;
      parentMessageId?: string;
      toolCallId?: string;
      toolCallName?: string;
      content?: string;
    };
    if (event.type === EventType.MESSAGES_SNAPSHOT) {
      for (const message of event.messages ?? [])
        messages.set(message.id, structuredClone(message));
      continue;
    }
    if (event.type === EventType.TEXT_MESSAGE_START) {
      if (!event.messageId || !event.role) continue;
      if (!textStarted.has(event.messageId)) {
        // Compaction can place a completed tool call before its parent's text
        // start. Keep that call while rebuilding text from the server events.
        messages.set(event.messageId, {
          ...messages.get(event.messageId),
          id: event.messageId,
          role: event.role,
          content: "",
          ...(event.name ? { name: event.name } : {}),
        } as Message);
        textStarted.add(event.messageId);
      }
      continue;
    }
    if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
      if (!event.messageId || typeof event.delta !== "string") continue;
      const current = messages.get(event.messageId);
      if (current && "content" in current && typeof current.content === "string")
        current.content += event.delta;
      continue;
    }
    if (event.type === EventType.TOOL_CALL_START) {
      if (!event.toolCallId || !event.toolCallName) continue;
      let parentId = event.parentMessageId ?? event.toolCallId;
      if (messages.has(parentId) && messages.get(parentId)?.role !== "assistant")
        parentId = event.toolCallId;
      if (!messages.has(parentId))
        messages.set(parentId, { id: parentId, role: "assistant", toolCalls: [] });
      const parent = messages.get(parentId);
      if (parent?.role !== "assistant") continue;
      const assistant = parent as Message & {
        toolCalls?: {
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }[];
      };
      assistant.toolCalls ??= [];
      const call = assistant.toolCalls.find((candidate) => candidate.id === event.toolCallId);
      if (!call)
        assistant.toolCalls.push({
          id: event.toolCallId,
          type: "function",
          function: { name: event.toolCallName, arguments: "" },
        });
      else if (!toolsStarted.has(event.toolCallId)) {
        // The agent's SDK messages already contain the final arguments. Replay
        // each call's deltas once, rather than appending to that finished value.
        call.function = { ...call.function, name: event.toolCallName, arguments: "" };
      }
      toolsStarted.add(event.toolCallId);
      continue;
    }
    if (event.type === EventType.TOOL_CALL_ARGS) {
      if (!event.toolCallId || typeof event.delta !== "string") continue;
      for (const message of messages.values()) {
        if (message.role !== "assistant") continue;
        const call = message.toolCalls?.find((candidate) => candidate.id === event.toolCallId);
        if (call) call.function.arguments += event.delta;
      }
      continue;
    }
    if (
      event.type === EventType.TOOL_CALL_RESULT &&
      event.messageId &&
      event.toolCallId &&
      typeof event.content === "string"
    )
      messages.set(event.messageId, {
        id: event.messageId,
        role: "tool",
        toolCallId: event.toolCallId,
        content: event.content,
        ...(event.role ? { speakerRole: event.role } : {}),
      } as Message);
  }
  // Legacy repair must preserve the retained IDs and order: older bounded
  // events can still refer to messages already evicted from the history.
  const result = retainOnlyInput
    ? input.map((message) => messages.get(message.id) ?? message)
    : [...messages.values()];
  return result.slice(-MAX_MESSAGES);
}

function cursorFor(thread: ConversationThread) {
  return Buffer.from(JSON.stringify([thread.updatedAt, thread.id]), "utf8").toString("base64url");
}

function parseCursor(cursor: string) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string"
    )
      throw new Error("invalid");
    return parsed as [string, string];
  } catch {
    throw new AppError("Invalid conversation cursor", 422);
  }
}

export class ConversationStoreRunner extends AgentRunner {
  readonly ɵsupportsLocalThreadEndpoints = true;
  private readonly active = new Map<string, ActiveRun>();
  private readonly settledListeners = new Set<(owner: string, threadId: string) => void>();

  onSettled(listener: (owner: string, threadId: string) => void) {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  constructor(
    private readonly db: Store,
    private readonly auth: Auth,
    private readonly config: Config,
    private readonly attachments?: ChatAttachments,
  ) {
    super();
  }

  private key(owner: string, threadId: string) {
    return `${owner}\u0000${threadId}`;
  }

  metadata(thread: ConversationThread) {
    const {
      messages: _messages,
      events: _events,
      state: _state,
      nameKey: _nameKey,
      knowledge,
      ...metadata
    } = thread;
    return {
      ...metadata,
      knowledgeSummary: {
        category: knowledge?.category ?? "",
        issue: knowledge?.issue ?? "",
        documentCount: knowledge?.documents.length ?? 0,
        hasNotes: !!knowledge?.notes,
        revision: knowledge?.revision ?? 0,
      },
    };
  }

  /** Backfill legacy names before serving requests; active names take precedence. */
  async prepareNames() {
    const records = (await this.db.scan<ConversationThread>("conversation-threads"))
      .filter(({ value }) => value.name && !value.nameKey)
      .sort(
        (a, b) =>
          Number(a.value.archived) - Number(b.value.archived) ||
          a.value.createdAt.localeCompare(b.value.createdAt) ||
          a.value.id.localeCompare(b.value.id),
      );
    for (const { owner, value } of records) {
      const base =
        Array.from((value.name ?? "").normalize("NFKC"))
          .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
          .join("")
          .trim()
          .replace(/\s+/g, " ") || "새 대화";
      for (let n = 0; ; n++) {
        const name = n
          ? `${base.slice(0, 178)} (${value.id.slice(0, 8)}${n > 1 ? `-${n}` : ""})`
          : base.slice(0, 200);
        try {
          await this.db.compareAndSwap(
            owner,
            "conversation-threads",
            value.id,
            { name: value.name },
            { name, nameKey: threadNameKey(name) },
          );
          break;
        } catch (error) {
          if (!nameConflict(error) || n > 100) throw error;
        }
      }
    }
  }

  async resolveTarget(owner: string, target: string) {
    const byName = target.startsWith("name:");
    if (!byName && THREAD_ID.test(target)) {
      const thread = await this.db.get<ConversationThread>(owner, "conversation-threads", target);
      if (thread) return thread;
    }
    const key = threadNameKey(byName ? target.slice(5) : target);
    const matches = (await this.db.list<ConversationThread>(owner, "conversation-threads")).filter(
      (thread) => thread.name && threadNameKey(thread.name) === key,
    );
    if (matches.length > 1)
      throw new AppError("같은 이름의 대화가 여러 개입니다. 세션 ID를 사용하세요.", 409);
    if (!matches.length) throw new AppError("해당 이름 또는 ID의 대화를 찾을 수 없습니다.", 404);
    return matches[0];
  }

  private async runOwner(agent: OwnerBoundAgent) {
    if (agent.openMuseOwner) return agent.openMuseOwner;
    const headers = (agent as unknown as { headers?: Record<string, string> }).headers;
    return this.auth.owner(headers?.authorization ?? headers?.Authorization);
  }

  private async connectOwner(request: AgentRunnerConnectRequest) {
    return this.auth.owner(request.headers?.authorization ?? request.headers?.Authorization);
  }

  async recoverInterrupted() {
    const now = new Date().toISOString();
    for (const { owner, value } of await this.db.scan<ConversationRun>("conversation-runs")) {
      if (value.status !== "running") continue;
      const events = [...value.events];
      finalizeRunEvents(events, { interruptionMessage: "Server restarted during the run" });
      await this.db.put(owner, "conversation-runs", {
        ...value,
        status: "interrupted",
        events,
        state: eventState(events),
        error: "Server restarted during the run",
        updatedAt: now,
      });
    }
    for (const { owner, value } of await this.db.scan<ConversationThread>("conversation-threads")) {
      if (!value.activeRunId) continue;
      const run = await this.db.get<ConversationRun>(
        owner,
        "conversation-runs",
        `${value.id}:${value.activeRunId}`,
      );
      const combined = [...(value.events ?? []), ...(run?.events ?? [])];
      const state = eventState(combined) ?? value.state;
      const messages = materializeMessages(
        mergeMessages(value.messages, run?.messages ?? []),
        combined,
      );
      const events = boundedThreadEvents(combined, messages, state);
      await this.db.put(owner, "conversation-threads", {
        ...value,
        activeRunId: null,
        messages,
        events,
        state,
        updatedAt: now,
      });
    }
    // Repair the old projection using only durable server events. Client input
    // never participates, and history mutation checks remain strict.
    for (const { owner, value } of await this.db.scan<ConversationThread>("conversation-threads")) {
      if (value.activeRunId || !value.events?.length) continue;
      const messages = materializeMessages(value.messages, value.events, true);
      if (!isDeepStrictEqual(messages, value.messages))
        await this.db.compareAndSwap<ConversationThread>(
          owner,
          "conversation-threads",
          value.id,
          { activeRunId: null, updatedAt: value.updatedAt },
          { messages },
        );
    }
  }

  async ensure(owner: string, threadId: string = randomUUID(), agentId = "default") {
    assertThreadId(threadId);
    const now = new Date().toISOString();
    await this.db.insertIfAbsent(owner, "conversation-threads", {
      id: threadId,
      name: null,
      agentId,
      organizationId: "" as const,
      createdById: owner,
      archived: false,
      approvalMode: "review" as const,
      createdAt: now,
      updatedAt: now,
      activeRunId: null,
      messages: [] as Message[],
      events: [] as BaseEvent[],
      state: null,
    });
    const thread = await this.db.get<ConversationThread>(owner, "conversation-threads", threadId);
    if (!thread) throw new AppError("Conversation could not be created", 503);
    return thread;
  }

  async create(owner: string, input: { id?: string; name?: string; agentId?: string }) {
    const id = input.id ?? randomUUID();
    assertThreadId(id);
    const existing = await this.db.get(owner, "conversation-threads", id);
    if (existing) throw new AppError("Conversation already exists", 409);
    const name = threadNameSchema.parse(input.name ?? `새 대화 (${id.slice(0, 8)})`);
    const now = new Date().toISOString();
    try {
      const thread = await this.db.insertIfAbsent<ConversationThread>(
        owner,
        "conversation-threads",
        {
          id,
          name,
          nameKey: threadNameKey(name),
          agentId: input.agentId ?? "default",
          organizationId: "",
          createdById: owner,
          archived: false,
          approvalMode: "review",
          createdAt: now,
          updatedAt: now,
          activeRunId: null,
          messages: [],
          events: [],
          state: null,
        },
      );
      if (!thread) throw new AppError("Conversation already exists", 409);
      return thread;
    } catch (error) {
      if (nameConflict(error)) throw duplicateName();
      throw error;
    }
  }

  async get(owner: string, threadId: string) {
    assertThreadId(threadId);
    const thread = await this.db.get<ConversationThread>(owner, "conversation-threads", threadId);
    if (!thread) throw new AppError("Conversation not found", 404);
    return thread;
  }

  async list(
    owner: string,
    options: {
      agentId?: string;
      includeArchived?: boolean;
      archived?: boolean;
      limit?: number;
      cursor?: string;
      query?: string;
    },
  ) {
    const limit = Math.min(MAX_THREADS_PER_PAGE, Math.max(1, options.limit ?? 50));
    const query = options.query?.toLocaleLowerCase();
    let threads = (await this.db.list<ConversationThread>(owner, "conversation-threads"))
      .filter((thread) => !options.agentId || thread.agentId === options.agentId)
      .filter((thread) => options.includeArchived || !thread.archived)
      .filter((thread) => options.archived === undefined || thread.archived === options.archived)
      .filter(
        (thread) =>
          !query ||
          [thread.name, thread.knowledge?.category, thread.knowledge?.issue].some((value) =>
            value?.toLocaleLowerCase().includes(query),
          ),
      )
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
      );
    if (options.cursor) {
      const [updatedAt, id] = parseCursor(options.cursor);
      const index = threads.findIndex(
        (thread) => thread.updatedAt === updatedAt && thread.id === id,
      );
      if (index < 0) throw new AppError("Conversation cursor is no longer available", 409);
      threads = threads.slice(index + 1);
    }
    const page = threads.slice(0, limit);
    const last = page.at(-1);
    return {
      threads: page.map((thread) => this.metadata(thread)),
      nextCursor: threads.length > limit && last ? cursorFor(last) : null,
    };
  }

  async rename(owner: string, threadId: string, name: string | null) {
    const thread = await this.get(owner, threadId);
    name = threadNameSchema.parse(name);
    try {
      const updated = await this.db.compareAndSwap<ConversationThread>(
        owner,
        "conversation-threads",
        threadId,
        { archived: thread.archived },
        { name, nameKey: threadNameKey(name), updatedAt: new Date().toISOString() },
      );
      if (!updated) throw new AppError("Conversation changed; refresh and try again", 409);
      return updated;
    } catch (error) {
      if (nameConflict(error)) throw duplicateName();
      throw error;
    }
  }

  async setApprovalMode(owner: string, threadId: string, mode: "review" | "bypass") {
    const thread = await this.get(owner, threadId);
    if (thread.archived) throw new AppError("보관된 대화의 승인 설정은 변경할 수 없습니다", 409);
    if (thread.activeRunId) throw new AppError("현재 응답이 끝난 뒤 승인 설정을 변경하세요", 409);
    const saved = await this.db.compareAndSwap<ConversationThread>(
      owner,
      "conversation-threads",
      threadId,
      { activeRunId: null, archived: false },
      { approvalMode: mode, updatedAt: new Date().toISOString() },
    );
    if (!saved) throw new AppError("대화 상태가 변경되었습니다. 다시 시도하세요", 409);
    return saved;
  }
  async setArchived(owner: string, threadId: string, archived: boolean) {
    const thread = await this.get(owner, threadId);
    if (thread.activeRunId) throw new AppError("Stop the active run before archiving", 409);
    if (thread.archived === archived) return thread;
    const updated = await this.db.compareAndSwap<ConversationThread>(
      owner,
      "conversation-threads",
      threadId,
      { archived: !archived, activeRunId: null },
      { archived, updatedAt: new Date().toISOString() },
    );
    if (!updated) throw new AppError("Conversation changed; refresh and try again", 409);
    return updated;
  }

  async remove(owner: string, threadId: string) {
    await this.get(owner, threadId);
    if (!(await this.db.removeIdleConversation(owner, threadId)))
      throw new AppError("Stop the active run before deleting", 409);
    for (const file of (await this.attachments?.list(owner, threadId)) ?? [])
      await this.attachments?.remove(owner, file.id);
    const sessionKey = `chat:${threadId}`;
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    await this.db.remove(owner, "pi-agent-sessions", digest(sessionKey));
    for (const run of await this.db.list<{ id: string; sessionKey: string }>(
      owner,
      "pi-agent-runs",
    ))
      if (run.sessionKey === sessionKey) await this.db.remove(owner, "pi-agent-runs", run.id);
    for (const linked of await this.db.list<{ id: string }>(owner, "chat-browsers"))
      if (linked.id === threadId || linked.id.startsWith(`${threadId}:`))
        await this.db.remove(owner, "chat-browsers", linked.id);
    // Both path segments are cryptographic digests, never user-controlled filesystem paths.
    await rm(
      join(this.config.dataDir, "pi", "sessions", digest(owner).slice(0, 24), digest(sessionKey)),
      { recursive: true, force: true },
    );
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    void this.startRun(request, subject);
    return subject.asObservable();
  }

  private async startRun(request: AgentRunnerRunRequest, subject: ReplaySubject<BaseEvent>) {
    let owner = "";
    let active: ActiveRun | undefined;
    const events: BaseEvent[] = [];
    let messages: Message[] = [];
    let writeChain = Promise.resolve();
    let runRecord: ConversationRun | undefined;
    let claimed = false;
    let priorEvents: BaseEvent[] = [];
    try {
      assertThreadId(request.threadId);
      owner = await this.runOwner(request.agent as OwnerBoundAgent);
      const thread = await this.ensure(owner, request.threadId, request.agent.agentId ?? "default");
      if (thread.archived) throw new AppError("Restore this conversation before running it", 409);
      const claimedThread = await this.db.compareAndSwap<ConversationThread>(
        owner,
        "conversation-threads",
        request.threadId,
        { archived: false, activeRunId: null },
        { activeRunId: request.input.runId, updatedAt: new Date().toISOString() },
      );
      if (!claimedThread) throw new AppError("Conversation already has an active run", 409);
      claimed = true;
      priorEvents = thread.events ?? [];

      messages = trustedInputMessages(thread.messages ?? [], request.input.messages ?? []);
      const storedIds = new Set(thread.messages.map((message) => message.id));
      await this.attachments?.validate(
        owner,
        request.threadId,
        messages.filter((message) => !storedIds.has(message.id)),
      );
      const messageTimes = { ...(thread.messageTimes ?? {}) };
      for (const message of messages) messageTimes[message.id] ??= new Date().toISOString();
      await this.db.compareAndSwap(
        owner,
        "conversation-threads",
        request.threadId,
        { activeRunId: request.input.runId },
        { messageTimes },
      );
      if (jsonBytes(messages) > MAX_RUN_BYTES)
        throw new AppError("Conversation history is too large; start a new conversation", 413);
      const state = trustedInputState(thread.state, request.input.state);
      request.agent.setMessages(messages);
      request.input = { ...request.input, messages, state };
      const now = new Date().toISOString();
      runRecord = {
        id: `${request.threadId}:${request.input.runId}`,
        threadId: request.threadId,
        runId: request.input.runId,
        agentId: request.agent.agentId ?? "default",
        status: "running",
        events,
        messages,
        state,
        createdAt: now,
        updatedAt: now,
      };
      await this.db.put(owner, "conversation-runs", runRecord);

      let resolveStop = () => {};
      const stopped = new Promise<void>((resolve) => {
        resolveStop = resolve;
      });
      const timer = setTimeout(
        () => {
          const current = this.active.get(this.key(owner, request.threadId));
          if (!current || current.runId !== request.input.runId) return;
          current.stopRequested = true;
          try {
            request.agent.abortRun();
          } catch (error) {
            console.error("Failed to abort timed-out conversation run", error);
          } finally {
            current.resolveStop();
          }
        },
        this.config.chatRunTimeoutMs ?? 10 * 60 * 1000,
      );
      active = {
        owner,
        threadId: request.threadId,
        runId: request.input.runId,
        agent: request.agent,
        inputMessages: structuredClone(messages),
        subject,
        stopRequested: false,
        resolveStop,
        stopped,
        timer,
      };
      this.active.set(this.key(owner, request.threadId), active);

      const checkpoint = () => {
        if (!runRecord) return;
        const snapshot: ConversationRun = {
          ...runRecord,
          events: [...events],
          messages: materializeMessages(messages, events),
          state: eventState(events),
          updatedAt: new Date().toISOString(),
        };
        writeChain = writeChain.then(async () => {
          await this.db.put(owner, "conversation-runs", snapshot);
        });
      };

      await Promise.race([
        request.agent.runAgent(request.input, {
          onEvent: ({ event }) => {
            if (event.type === EventType.TEXT_MESSAGE_START) {
              const messageId = String((event as { messageId?: string }).messageId ?? "");
              if (messageId && !messageTimes[messageId]) {
                messageTimes[messageId] = new Date().toISOString();
                const snapshot = { ...messageTimes };
                writeChain = writeChain.then(async () => {
                  await this.db.compareAndSwap(
                    owner,
                    "conversation-threads",
                    request.threadId,
                    { activeRunId: request.input.runId },
                    { messageTimes: snapshot },
                  );
                });
              }
            }
            if (events.length >= MAX_EVENTS_PER_RUN || jsonBytes(events) >= MAX_RUN_BYTES) {
              if (active) {
                active.stopRequested = true;
                active.resolveStop();
              }
              request.agent.abortRun();
              return;
            }
            events.push(event);
            subject.next(event);
            if (event.type === EventType.RUN_STARTED) {
              // Another client or a host report can have extended this chat.
              // Hydrate after RUN_STARTED (required by AG-UI), before the reply,
              // without duplicating full history in every durable event log.
              subject.next({
                type: EventType.MESSAGES_SNAPSHOT,
                messages: structuredClone(messages),
              });
            }
            checkpoint();
          },
        }),
        active.stopped,
      ]);
      await this.finalize(
        owner,
        request,
        priorEvents,
        events,
        messages,
        runRecord,
        active,
        writeChain,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runRecord && active)
        await this.finalize(
          owner,
          request,
          priorEvents,
          events,
          messages,
          runRecord,
          active,
          writeChain,
          message,
        );
      else {
        if (claimed)
          await this.db.compareAndSwap<ConversationThread>(
            owner,
            "conversation-threads",
            request.threadId,
            { activeRunId: request.input.runId },
            { activeRunId: null, updatedAt: new Date().toISOString() },
          );
        subject.next({ type: EventType.RUN_ERROR, message });
        subject.complete();
      }
    }
  }

  private async finalize(
    owner: string,
    request: AgentRunnerRunRequest,
    priorEvents: BaseEvent[],
    events: BaseEvent[],
    inputMessages: Message[],
    run: ConversationRun,
    active: ActiveRun,
    writeChain: Promise<void>,
    error?: string,
  ) {
    clearTimeout(active.timer);
    const stopped = active.stopRequested;
    const appended = finalizeRunEvents(events, {
      stopRequested: stopped,
      ...(error && !stopped ? { interruptionMessage: error } : {}),
    });
    for (const event of appended) subjectNext(active.subject, event);
    await writeChain;
    const compacted = compactEvents(events);
    const allThreadEvents = compactEvents([...priorEvents, ...compacted]);
    const agentMessages = Array.isArray(request.agent.messages) ? request.agent.messages : [];
    const messages = materializeMessages(mergeMessages(inputMessages, agentMessages), compacted);
    const now = new Date().toISOString();
    const state = eventState(allThreadEvents) ?? run.state;
    const threadEvents = boundedThreadEvents(allThreadEvents, messages, state);
    const status = stopped ? "stopped" : error ? "failed" : "completed";
    await this.db.put(owner, "conversation-runs", {
      ...run,
      status,
      events: compacted,
      messages,
      state,
      updatedAt: now,
      ...(error ? { error } : {}),
    });
    await this.db.compareAndSwap<ConversationThread>(
      owner,
      "conversation-threads",
      request.threadId,
      { activeRunId: request.input.runId },
      { activeRunId: null, events: threadEvents, messages, state, updatedAt: now },
    );
    const key = this.key(owner, request.threadId);
    if (this.active.get(key)?.runId === request.input.runId) this.active.delete(key);
    active.subject.complete();
    for (const listener of this.settledListeners) listener(owner, request.threadId);
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      let liveSubscription: { unsubscribe(): void } | undefined;
      void (async () => {
        const owner = await this.connectOwner(request);
        assertThreadId(request.threadId);
        const thread = await this.db.get<ConversationThread>(
          owner,
          "conversation-threads",
          request.threadId,
        );
        if (!thread) {
          subscriber.complete();
          return;
        }
        const active = this.active.get(this.key(owner, request.threadId));
        // Restore the authoritative messages in a read-only protocol run.
        // Replaying only text events omits user submissions, and replaying
        // deltas over a full snapshot would duplicate assistant output.
        const runId = randomUUID();
        subscriber.next({ type: EventType.RUN_STARTED, threadId: thread.id, runId });
        subscriber.next({
          type: EventType.MESSAGES_SNAPSHOT,
          messages: structuredClone(active?.inputMessages ?? thread.messages),
        });
        if (thread.state)
          subscriber.next({
            type: EventType.STATE_SNAPSHOT,
            snapshot: structuredClone(thread.state),
          });
        subscriber.next({ type: EventType.RUN_FINISHED, threadId: thread.id, runId });
        if (!active) {
          subscriber.complete();
          return;
        }
        liveSubscription = active.subject.subscribe({
          next: (event) => subscriber.next(event),
          error: (error) => subscriber.error(error),
          complete: () => subscriber.complete(),
        });
      })().catch((error) => subscriber.error(error));
      return () => liveSubscription?.unsubscribe();
    });
  }

  async runStatus(owner: string, threadId: string, runId: string) {
    await this.get(owner, threadId);
    assertThreadId(runId);
    const run = await this.db.get<ConversationRun>(
      owner,
      "conversation-runs",
      `${threadId}:${runId}`,
    );
    if (!run)
      throw new AppError(
        "서버에서 이 요청의 실행 기록을 찾을 수 없습니다. 대화를 다시 열어 확인하세요.",
        404,
      );
    const failed = run.events.findLast((event) => event.type === EventType.RUN_ERROR);
    return {
      status:
        run.status === "completed" && failed
          ? failed.code === "abort"
            ? "stopped"
            : "failed"
          : run.status,
      ...(run.error || failed?.message ? { error: run.error || String(failed?.message) } : {}),
    };
  }

  async isRunning(request: { threadId: string }) {
    return [...this.active.values()].some((active) => active.threadId === request.threadId);
  }

  async stop(request: AgentRunnerStopRequest) {
    const candidates = [...this.active.values()].filter(
      (active) =>
        active.threadId === request.threadId &&
        (request.runId === undefined || active.runId === request.runId),
    );
    if (candidates.length !== 1) return false;
    return this.stopActive(candidates[0]);
  }

  async stopOwner(owner: string, threadId: string, runId?: string) {
    assertThreadId(threadId);
    const active = this.active.get(this.key(owner, threadId));
    if (!active || (runId !== undefined && active.runId !== runId)) return false;
    return this.stopActive(active);
  }

  private stopActive(active: ActiveRun) {
    if (active.stopRequested) return false;
    active.stopRequested = true;
    try {
      active.agent.abortRun();
      active.resolveStop();
      return true;
    } catch {
      active.stopRequested = false;
      return false;
    }
  }
}

function subjectNext(subject: ReplaySubject<BaseEvent>, event: BaseEvent) {
  subject.next(event);
}
