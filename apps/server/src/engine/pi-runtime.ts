import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ComputerService } from "../computer.ts";
import type { Config } from "../config.ts";
import type { ConnectorService } from "../connector-service.ts";
import type { Store } from "../db.ts";
import type { JevRuntime } from "./jev-runtime.ts";
import { createPiTools } from "./pi-tools.ts";
import type {
  CodingRuntimeHook,
  RoleRuntimePreparation,
  RoleRuntimeRequest,
} from "./runtime-hooks.ts";

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
  onToolCall(): number;
}
export type PiSessionFactory = (input: PiSessionInput) => Promise<PiSession>;

const clipped = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max)}\n[truncated by context diet]`;
const checkpointId = (request: RoleRuntimeRequest) => `${request.task.id}:${request.role.id}`;

function emptyResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
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
          ? (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY)
          : provider === "opencodex"
            ? (config.openCodexApiKey ?? process.env.OPENCODEX_API_KEY)
            : undefined;
  if (!providerKey?.trim())
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
            : undefined;
  if (builtin && !customBase) {
    await runtime.setRuntimeApiKey(provider, providerKey.trim());
    return { runtime, model: builtin as Model<string> };
  }
  if (!customBase?.trim() && !builtin)
    throw new Error(
      `Configured model ${spec} is not in pi's catalog and has no compatible base URL`,
    );
  const baseUrl = customBase?.replace(/\/$/, "") ?? builtin?.baseUrl;
  if (!baseUrl) throw new Error(`No base URL is configured for ${provider}`);
  const parsedBase = new URL(baseUrl);
  if (!/^https?:$/.test(parsedBase.protocol) || parsedBase.username || parsedBase.password)
    throw new Error(`Invalid server-side base URL for ${provider}`);
  const api =
    provider === "anthropic"
      ? "anthropic-messages"
      : provider === "google"
        ? "google-generative-ai"
        : "openai-responses";
  const runtimeProvider = `openmuse-${provider}`;
  runtime.registerProvider(runtimeProvider, {
    name: `OpenMuse ${provider}`,
    baseUrl,
    apiKey: providerKey.trim(),
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
  ) {
    this.sessionFactory = sessionFactory ?? ((input) => this.createSession(input));
  }

  async supports(request: RoleRuntimeRequest) {
    const settings = await this.jev.settings.resolve(request.owner);
    return settings.pi.enabled && request.role.kind === "coder";
  }

  async guard(request: RoleRuntimeRequest) {
    if (request.signal.aborted) throw new Error("Team role interrupted");
    const settings = await this.jev.settings.resolve(request.owner);
    if (!settings.pi.enabled) throw new Error("Embedded pi is disabled");
  }

  async prepare(request: RoleRuntimeRequest): Promise<RoleRuntimePreparation> {
    const diet = await this.jev.contextProfile(request);
    return {
      systemPrompt:
        "You are running through embedded pi. Use only the registered OpenMuse tools. Never claim host access, network access, or an external write that the tools did not perform.",
      context: {
        profile: diet.value,
        mode: diet.fallback ? "local-budget" : "jev",
        confidence: diet.confidence,
        failure: diet.failure,
      },
    };
  }

  async execute(request: RoleRuntimeRequest & RoleRuntimePreparation) {
    const settings = await this.jev.settings.resolve(request.owner);
    const context = (request.context?.pi ?? {}) as {
      profile?: "minimal" | "dependencies" | "full";
      mode?: "jev" | "local-budget";
    };
    const hardIterations = context.mode === "local-budget" ? 1 : settings.pi.maxIterations;
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
    const session = await this.sessionFactory({
      request,
      systemPrompt: request.systemPrompt ?? request.role.systemPrompt,
      sessionDir,
      cwd,
      checkpoint: existing ?? undefined,
      maxToolCalls: context.mode === "local-budget" ? 4 : 32,
      onToolCall: () => ++toolCalls,
    });
    const timeout = AbortSignal.timeout(settings.pi.timeoutMs);
    const signal = AbortSignal.any([request.signal, timeout]);
    const abort = () => void session.abort();
    signal.addEventListener("abort", abort, { once: true });
    let iteration = existing?.iteration ?? 0;
    let output = existing?.output ?? "";
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
            ? this.initialPrompt(request, context.profile ?? "minimal")
            : "Continue this role from the durable session. Finish or verify the requested result without repeating completed side effects.",
        );
        if (signal.aborted)
          throw new Error(timeout.aborted ? "Embedded pi timed out" : "Team role interrupted");
        iteration = nextIteration;
        output = clipped(session.getLastAssistantText()?.trim() ?? "", 128 * 1024);
        if (!output) throw new Error("Embedded pi returned no assistant output");
        const termination = await this.jev.termination(request, iteration, output, toolCalls);
        const localBudget = termination.fallback || context.mode === "local-budget";
        const effective = localBudget ? "complete" : termination.value;
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
      `Task:\n${clipped(request.task.prompt, taskLimit)}\n\n` +
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
      noTools: "all",
      customTools: createPiTools(
        { computer: this.computer, connectors: this.connectors, jev: this.jev },
        input.request,
        input.onToolCall,
        input.maxToolCalls,
      ),
      resourceLoader: emptyResourceLoader(input.systemPrompt),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: false },
      }),
      sessionManager: manager,
    });
    return session;
  }
}
