import type {
  AgentTask,
  AgentTeamRole,
  ModelCapability,
  VisionSupport,
} from "../../../../packages/domain/src/agent.ts";

export interface RoleRuntimeRequest {
  owner: string;
  task: Readonly<AgentTask>;
  role: Readonly<AgentTeamRole>;
  model: string;
  capabilities: readonly ModelCapability[];
  visionSupport?: VisionSupport;
  dependencyContext: Readonly<Record<string, string>>;
  signal: AbortSignal;
}
export interface RoleRuntimePreparation {
  systemPrompt?: string;
  context?: Record<string, unknown>;
}
export interface RoleRuntimeResult {
  output: string;
}

/**
 * Injection boundary for coding runtimes. Embedded pi/Jev implementations own their
 * context, loop and guardrails behind this interface; the core does not impersonate them.
 */
export interface CodingRuntimeHook {
  readonly id: string;
  supports(request: RoleRuntimeRequest): boolean | Promise<boolean>;
  guard(request: RoleRuntimeRequest): Promise<void>;
  prepare(request: RoleRuntimeRequest): Promise<RoleRuntimePreparation>;
  execute?(request: RoleRuntimeRequest & RoleRuntimePreparation): Promise<RoleRuntimeResult>;
}

export class RuntimeHookPipeline {
  constructor(private readonly hooks: readonly CodingRuntimeHook[] = []) {}

  async prepare(request: RoleRuntimeRequest): Promise<{
    preparation: RoleRuntimePreparation;
    executor?: CodingRuntimeHook;
  }> {
    let systemPrompt = request.role.systemPrompt;
    const context: Record<string, unknown> = {};
    let executor: CodingRuntimeHook | undefined;
    for (const hook of this.hooks) {
      if (!(await hook.supports(request))) continue;
      await hook.guard(request);
      const prepared = await hook.prepare(request);
      if (prepared.systemPrompt) systemPrompt += `\n\n${prepared.systemPrompt}`;
      if (prepared.context) context[hook.id] = prepared.context;
      if (hook.execute) {
        if (executor) throw new Error(`Multiple coding runtimes claimed role ${request.role.id}`);
        executor = hook;
      }
    }
    return { preparation: { systemPrompt, context }, executor };
  }
}
