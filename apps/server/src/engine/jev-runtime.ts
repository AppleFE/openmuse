import type {
  JevContextProfile,
  JevTermination,
} from "../../../../packages/integrations/src/jev.ts";
import { JevClient, type JevRequestContext } from "../../../../packages/integrations/src/jev.ts";
import type { ResolvedRuntimeSettings, RuntimeSettingsService } from "./jev-settings.ts";
import type { CodingRuntimeHook, RoleRuntimeRequest } from "./runtime-hooks.ts";

type Decision<T extends string> = { choice: T; confidence: number };
export interface JevDecisionClient {
  guardExecution(
    context: JevRequestContext,
    signal: AbortSignal,
  ): Promise<Decision<"allow" | "block">>;
  selectContext(
    context: JevRequestContext & { dependencyCharacters: number },
    signal: AbortSignal,
  ): Promise<Decision<JevContextProfile>>;
  guardTool(
    context: JevRequestContext,
    tool: { name: string; argumentKeys: string[] },
    signal: AbortSignal,
  ): Promise<Decision<"allow" | "block">>;
  decideTermination(
    context: JevRequestContext & { iteration: number; output: string; toolCalls: number },
    signal: AbortSignal,
  ): Promise<Decision<JevTermination>>;
}

export type JevClientFactory = (settings: ResolvedRuntimeSettings) => JevDecisionClient;
export interface JevDecision<T> {
  value: T;
  fallback: boolean;
  confidence?: number;
  failure?: string;
}

const contextOf = (request: RoleRuntimeRequest): JevRequestContext => ({
  taskId: request.task.id,
  taskKind: request.task.kind,
  taskPrompt: request.task.prompt,
  roleId: request.role.id,
  roleKind: request.role.kind,
  model: request.model,
  dependencyCount: Object.keys(request.dependencyContext).length,
});
const failureMessage = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : "Jev request failed";

/** Shared policy runner used by the model guard and embedded-pi loop. */
export class JevRuntime {
  constructor(
    readonly settings: RuntimeSettingsService,
    private readonly factory: JevClientFactory = (value) =>
      new JevClient({
        apiKey: value.jev.apiKey ?? "",
        model: value.jev.model,
        timeoutMs: value.jev.timeoutMs,
        baseURL: value.jev.baseURL,
      }),
  ) {}

  private client(settings: ResolvedRuntimeSettings): JevDecisionClient {
    if (!settings.jev.apiKey) throw new Error("Jev is enabled without a configured credential");
    return this.factory(settings);
  }

  private async decide<T>(
    settings: ResolvedRuntimeSettings,
    fallback: T,
    signal: AbortSignal,
    operation: (client: JevDecisionClient) => Promise<Decision<string>>,
  ): Promise<JevDecision<T>> {
    try {
      const answer = await operation(this.client(settings));
      return { value: answer.choice as T, confidence: answer.confidence, fallback: false };
    } catch (error) {
      if (signal.aborted) throw error;
      if (settings.jev.failMode === "closed") throw error;
      return { value: fallback, fallback: true, failure: failureMessage(error) };
    }
  }

  async guard(request: RoleRuntimeRequest): Promise<JevDecision<"allow" | "block">> {
    const settings = await this.settings.resolve(request.owner);
    return this.decide(settings, "allow", request.signal, (client) =>
      client.guardExecution(contextOf(request), request.signal),
    );
  }

  async contextProfile(request: RoleRuntimeRequest): Promise<JevDecision<JevContextProfile>> {
    const settings = await this.settings.resolve(request.owner);
    if (!settings.jev.enabled) return { value: "dependencies", fallback: false, confidence: 1 };
    return this.decide(settings, "minimal", request.signal, (client) =>
      client.selectContext(
        {
          ...contextOf(request),
          dependencyCharacters: Object.values(request.dependencyContext).reduce(
            (total, value) => total + value.length,
            0,
          ),
        },
        request.signal,
      ),
    );
  }

  async guardTool(
    request: RoleRuntimeRequest,
    name: string,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<JevDecision<"allow" | "block">> {
    const settings = await this.settings.resolve(request.owner);
    if (!settings.jev.enabled) return { value: "allow", fallback: false, confidence: 1 };
    return this.decide(settings, "allow", signal, (client) =>
      client.guardTool(
        contextOf(request),
        { name, argumentKeys: Object.keys(argumentsValue) },
        signal,
      ),
    );
  }

  async termination(
    request: RoleRuntimeRequest,
    iteration: number,
    output: string,
    toolCalls: number,
  ): Promise<JevDecision<JevTermination>> {
    const settings = await this.settings.resolve(request.owner);
    if (!settings.jev.enabled) return { value: "complete", fallback: false, confidence: 1 };
    return this.decide(settings, "complete", request.signal, (client) =>
      client.decideTermination(
        { ...contextOf(request), iteration, output, toolCalls },
        request.signal,
      ),
    );
  }
}

/** Applies Jev before every enabled team-role model operation. */
export class JevGuardRuntimeHook implements CodingRuntimeHook {
  readonly id = "jev";
  private readonly outcomes = new Map<string, JevDecision<"allow" | "block">>();
  constructor(private readonly runtime: JevRuntime) {}
  private key(request: RoleRuntimeRequest) {
    return `${request.owner}:${request.task.id}:${request.role.id}`;
  }
  async supports(request: RoleRuntimeRequest) {
    return (await this.runtime.settings.resolve(request.owner)).jev.enabled;
  }
  async guard(request: RoleRuntimeRequest) {
    const decision = await this.runtime.guard(request);
    if (decision.value !== "allow" || (!decision.fallback && (decision.confidence ?? 0) < 0.55))
      throw new Error("Jev blocked this role before model execution");
    this.outcomes.set(this.key(request), decision);
  }
  async prepare(request: RoleRuntimeRequest) {
    const outcome = this.outcomes.get(this.key(request));
    this.outcomes.delete(this.key(request));
    return {
      systemPrompt:
        "Jev policy has evaluated this role. Approval, cancellation, credential, and isolation boundaries remain authoritative.",
      context: {
        mode: outcome?.fallback ? "local-budget" : "jev",
        confidence: outcome?.confidence,
        failure: outcome?.failure,
      },
    };
  }
}
