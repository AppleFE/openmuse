import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition as CopilotToolDefinition } from "@copilotkit/runtime/v2";
import {
  type AgentSessionEvent,
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelProfile } from "../../../../packages/domain/src/agent.ts";
import type { AttachmentImage } from "../attachments.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { Skills } from "../skills.ts";
import { type UsageRecord, UsageService } from "../usage.ts";
import type { JevRuntime } from "./jev-runtime.ts";
import { type PiHostReport, syncPiHostReports } from "./pi-host-reports.ts";
import { configuredPiModel, emptyResourceLoader } from "./pi-runtime.ts";
import { adaptCopilotTools } from "./pi-tools.ts";
import type { RoleRuntimeRequest } from "./runtime-hooks.ts";

interface PiAgentCheckpoint {
  id: string;
  sessionKey: string;
  sessionFile?: string;
  iteration: number;
  toolCalls: number;
  status: "running" | "succeeded" | "failed" | "cancelled";
  output?: string;
  error?: string;
  updatedAt: string;
}

export interface PiAgentSession {
  sessionFile?: string;
  prompt(text: string, options?: { images?: AttachmentImage[] }): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  getLastAssistantText(): string | undefined;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}

export interface PiAgentSessionInput {
  request: RoleRuntimeRequest;
  systemPrompt: string;
  sessionDir: string;
  cwd: string;
  sessionFile?: string;
  hostReports?: readonly PiHostReport[];
  tools: readonly CopilotToolDefinition[];
  maxToolCalls: number;
  onToolCall(): number | Promise<number>;
  abortTools?(): void;
  onPolicyFallback(): void;
}

export type PiAgentSessionFactory = (input: PiAgentSessionInput) => Promise<PiAgentSession>;

export interface PiAgentRunCallbacks {
  onUsage?(usage: Omit<UsageRecord, "id">): void;
  onTextDelta?(delta: string): void;
  onToolStart?(id: string, name: string, args: unknown): void;
  onToolEnd?(id: string, name: string, result: unknown, isError: boolean): void;
}

export interface PiAgentRunInput extends PiAgentRunCallbacks {
  owner: string;
  profile: ModelProfile;
  request: RoleRuntimeRequest;
  sessionKey: string;
  runKey: string;
  systemPrompt: string;
  prompt: string;
  images?: AttachmentImage[];
  hostReports?: readonly PiHostReport[];
  tools: readonly CopilotToolDefinition[];
  abortTools?(): void;
  completion?: {
    isTerminal(): boolean;
    retryPrompt: string;
  };
}

const clipped = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max)}\n[truncated by runtime limit]`;

/** Shared embedded-pi runner for team roles, delegated tasks, and conversational tools. */
export class PiAgentRunner {
  private readonly sessionFactory: PiAgentSessionFactory;

  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly jev: JevRuntime,
    sessionFactory?: PiAgentSessionFactory,
  ) {
    this.sessionFactory = sessionFactory ?? ((input) => this.createSession(input));
  }

  async supports(owner: string, profile: ModelProfile) {
    return (
      profile.available &&
      profile.capabilities.includes("coding") &&
      (await this.jev.settings.resolve(owner)).pi.enabled
    );
  }

  async run(input: PiAgentRunInput): Promise<string> {
    const settings = await this.jev.settings.resolve(input.owner);
    if (!settings.pi.enabled) throw new Error("Embedded pi is disabled");
    if (!input.profile.capabilities.includes("coding"))
      throw new Error("The selected model is not configured for coding/tool execution");
    const timeout = AbortSignal.timeout(settings.pi.timeoutMs);
    const signal = AbortSignal.any([input.request.signal, timeout]);
    const runtimeRequest = { ...input.request, signal };
    if (signal.aborted) throw new Error("Task interrupted");

    let localBudget = false;
    if (settings.jev.enabled) {
      const preflight = await this.jev.guard(runtimeRequest);
      if (
        preflight.value !== "allow" ||
        (!preflight.fallback && (preflight.confidence ?? 0) < 0.55)
      )
        throw new Error("Jev blocked this run before model execution");
      localBudget ||= preflight.fallback;
    }
    const diet = await this.jev.contextProfile(runtimeRequest);
    localBudget ||= diet.fallback;
    const contextProfile = localBudget ? "minimal" : diet.value;
    const hardIterations = localBudget ? 1 : settings.pi.maxIterations;
    const checkpointId = createHash("sha256").update(input.runKey).digest("hex");
    const sessionId = createHash("sha256").update(input.sessionKey).digest("hex");
    const existing = await this.db.get<PiAgentCheckpoint>(
      input.owner,
      "pi-agent-runs",
      checkpointId,
    );
    if (
      existing?.status === "succeeded" &&
      existing.output &&
      (!input.completion || input.completion.isTerminal())
    )
      return existing.output;
    const durableSession = await this.db.get<{ id: string; sessionFile?: string }>(
      input.owner,
      "pi-agent-sessions",
      sessionId,
    );
    const ownerHash = createHash("sha256").update(input.owner).digest("hex").slice(0, 24);
    const cwd = join(this.config.dataDir, "pi", "empty-workspace", ownerHash);
    const sessionDir = join(this.config.dataDir, "pi", "sessions", ownerHash, sessionId);
    await Promise.all([
      mkdir(cwd, { recursive: true, mode: 0o700 }),
      mkdir(sessionDir, { recursive: true, mode: 0o700 }),
    ]);

    let toolCalls = existing?.toolCalls ?? 0;
    let iteration = existing?.iteration ?? 0;
    let output = existing?.output ?? "";
    let toolCheckpoint = Promise.resolve();
    let session: PiAgentSession;
    session = await this.sessionFactory({
      request: runtimeRequest,
      systemPrompt: input.systemPrompt,
      sessionDir,
      cwd,
      sessionFile: existing?.sessionFile ?? durableSession?.sessionFile,
      hostReports: input.hostReports,
      tools: input.tools,
      maxToolCalls:
        localBudget || (settings.jev.enabled && settings.jev.failMode === "local-budget") ? 4 : 32,
      onToolCall: async () => {
        const count = ++toolCalls;
        toolCheckpoint = toolCheckpoint.then(() =>
          this.persist(input.owner, {
            id: checkpointId,
            sessionKey: input.sessionKey,
            sessionFile: session?.sessionFile,
            iteration,
            toolCalls: count,
            status: "running",
            output,
            updatedAt: new Date().toISOString(),
          }),
        );
        await toolCheckpoint;
        return count;
      },
      abortTools: input.abortTools,
      onPolicyFallback: () => {
        localBudget = true;
      },
    });
    let usageWrites = Promise.resolve();
    let generationStart = Date.now(),
      firstTokenAt = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") {
        generationStart = Date.now();
        firstTokenAt = 0;
      }
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta" &&
        !firstTokenAt
      )
        firstTokenAt = Date.now();
      if (event.type === "message_end" && event.message.role === "assistant") {
        const message = event.message;
        const usage = message.usage;
        const value = {
          threadId: input.sessionKey.startsWith("chat:") ? input.sessionKey.slice(5) : null,
          modelId: input.profile.id,
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          totalTokens:
            usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
          reported:
            (usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite) >
            0,
          durationMs: Math.max(1, Date.now() - (firstTokenAt || generationStart)),
          createdAt: new Date().toISOString(),
        };
        const messageKey = `${input.runKey}:${message.timestamp}:${createHash("sha256").update(JSON.stringify(message.content)).digest("hex")}`;
        usageWrites = usageWrites
          .then(() => new UsageService(this.db).record(input.owner, messageKey, value))
          .then(() => {});
        input.onUsage?.(value);
      }
      this.forwardEvent(event, input);
    });
    const abort = () => {
      input.abortTools?.();
      void session.abort();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();

    try {
      await this.persist(input.owner, {
        id: checkpointId,
        sessionKey: input.sessionKey,
        sessionFile: session.sessionFile,
        iteration,
        toolCalls,
        status: "running",
        output,
        updatedAt: new Date().toISOString(),
      });
      while (iteration < hardIterations) {
        if (signal.aborted)
          throw new Error(timeout.aborted ? "Embedded pi timed out" : "Task interrupted");
        await session.prompt(
          iteration === 0 && !existing
            ? clipped(input.prompt, contextProfile === "full" ? 24000 : 12000)
            : existing?.iteration === 0 && iteration === 0
              ? `Recover this interrupted run from its durable session without repeating completed side effects. Original bounded request:\n\n${clipped(input.prompt, contextProfile === "full" ? 24000 : 12000)}`
              : (input.completion?.retryPrompt ??
                "Continue from the durable session. Use the registered tools required by the request, then finish or verify the result without repeating completed side effects."),
          iteration === 0 && input.images?.length ? { images: input.images } : undefined,
        );
        if (signal.aborted)
          throw new Error(timeout.aborted ? "Embedded pi timed out" : "Task interrupted");
        iteration += 1;
        output = clipped(session.getLastAssistantText()?.trim() ?? "", 128 * 1024);
        if (!output) throw new Error("Embedded pi returned no assistant output");
        const termination = await this.jev.termination(
          runtimeRequest,
          iteration,
          output,
          toolCalls,
        );
        localBudget ||= termination.fallback;
        let effective =
          termination.value === "block" ? "block" : localBudget ? "complete" : termination.value;
        if (input.completion) {
          const terminal = input.completion.isTerminal();
          if (!terminal && effective === "complete") effective = "continue";
          else if (terminal && effective === "continue") effective = "complete";
        }
        const persistedOutput = localBudget
          ? `${output}\n\n[Runtime note: Jev was unavailable; this completed under the one-turn local budget.]`
          : output;
        const record: PiAgentCheckpoint = {
          id: checkpointId,
          sessionKey: input.sessionKey,
          sessionFile: session.sessionFile,
          iteration,
          toolCalls,
          status:
            effective === "block" ? "failed" : effective === "complete" ? "succeeded" : "running",
          output: persistedOutput,
          ...(effective === "block" ? { error: "Jev blocked the runtime result" } : {}),
          updatedAt: new Date().toISOString(),
        };
        await this.persist(input.owner, record);
        if (effective === "complete") return persistedOutput;
        if (effective === "block") throw new Error("Jev blocked the runtime result");
      }
      throw new Error(
        input.completion
          ? `Embedded pi reached its ${hardIterations}-iteration limit without a terminal task tool outcome`
          : `Embedded pi reached its ${hardIterations}-iteration limit without completion`,
      );
    } catch (error) {
      await this.persist(input.owner, {
        id: checkpointId,
        sessionKey: input.sessionKey,
        sessionFile: session.sessionFile,
        iteration,
        toolCalls,
        status: input.request.signal.aborted ? "cancelled" : "failed",
        output,
        error: error instanceof Error ? error.message : "Embedded pi failed",
        updatedAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
      await usageWrites;
    }
  }

  private async persist(owner: string, value: PiAgentCheckpoint) {
    await this.db.put(owner, "pi-agent-runs", value);
    if (value.sessionFile)
      await this.db.put(owner, "pi-agent-sessions", {
        id: createHash("sha256").update(value.sessionKey).digest("hex"),
        sessionFile: value.sessionFile,
        updatedAt: value.updatedAt,
      });
  }

  private forwardEvent(event: AgentSessionEvent, callbacks: PiAgentRunCallbacks) {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      callbacks.onTextDelta?.(event.assistantMessageEvent.delta);
    else if (event.type === "tool_execution_start")
      callbacks.onToolStart?.(event.toolCallId, event.toolName, event.args);
    else if (event.type === "tool_execution_end")
      callbacks.onToolEnd?.(event.toolCallId, event.toolName, event.result, event.isError);
  }

  private async createSession(input: PiAgentSessionInput): Promise<PiAgentSession> {
    const agentDir = join(this.config.dataDir, "pi", "agent");
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const { runtime, model } = await configuredPiModel(
      this.config,
      agentDir,
      input.request.model,
      input.request.capabilities.includes("vision"),
    );
    const manager =
      input.sessionFile && existsSync(input.sessionFile)
        ? SessionManager.open(input.sessionFile, input.sessionDir, input.cwd)
        : SessionManager.create(input.cwd, input.sessionDir);
    syncPiHostReports(manager, input.hostReports ?? []);
    const { session } = await createAgentSession({
      cwd: input.cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: "medium",
      noTools: "builtin",
      customTools: adaptCopilotTools(
        input.tools,
        { jev: this.jev },
        input.request,
        input.onToolCall,
        input.maxToolCalls,
        input.abortTools,
        input.onPolicyFallback,
      ),
      resourceLoader: emptyResourceLoader(
        input.systemPrompt,
        await new Skills(this.db, this.config).piResources(input.request.owner),
      ),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: false },
      }),
      sessionManager: manager,
    });
    return session;
  }
}
