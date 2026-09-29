import type {
  AgentRoleRun,
  AgentTask,
  AgentTeam,
  AgentTeamRole,
  AgentTeamTaskContext,
  TaskThreadMessage,
} from "../../../../packages/domain/src/agent.ts";
import type { Store } from "../db.ts";
import type { TaskContext } from "./worker.ts";

export interface TeamRoleExecution {
  output: string;
}
export type TeamRoleExecutor = (input: {
  owner: string;
  task: Readonly<AgentTask>;
  role: Readonly<AgentTeamRole>;
  dependencyContext: Readonly<Record<string, string>>;
  signal: AbortSignal;
}) => Promise<TeamRoleExecution>;

export function validateTeam(team: Pick<AgentTeam, "roles">): void {
  const ids = new Set<string>();
  for (const role of team.roles) {
    if (ids.has(role.id)) throw new Error(`Duplicate team role id "${role.id}"`);
    ids.add(role.id);
  }
  for (const role of team.roles)
    for (const dependency of role.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Role "${role.id}" has unknown dependency "${dependency}"`);
      if (dependency === role.id) throw new Error(`Role "${role.id}" cannot depend on itself`);
    }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(team.roles.map((role) => [role.id, role]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Team role dependencies must not contain a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const role of team.roles) visit(role.id);
}

export function createTeamTaskContext(team: AgentTeam): AgentTeamTaskContext {
  validateTeam(team);
  return {
    teamId: team.id,
    teamRevision: team.revision,
    status: "pending",
    roles: team.roles.map((role) => ({ ...role, dependsOn: [...role.dependsOn] })),
    roleRuns: team.roles.map((role) => ({
      roleId: role.id,
      roleLabel: role.label,
      modelId: role.modelId,
      status: "pending",
      attempts: 0,
    })),
    sharedContext: {},
  };
}

const roleMeta = (role: AgentTeamRole) => ({
  roleId: role.id,
  roleLabel: role.label,
  modelId: role.modelId,
});

export class TeamEngine {
  constructor(
    private readonly db: Store,
    private readonly executeRole: TeamRoleExecutor,
  ) {}

  async execute(
    owner: string,
    initialTask: AgentTask,
    ctx: TaskContext,
  ): Promise<Partial<AgentTask>> {
    if (!initialTask.teamContext) throw new Error("Team task context is missing");
    let task = initialTask;
    let team = initialTask.teamContext;
    validateTeam({ roles: team.roles });

    // An expired task lease means any in-memory role call is gone. Preserve completed
    // results and make only interrupted roles eligible for a new attempt.
    if (team.roleRuns.some((run) => run.status === "running")) {
      team = this.withRuns(
        team,
        team.roleRuns.map((run) =>
          run.status === "running"
            ? { ...run, status: "pending" as const, error: "Interrupted before completion" }
            : run,
        ),
      );
      task = await ctx.checkpoint({ teamContext: team });
    }
    await this.reconcileMessages(owner, task, team);

    while (true) {
      await ctx.guard();
      const status = new Map(team.roleRuns.map((run) => [run.roleId, run.status]));
      const pending = team.roles.filter((role) => status.get(role.id) === "pending");
      const ready = pending.filter((role) =>
        role.dependsOn.every((dependency) => status.get(dependency) === "succeeded"),
      );
      if (!ready.length) break;
      const wave = initialTask.teamContext.roles.length && this.executionMode(initialTask) === "sequential"
        ? ready.slice(0, 1)
        : ready;
      const startedAt = new Date().toISOString();
      const waveIds = new Set(wave.map((role) => role.id));
      team = this.withRuns(
        team,
        team.roleRuns.map((run) =>
          waveIds.has(run.roleId)
            ? {
                ...run,
                status: "running" as const,
                attempts: run.attempts + 1,
                startedAt,
                finishedAt: undefined,
                error: undefined,
              }
            : run,
        ),
        "running",
      );
      task = await ctx.checkpoint({ teamContext: team });
      for (const role of wave)
        await ctx.event("status", `${role.label} started`, "", roleMeta(role));

      // Model calls run concurrently, while durable merges are serialized. The shared
      // context is rebuilt in role declaration order, never completion order.
      let persist = Promise.resolve();
      const snapshot = task;
      const dependencySnapshot = { ...team.sharedContext };
      await Promise.all(
        wave.map(async (role) => {
          let update: Pick<AgentRoleRun, "status" | "output" | "error" | "finishedAt">;
          try {
            const result = await this.executeRole({
              owner,
              task: snapshot,
              role,
              dependencyContext: dependencySnapshot,
              signal: ctx.signal,
            });
            const output = result.output.trim();
            if (!output) throw new Error("Role returned no output");
            update = {
              status: "succeeded",
              output,
              error: undefined,
              finishedAt: new Date().toISOString(),
            };
          } catch (error) {
            if (ctx.signal.aborted) throw error;
            update = {
              status: "failed",
              output: undefined,
              error: error instanceof Error ? error.message : "Role execution failed",
              finishedAt: new Date().toISOString(),
            };
          }
          const commit = async () => {
            const runs = team.roleRuns.map((run) =>
              run.roleId === role.id ? { ...run, ...update } : run,
            );
            team = this.withRuns(team, runs, "running");
            task = await ctx.checkpoint({ teamContext: team });
            if (update.status === "succeeded") {
              await this.putMessage(owner, task.id, role, update.output ?? "", runs);
              await ctx.event("result", `${role.label} completed`, update.output, roleMeta(role));
            } else await ctx.event("error", `${role.label} failed`, update.error, roleMeta(role));
          };
          const committed = persist.then(commit);
          persist = committed.then(
            () => undefined,
            () => undefined,
          );
          await committed;
        }),
      );
      await persist;
    }

    const failed = new Set(
      team.roleRuns.filter((run) => run.status === "failed").map((run) => run.roleId),
    );
    const blocked = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const role of team.roles)
        if (
          !blocked.has(role.id) &&
          role.dependsOn.some((dependency) => failed.has(dependency) || blocked.has(dependency))
        ) {
          blocked.add(role.id);
          changed = true;
        }
    }
    if (failed.size) {
      team = this.withRuns(
        team,
        team.roleRuns.map((run) =>
          run.status === "pending" && blocked.has(run.roleId)
            ? { ...run, status: "cancelled" as const, error: "A dependency failed" }
            : run,
        ),
        "failed",
      );
      return {
        status: "failed",
        error: team.roleRuns.find((run) => run.status === "failed")?.error ?? "A team role failed",
        teamContext: team,
      };
    }
    if (team.roleRuns.some((run) => run.status !== "succeeded"))
      throw new Error("Team execution stopped with unresolved role dependencies");
    team = this.withRuns(team, team.roleRuns, "succeeded");
    const result = team.roles
      .map((role) => {
        const output = team.sharedContext[role.id];
        return output ? `${role.label}: ${output}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
    return {
      status: "succeeded",
      result,
      error: null,
      teamContext: team,
      plan: task.plan.map((step) => ({ ...step, status: "succeeded" as const })),
    };
  }

  private executionMode(task: AgentTask): AgentTeam["execution"] {
    return task.state.teamExecution === "sequential" ? "sequential" : "parallel";
  }

  private withRuns(
    team: AgentTeamTaskContext,
    roleRuns: AgentRoleRun[],
    status: AgentTeamTaskContext["status"] = team.status,
  ): AgentTeamTaskContext {
    const byId = new Map(roleRuns.map((run) => [run.roleId, run]));
    const sharedContext: Record<string, string> = {};
    for (const role of team.roles) {
      const run = byId.get(role.id);
      if (run?.status === "succeeded" && run.output) sharedContext[role.id] = run.output;
    }
    return { ...team, status, roleRuns, sharedContext };
  }

  private async putMessage(
    owner: string,
    taskId: string,
    role: AgentTeamRole,
    content: string,
    runs: AgentRoleRun[],
  ) {
    const attempts = runs.find((run) => run.roleId === role.id)?.attempts ?? 1;
    const message: TaskThreadMessage = {
      id: `${taskId}:${role.id}:${attempts}`,
      taskId,
      role: "assistant",
      ...roleMeta(role),
      content,
      createdAt: new Date().toISOString(),
    };
    await this.db.put(owner, "task-thread-messages", message);
  }

  private async reconcileMessages(owner: string, task: AgentTask, team: AgentTeamTaskContext) {
    for (const role of team.roles) {
      const run = team.roleRuns.find((candidate) => candidate.roleId === role.id);
      if (run?.status === "succeeded" && run.output)
        await this.putMessage(owner, task.id, role, run.output, team.roleRuns);
    }
  }
}
