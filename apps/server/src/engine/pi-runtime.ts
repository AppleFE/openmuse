import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type JsonObject,
  type Model,
  type OpenAICompletionsOptions,
  type Provider,
  type SimpleStreamOptions,
  type Tool,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { skillPrompt } from "../../../../packages/domain/src/skills.ts";
import type { BrowserService } from "../browser.ts";
import type { ComputerService } from "../computer.ts";
import { type Config, normalizeOllamaBaseUrl } from "../config.ts";
import type { ConnectorService } from "../connector-service.ts";
import type { Store } from "../db.ts";
import { Skills } from "../skills.ts";
import { UsageService } from "../usage.ts";
import type { JevRuntime } from "./jev-runtime.ts";
import { createPiTools } from "./pi-tools.ts";
import type {
  CodingRuntimeHook,
  RoleRuntimePreparation,
  RoleRuntimeRequest,
} from "./runtime-hooks.ts";
import { runtimeInstructions } from "./runtime-instructions.ts";

interface PiCheckpoint {
  id: string;
  sessionFile?: string;
  iteration: number;
  toolCalls: number;
  status: "running" | "succeeded" | "failed";
  output?: string;
  error?: string;
  updatedAt: string;
}

export interface PiSession {
  sessionFile?: string;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  getLastAssistantText(): string | undefined;
}

export interface PiSessionInput {
  request: RoleRuntimeRequest;
  systemPrompt: string;
  sessionDir: string;
  cwd: string;
  checkpoint?: PiCheckpoint;
  maxToolCalls: number;
  onToolCall(): number | Promise<number>;
  onPolicyFallback(): void;
}
export type PiSessionFactory = (input: PiSessionInput) => Promise<PiSession>;

const clipped = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max)}\n[truncated by context diet]`;
const checkpointId = (request: RoleRuntimeRequest) => `${request.task.id}:${request.role.id}`;

export function emptyResourceLoader(systemPrompt: string, skills: Skill[] = []): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills, diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function modelParts(spec: string) {
  const match = spec.trim().match(/^([^/:]+)[/:](.+)$/);
  if (!match) throw new Error(`Invalid pi model string "${spec}"`);
  return { provider: match[1]?.toLowerCase() ?? "", id: match[2]?.trim() ?? "" };
}

const emptyUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function textContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string")
        return part.text;
      if (part && typeof part === "object" && "type" in part && part.type === "image")
        return "[image omitted]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function ollamaTools(context: TranscriptContext): Tool[] {
  const tools = new Map<string, Tool>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return [...tools.values()];
}

function ollamaMessages(context: TranscriptContext) {
  return context.messages.map((message) => {
    if (message.role === "system") {
      const sections = Object.values(message.sections ?? {}).filter(
        (value): value is string => typeof value === "string",
      );
      return { role: "system", content: [textContent(message.content), ...sections].join("\n") };
    }
    if (message.role === "user") return { role: "user", content: textContent(message.content) };
    if (message.role === "toolResult")
      return {
        role: "tool",
        tool_name: message.toolName,
        content: textContent(message.content),
      };
    const calls = message.content.filter((part) => part.type === "toolCall");
    return {
      role: "assistant",
      content: textContent(message.content),
      ...(calls.length
        ? {
            tool_calls: calls.map((call) => ({
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    };
  });
}

function ollamaStream(
  model: Model<"openai-completions">,
  context: TranscriptContext,
  options?: SimpleStreamOptions | OpenAICompletionsOptions,
) {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  void (async () => {
    try {
      stream.push({ type: "start", partial: output });
      const tools = ollamaTools(context);
      const response = await fetch(`${model.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: options?.signal,
        body: JSON.stringify({
          model: model.id,
          messages: ollamaMessages(context),
          stream: true,
          think: false,
          options: {
            num_ctx: Math.min(model.contextWindow, 8192),
            num_predict: Math.max(
              1,
              Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens, 1024),
            ),
          },
          ...(tools.length
            ? {
                tools: tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
              }
            : {}),
          ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
        }),
      });
      if (!response.ok)
        throw new Error(
          `Ollama returned HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`,
        );
      if (!response.body) throw new Error("Ollama returned an empty response body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let textBlock: Extract<AssistantMessage["content"][number], { type: "text" }> | undefined;
      const toolBlocks = new Map<
        number,
        { block: Extract<AssistantMessage["content"][number], { type: "toolCall" }>; raw: string }
      >();
      let finishReason: string | undefined;
      let completed = false;
      const consume = (data: string) => {
        if (!data.trim()) return;
        const chunk = JSON.parse(data) as {
          message?: {
            content?: string;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: JsonObject | string };
            }>;
          };
          done?: boolean;
          done_reason?: string;
          prompt_eval_count?: number;
          eval_count?: number;
          error?: string;
        };
        if (chunk.error) throw new Error(`Ollama stream error: ${chunk.error.slice(0, 1000)}`);
        if (chunk.message?.content) {
          if (!textBlock) {
            textBlock = { type: "text", text: "" };
            output.content.push(textBlock);
            stream.push({
              type: "text_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
          textBlock.text += chunk.message.content;
          stream.push({
            type: "text_delta",
            contentIndex: output.content.indexOf(textBlock),
            delta: chunk.message.content,
            partial: output,
          });
        }
        for (const [index, call] of (chunk.message?.tool_calls ?? []).entries()) {
          let current = toolBlocks.get(index);
          if (!current) {
            const block = {
              type: "toolCall" as const,
              id: call.id ?? `ollama-tool-${index}`,
              name: call.function?.name ?? "",
              arguments: {} as JsonObject,
            };
            current = { block, raw: "" };
            toolBlocks.set(index, current);
            output.content.push(block);
            stream.push({
              type: "toolcall_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
          if (call.id) current.block.id = call.id;
          if (call.function?.name) current.block.name = call.function.name;
          if (call.function?.arguments !== undefined) {
            current.raw =
              typeof call.function.arguments === "string"
                ? call.function.arguments
                : JSON.stringify(call.function.arguments);
            stream.push({
              type: "toolcall_delta",
              contentIndex: output.content.indexOf(current.block),
              delta: current.raw,
              partial: output,
            });
          }
        }
        if (chunk.done) {
          completed = true;
          finishReason = chunk.done_reason;
          output.usage.input = chunk.prompt_eval_count ?? 0;
          output.usage.output = chunk.eval_count ?? 0;
          output.usage.totalTokens = output.usage.input + output.usage.output;
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n");
        while (boundary >= 0) {
          consume(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 1);
          boundary = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      for (const line of buffer.split(/\r?\n/)) consume(line);
      if (!completed) throw new Error("Ollama stream ended before its final done marker");
      if (textBlock)
        stream.push({
          type: "text_end",
          contentIndex: output.content.indexOf(textBlock),
          content: textBlock.text,
          partial: output,
        });
      for (const current of toolBlocks.values()) {
        if (current.raw) {
          const parsed = JSON.parse(current.raw) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("Ollama returned invalid tool arguments");
          current.block.arguments = parsed as JsonObject;
        }
        stream.push({
          type: "toolcall_end",
          contentIndex: output.content.indexOf(current.block),
          toolCall: current.block,
          partial: output,
        });
      }
      output.rawStopReason = finishReason;
      output.stopReason = toolBlocks.size
        ? "toolUse"
        : finishReason === "length"
          ? "length"
          : "stop";
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end(output);
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : "Ollama request failed";
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end(output);
    }
  })();
  return stream;
}

export async function configuredPiModel(
  config: Config,
  agentDir: string,
  spec: string,
): Promise<{ runtime: ModelRuntime; model: Model<string> }> {
  const { provider, id } = modelParts(spec);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "unused-auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const providerKey =
    provider === "openai"
      ? process.env.OPENAI_API_KEY
      : provider === "anthropic"
        ? process.env.ANTHROPIC_API_KEY
        : provider === "google"
          ? (process.env.GEMINI_API_KEY ??
            process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
            process.env.GOOGLE_API_KEY)
          : provider === "opencodex"
            ? (config.openCodexApiKey ?? process.env.OPENCODEX_API_KEY)
            : provider === "ollama"
              ? undefined
              : undefined;
  if (provider !== "ollama" && !providerKey?.trim())
    throw new Error(`No server-side credential is configured for ${provider}`);
  const builtin = runtime.getModel(provider, id);
  const customBase =
    provider === "openai"
      ? process.env.OPENAI_BASE_URL
      : provider === "anthropic"
        ? process.env.ANTHROPIC_BASE_URL
        : provider === "google"
          ? process.env.GOOGLE_GENERATIVE_AI_BASE_URL
          : provider === "opencodex"
            ? (config.openCodexBaseUrl ?? process.env.OPENCODEX_BASE_URL)
            : provider === "ollama"
              ? (config.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL)
              : undefined;
  if (builtin && !customBase) {
    if (!providerKey?.trim())
      throw new Error(`No server-side credential is configured for ${provider}`);
    await runtime.setRuntimeApiKey(provider, providerKey.trim());
    return { runtime, model: builtin as Model<string> };
  }
  if (!customBase?.trim() && !builtin)
    throw new Error(
      `Configured model ${spec} is not in pi's catalog and has no compatible base URL`,
    );
  let normalizedCustomBase =
    provider === "anthropic"
      ? customBase?.replace(/\/v1\/?$/, "")
      : provider === "google"
        ? customBase?.replace(/\/v1beta\/?$/, "")
        : customBase?.replace(/\/$/, "");
  if (provider === "ollama" && normalizedCustomBase) {
    normalizedCustomBase = normalizeOllamaBaseUrl(normalizedCustomBase);
  }
  const baseUrl = normalizedCustomBase ?? builtin?.baseUrl;
  if (!baseUrl) throw new Error(`No base URL is configured for ${provider}`);
  const parsedBase = new URL(baseUrl);
  if (!/^https?:$/.test(parsedBase.protocol) || parsedBase.username || parsedBase.password)
    throw new Error(`Invalid server-side base URL for ${provider}`);
  const api =
    provider === "anthropic"
      ? "anthropic-messages"
      : provider === "google"
        ? "google-generative-ai"
        : provider === "ollama"
          ? "openai-completions"
          : "openai-responses";
  const runtimeProvider = `openmuse-${provider}`;
  if (provider === "ollama") {
    const ollamaModel: Model<"openai-completions"> = {
      id,
      name: id,
      provider: runtimeProvider,
      api: "openai-completions",
      baseUrl,
      reasoning: builtin?.reasoning ?? true,
      input: builtin?.input ?? ["text"],
      cost: builtin?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    };
    const ollamaProvider: Provider<"openai-completions"> = {
      id: runtimeProvider,
      name: "OpenMuse Ollama",
      baseUrl,
      auth: {
        apiKey: {
          name: "Keyless local Ollama",
          check: async () => ({ type: "api_key", source: "OLLAMA_BASE_URL" }),
          resolve: async () => ({ auth: { baseUrl }, source: "OLLAMA_BASE_URL" }),
        },
      },
      getModels: () => [ollamaModel],
      stream: ollamaStream,
      streamSimple: ollamaStream,
    };
    runtime.registerNativeProvider(ollamaProvider);
    const model = runtime.getModel(runtimeProvider, id);
    if (!model) throw new Error(`Pi could not register configured model ${spec}`);
    return { runtime, model: model as Model<string> };
  }
  runtime.registerProvider(runtimeProvider, {
    name: `OpenMuse ${provider}`,
    baseUrl,
    ...(providerKey?.trim() ? { apiKey: providerKey.trim() } : {}),
    api,
    authHeader: true,
    models: [
      {
        id,
        name: id,
        api,
        baseUrl,
        reasoning: builtin?.reasoning ?? true,
        input: builtin?.input ?? ["text"],
        cost: builtin?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: builtin?.contextWindow ?? 128000,
        maxTokens: builtin?.maxTokens ?? 16384,
      },
    ],
  });
  const model = runtime.getModel(runtimeProvider, id);
  if (!model) throw new Error(`Pi could not register configured model ${spec}`);
  return { runtime, model: model as Model<string> };
}

export class PiRuntimeHook implements CodingRuntimeHook {
  readonly id = "pi";
  private readonly sessionFactory: PiSessionFactory;
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly computer: ComputerService,
    private readonly connectors: ConnectorService | undefined,
    private readonly jev: JevRuntime,
    sessionFactory?: PiSessionFactory,
    private readonly browser?: BrowserService,
  ) {
    this.sessionFactory = sessionFactory ?? ((input) => this.createSession(input));
  }

  async supports(request: RoleRuntimeRequest) {
    const settings = await this.jev.settings.resolve(request.owner);
    return (
      settings.pi.enabled &&
      (/^ollama[/:]/i.test(request.model) ||
        (request.role.kind === "coder" && request.capabilities.includes("coding")))
    );
  }

  async guard(request: RoleRuntimeRequest) {
    if (request.signal.aborted) throw new Error("Team role interrupted");
    const settings = await this.jev.settings.resolve(request.owner);
    if (!settings.pi.enabled) throw new Error("Embedded pi is disabled");
  }

  async prepare(_request: RoleRuntimeRequest): Promise<RoleRuntimePreparation> {
    return {
      systemPrompt:
        "You are running through embedded pi. Use only the registered OpenMuse tools. Never claim host access, network access, or an external write that the tools did not perform." +
        runtimeInstructions(true),
    };
  }

  async execute(request: RoleRuntimeRequest & RoleRuntimePreparation) {
    const settings = await this.jev.settings.resolve(request.owner);
    const timeout = AbortSignal.timeout(settings.pi.timeoutMs);
    const signal = AbortSignal.any([request.signal, timeout]);
    const runtimeRequest = { ...request, signal };
    const diet = await this.jev.contextProfile(runtimeRequest);
    let localBudget =
      diet.fallback ||
      (request.context?.jev as { mode?: string } | undefined)?.mode === "local-budget";
    const context = {
      profile: localBudget ? ("minimal" as const) : diet.value,
      mode: localBudget ? ("local-budget" as const) : ("jev" as const),
    };
    const hardIterations = localBudget ? 1 : settings.pi.maxIterations;
    const id = checkpointId(request);
    const existing = await this.db.get<PiCheckpoint>(request.owner, "pi-runtime", id);
    if (existing?.status === "succeeded" && existing.output) return { output: existing.output };
    const ownerHash = createHash("sha256").update(request.owner).digest("hex").slice(0, 24);
    const cwd = join(this.config.dataDir, "pi", "empty-workspace", ownerHash);
    const sessionDir = join(
      this.config.dataDir,
      "pi",
      "sessions",
      ownerHash,
      request.task.id,
      request.role.id,
    );
    await Promise.all([
      mkdir(cwd, { recursive: true, mode: 0o700 }),
      mkdir(sessionDir, { recursive: true, mode: 0o700 }),
    ]);
    let toolCalls = existing?.toolCalls ?? 0;
    let iteration = existing?.iteration ?? 0;
    let output = existing?.output ?? "";
    let toolCheckpoint = Promise.resolve();
    let session: PiSession;
    session = await this.sessionFactory({
      request: runtimeRequest,
      systemPrompt: request.systemPrompt ?? request.role.systemPrompt,
      sessionDir,
      cwd,
      checkpoint: existing ?? undefined,
      maxToolCalls:
        localBudget || (settings.jev.enabled && settings.jev.failMode === "local-budget") ? 4 : 32,
      onToolCall: async () => {
        const count = ++toolCalls;
        toolCheckpoint = toolCheckpoint.then(async () => {
          await this.db.put(request.owner, "pi-runtime", {
            id,
            sessionFile: session?.sessionFile,
            iteration,
            toolCalls: count,
            status: "running",
            output,
            updatedAt: new Date().toISOString(),
          } satisfies PiCheckpoint);
        });
        await toolCheckpoint;
        return count;
      },
      onPolicyFallback: () => {
        localBudget = true;
      },
    });
    const abort = () => void session.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      while (iteration < hardIterations) {
        if (signal.aborted)
          throw new Error(timeout.aborted ? "Embedded pi timed out" : "Team role interrupted");
        const nextIteration = iteration + 1;
        await this.db.put(request.owner, "pi-runtime", {
          id,
          sessionFile: session.sessionFile,
          iteration,
          toolCalls,
          status: "running",
          output,
          updatedAt: new Date().toISOString(),
        } satisfies PiCheckpoint);
        await session.prompt(
          nextIteration === 1 && !existing
            ? this.initialPrompt(runtimeRequest, context.profile)
            : existing?.iteration === 0 && iteration === 0
              ? `Recover this interrupted role from its durable session without repeating completed side effects. Re-evaluate the original bounded context:\n\n${this.initialPrompt(runtimeRequest, context.profile)}`
              : "Continue this role from the durable session. Finish or verify the requested result without repeating completed side effects.",
        );
        if (signal.aborted)
          throw new Error(timeout.aborted ? "Embedded pi timed out" : "Team role interrupted");
        iteration = nextIteration;
        output = clipped(session.getLastAssistantText()?.trim() ?? "", 128 * 1024);
        if (!output) throw new Error("Embedded pi returned no assistant output");
        const termination = await this.jev.termination(
          runtimeRequest,
          iteration,
          output,
          toolCalls,
        );
        localBudget ||= termination.fallback || context.mode === "local-budget";
        const effective =
          termination.value === "block" ? "block" : localBudget ? "complete" : termination.value;
        const persistedOutput =
          effective === "complete" && localBudget
            ? `${output}\n\n[Runtime note: Jev was unavailable or disabled; this completed under the configured one-turn local budget.]`
            : output;
        await this.db.put(request.owner, "pi-runtime", {
          id,
          sessionFile: session.sessionFile,
          iteration,
          toolCalls,
          status:
            effective === "block" ? "failed" : effective === "complete" ? "succeeded" : "running",
          output: persistedOutput,
          ...(effective === "block" ? { error: "Jev blocked the coding loop result" } : {}),
          updatedAt: new Date().toISOString(),
        } satisfies PiCheckpoint);
        if (effective === "complete") return { output: persistedOutput };
        if (effective === "block") throw new Error("Jev blocked the coding loop result");
      }
      throw new Error(
        `Embedded pi reached its ${hardIterations}-iteration limit without completion`,
      );
    } catch (error) {
      await this.db.put(request.owner, "pi-runtime", {
        id,
        sessionFile: session.sessionFile,
        iteration,
        toolCalls,
        status: "failed",
        output,
        error: error instanceof Error ? error.message : "Embedded pi failed",
        updatedAt: new Date().toISOString(),
      } satisfies PiCheckpoint);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      session.dispose();
    }
  }

  private initialPrompt(request: RoleRuntimeRequest, profile: "minimal" | "dependencies" | "full") {
    const taskLimit = profile === "full" ? 12000 : 6000;
    const dependencyLimit = profile === "full" ? 24000 : profile === "dependencies" ? 12000 : 0;
    const dependencies = dependencyLimit
      ? clipped(
          Object.entries(request.dependencyContext)
            .map(([role, output]) => `${role}:\n${output}`)
            .join("\n\n"),
          dependencyLimit,
        )
      : "[omitted by context diet]";
    return (
      `Complete the ${request.role.label} role for this durable team task.\n\n` +
      `Task:\n${skillPrompt(request.task.skill, clipped(request.task.prompt, taskLimit))}\n\n` +
      `Completed dependency outputs:\n${dependencies}\n\n` +
      "Return a concrete result describing what was actually done, verification performed, and any remaining limitation."
    );
  }

  private async createSession(input: PiSessionInput): Promise<PiSession> {
    const agentDir = join(this.config.dataDir, "pi", "agent");
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const { runtime, model } = await configuredPiModel(this.config, agentDir, input.request.model);
    const manager =
      input.checkpoint?.sessionFile && existsSync(input.checkpoint.sessionFile)
        ? SessionManager.open(input.checkpoint.sessionFile, input.sessionDir, input.cwd)
        : SessionManager.create(input.cwd, input.sessionDir);
    const { session } = await createAgentSession({
      cwd: input.cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: "medium",
      noTools: "builtin",
      customTools: createPiTools(
        {
          computer: this.computer,
          connectors: this.connectors,
          browser: this.browser,
          jev: this.jev,
          skills: new Skills(this.db, this.config),
        },
        input.request,
        input.onToolCall,
        input.maxToolCalls,
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
    let writes = Promise.resolve(),
      started = Date.now(),
      firstTokenAt = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") {
        started = Date.now();
        firstTokenAt = 0;
      }
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta" &&
        !firstTokenAt
      )
        firstTokenAt = Date.now();
      if (event.type === "message_end" && event.message.role === "assistant") {
        const message = event.message,
          usage = message.usage;
        const key = `team-pi:${session.sessionFile}:${message.timestamp}:${createHash("sha256").update(JSON.stringify(message.content)).digest("hex")}`;
        writes = writes
          .then(() =>
            new UsageService(this.db).record(input.request.owner, key, {
              threadId: null,
              modelId: input.request.role.modelId,
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
              totalTokens:
                usage.totalTokens ||
                usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
              reported:
                (usage.totalTokens ||
                  usage.input + usage.output + usage.cacheRead + usage.cacheWrite) > 0,
              durationMs: Math.max(1, Date.now() - (firstTokenAt || started)),
              createdAt: new Date().toISOString(),
            }),
          )
          .then(() => {});
      }
    });
    return {
      sessionFile: session.sessionFile,
      prompt: async (text) => {
        try {
          await session.prompt(text);
        } finally {
          await writes;
        }
      },
      abort: () => session.abort(),
      dispose: () => {
        unsubscribe();
        session.dispose();
      },
      getLastAssistantText: () => session.getLastAssistantText(),
    };
  }
}
