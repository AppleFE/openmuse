import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { executeModelTask } from "../apps/server/src/engine/model.ts";
import { ModelRegistry, parseModelCatalog } from "../apps/server/src/engine/models.ts";
import { RuntimeHookPipeline } from "../apps/server/src/engine/runtime-hooks.ts";
import { TeamModelExecutor } from "../apps/server/src/engine/team-model.ts";
import { createTeamTaskContext, TeamEngine } from "../apps/server/src/engine/teams.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type {
  AgentTask,
  AgentTeam,
  ModelProfile,
  TaskThreadMessage,
} from "../packages/domain/src/agent.ts";

process.env.OPENAI_API_KEY ??= "test-openai-server-key";
process.env.ANTHROPIC_API_KEY ??= "test-anthropic-server-key";

const profiles: ModelProfile[] = [
  {
    id: "fast",
    label: "Fast",
    provider: "openai",
    model: "openai/fast-model",
    capabilities: ["chat", "tools"],
    enabled: true,
    available: true,
  },
  {
    id: "deep",
    label: "Deep",
    provider: "anthropic",
    model: "anthropic/deep-model",
    capabilities: ["chat", "coding"],
    enabled: true,
    available: true,
  },
];

function team(execution: AgentTeam["execution"] = "parallel"): AgentTeam {
  return {
    id: "team-1",
    name: "Build team",
    execution,
    roles: [
      {
        id: "planner",
        label: "Planner",
        kind: "planner",
        modelId: "deep",
        systemPrompt: "Plan the work",
        dependsOn: [],
      },
      {
        id: "coder",
        label: "Coder",
        kind: "coder",
        modelId: "fast",
        systemPrompt: "Implement the plan",
        dependsOn: [],
      },
      {
        id: "reviewer",
        label: "Reviewer",
        kind: "reviewer",
        modelId: "deep",
        systemPrompt: "Review both results",
        dependsOn: ["planner", "coder"],
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
  };
}

function taskFor(teamValue = team()): AgentTask {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "task-1",
    title: "Ship a feature",
    prompt: "Ship a feature with tests",
    kind: "agent",
    status: "queued",
    teamId: teamValue.id,
    teamContext: createTeamTaskContext(teamValue),
    plan: [],
    evidence: [],
    input: {},
    state: { teamExecution: teamValue.execution },
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    leaseId: null,
    leaseUntil: null,
    artifactIds: [],
  };
}

test("model catalog is an explicit server allowlist", () => {
  assert.deepEqual(parseModelCatalog(undefined, "openai/gpt-test")[0], {
    id: "default",
    label: "openai/gpt-test",
    provider: "openai",
    model: "openai/gpt-test",
    capabilities: ["chat", "tools"],
    enabled: true,
    available: true,
  });
  const configured = parseModelCatalog(
    JSON.stringify([{ id: "work", label: "Work", model: "anthropic/claude-test" }]),
  );
  assert.equal(configured[0]?.provider, "anthropic");
  assert.throws(() =>
    parseModelCatalog(JSON.stringify([{ id: "bad", label: "Bad", model: "other/model" }])),
  );
  assert.throws(() =>
    parseModelCatalog(
      JSON.stringify([
        { id: "same", label: "One", model: "openai/one" },
        { id: "same", label: "Two", model: "openai/two" },
      ]),
    ),
  );
});

test("model selection skips missing provider credentials while keeping catalog entries visible", async () => {
  const previousGoogle = {
    google: process.env.GOOGLE_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    generative: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  };
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const db = await createStore();
  try {
    const registry = new ModelRegistry(db, {
      mode: "sample",
      port: 8787,
      host: "127.0.0.1",
      publicUrl: "http://localhost:8787",
      dataDir: ".",
      agentBackend: "model",
      intelligenceApiKey: "test",
      googleRedirectUri: "http://localhost:8787/api/google/callback",
      allowedOrigins: [],
      models: [
        {
          id: "missing-google",
          label: "Missing Google",
          provider: "google",
          model: "google/gemini-test",
          capabilities: ["chat"],
          enabled: true,
          available: true,
        },
        profiles[0] as ModelProfile,
      ],
    });
    assert.deepEqual(
      registry.list().map(({ id, available, unavailableReason }) => ({
        id,
        available,
        unavailableReason,
      })),
      [
        {
          id: "missing-google",
          available: false,
          unavailableReason: "missing_credentials",
        },
        { id: "fast", available: true, unavailableReason: undefined },
      ],
    );
    assert.equal((await registry.selection("owner")).modelId, "fast");
    await assert.rejects(registry.select("owner", "missing-google"), /credential/);
  } finally {
    await db.close();
    if (previousGoogle.google === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = previousGoogle.google;
    if (previousGoogle.gemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGoogle.gemini;
    if (previousGoogle.generative === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = previousGoogle.generative;
  }
});

test("parallel team branches merge deterministically before dependent roles", async () => {
  const db = await createStore();
  try {
    const initial = taskFor();
    await db.put("owner", "tasks", initial);
    let rootStarts = 0;
    let releaseRoots!: () => void;
    const rootsReady = new Promise<void>((resolve) => {
      releaseRoots = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    const engine = new TeamEngine(db, async ({ role, dependencyContext }) => {
      calls.push(role.id);
      active++;
      maxActive = Math.max(maxActive, active);
      if (role.id !== "reviewer") {
        rootStarts++;
        if (rootStarts === 2) releaseRoots();
        await rootsReady;
      } else {
        assert.deepEqual(dependencyContext, { planner: "planner-output", coder: "coder-output" });
      }
      active--;
      return { output: `${role.id}-output` };
    });
    await new TaskWorker(db, (owner, value, ctx) => engine.execute(owner, value, ctx)).tick();
    const saved = await db.get<AgentTask>("owner", "tasks", initial.id);
    assert.equal(saved?.status, "succeeded");
    assert.equal(maxActive, 2);
    assert.deepEqual(calls.slice(0, 2).sort(), ["coder", "planner"]);
    assert.equal(calls[2], "reviewer");
    assert.deepEqual(saved?.teamContext?.sharedContext, {
      planner: "planner-output",
      coder: "coder-output",
      reviewer: "reviewer-output",
    });
    const messages = await db.list<TaskThreadMessage>("owner", "task-thread-messages");
    assert.deepEqual(messages.map((message) => message.roleLabel).sort(), [
      "Coder",
      "Planner",
      "Reviewer",
    ]);
  } finally {
    await db.close();
  }
});

test("team role checkpoints survive restart and retry only interrupted work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-team-restart-"));
  try {
    let db = await createStore({ dataDir: join(directory, "db") });
    const initial = taskFor(team("sequential"));
    if (!initial.teamContext) throw new Error("missing context");
    initial.status = "running";
    initial.leaseId = "expired";
    initial.leaseUntil = "2020-01-01T00:00:00.000Z";
    initial.teamContext.status = "running";
    const plannerRun = initial.teamContext.roleRuns[0];
    const coderRun = initial.teamContext.roleRuns[1];
    if (!plannerRun || !coderRun) throw new Error("missing role runs");
    initial.teamContext.roleRuns[0] = {
      ...plannerRun,
      status: "succeeded",
      attempts: 1,
      output: "saved-plan",
    };
    initial.teamContext.roleRuns[1] = {
      ...coderRun,
      status: "running",
      attempts: 1,
    };
    initial.teamContext.sharedContext = { planner: "saved-plan" };
    await db.put("owner", "tasks", initial);
    await db.close();

    db = await createStore({ dataDir: join(directory, "db") });
    try {
      const executed: string[] = [];
      const engine = new TeamEngine(db, async ({ role, dependencyContext }) => {
        executed.push(role.id);
        assert.equal(dependencyContext.planner, "saved-plan");
        return { output: `${role.id}-resumed` };
      });
      await new TaskWorker(db, (owner, value, ctx) => engine.execute(owner, value, ctx)).tick();
      const saved = await db.get<AgentTask>("owner", "tasks", initial.id);
      assert.deepEqual(executed, ["coder", "reviewer"]);
      assert.equal(saved?.status, "succeeded");
      assert.equal(saved?.teamContext?.roleRuns[0]?.attempts, 1);
      assert.equal(saved?.teamContext?.roleRuns[1]?.attempts, 2);
    } finally {
      await db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("team failures preserve independent successes and cancel only downstream roles", async () => {
  const db = await createStore();
  try {
    const initial = taskFor();
    await db.put("owner", "tasks", initial);
    const engine = new TeamEngine(db, async ({ role }) => {
      if (role.id === "planner") throw new Error("planning failed");
      return { output: `${role.id}-output` };
    });
    await new TaskWorker(db, (owner, value, ctx) => engine.execute(owner, value, ctx)).tick();
    const saved = await db.get<AgentTask>("owner", "tasks", initial.id);
    assert.equal(saved?.status, "failed");
    assert.deepEqual(
      saved?.teamContext?.roleRuns.map((run) => run.status),
      ["failed", "succeeded", "cancelled"],
    );
    assert.deepEqual(saved?.teamContext?.sharedContext, { coder: "coder-output" });
    assert.equal(saved?.teamContext?.roleRuns[2]?.error, "A dependency failed");
  } finally {
    await db.close();
  }
});

test("model/team APIs persist selection and preserve retry and cancellation state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-model-api-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
    models: profiles,
  };
  const server = await createApp(db, config);
  try {
    const session = await server.app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const token = String((await session.json()).token);
    const api = (path: string, method = "GET", body?: unknown) =>
      server.app.request(`/api/agent${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const listed = (await (await api("/models")).json()) as ModelProfile[];
    assert.deepEqual(
      listed.map(({ id, available, unavailableReason }) => ({ id, available, unavailableReason })),
      [
        { id: "fast", available: true, unavailableReason: undefined },
        { id: "deep", available: true, unavailableReason: undefined },
      ],
    );
    assert.equal((await api("/model-settings", "PUT", { modelId: "unknown" })).status, 422);
    assert.equal((await api("/model-settings", "PUT", { modelId: "fast" })).status, 200);
    const first = (await (
      await api("/tasks", "POST", { prompt: "First task" })
    ).json()) as AgentTask;
    assert.equal(first.modelId, "fast");
    await api("/model-settings", "PATCH", { modelId: "deep" });
    assert.equal((await server.agent.getTask("local-user", first.id)).modelId, "fast");
    await api("/model-settings", "PATCH", { modelId: null });
    const clearedSelection = await api("/model-settings");
    assert.equal((await clearedSelection.json()).modelId, null);
    const unconfigured = (await (
      await api("/tasks", "POST", { prompt: "Wait for model" })
    ).json()) as AgentTask;
    assert.equal(unconfigured.modelId, null);
    await api("/model-settings", "PATCH", { modelId: "deep" });

    const invalidTeam = team();
    const invalidPlanner = invalidTeam.roles[0];
    if (!invalidPlanner) throw new Error("missing planner");
    invalidPlanner.dependsOn = ["reviewer"];
    assert.equal((await api("/teams", "POST", invalidTeam)).status, 422);
    const created = (await (
      await api("/teams", "POST", {
        name: "Build team",
        execution: "parallel",
        roles: team().roles,
      })
    ).json()) as AgentTeam;
    const launched = (await (
      await api("/tasks", "POST", { prompt: "Team task", teamId: created.id })
    ).json()) as AgentTask;
    assert.equal(launched.teamContext?.teamRevision, created.revision);
    assert.equal(
      (await api("/tasks", "POST", { prompt: "Bad", modelId: "fast", teamId: created.id })).status,
      422,
    );
    if (!launched.teamContext) throw new Error("missing team context");
    const failed: AgentTask = {
      ...launched,
      status: "failed",
      error: "coder failed",
      teamContext: {
        ...launched.teamContext,
        status: "failed",
        sharedContext: { planner: "saved plan" },
        roleRuns: launched.teamContext.roleRuns.map((run, index) =>
          index === 0
            ? { ...run, status: "succeeded", output: "saved plan", attempts: 1 }
            : index === 1
              ? { ...run, status: "failed", error: "coder failed", attempts: 1 }
              : { ...run, status: "cancelled", error: "A dependency failed" },
        ),
      },
    };
    await db.put("local-user", "tasks", failed);
    const retried = (await (
      await api(`/tasks/${launched.id}/control`, "POST", { action: "retry" })
    ).json()) as AgentTask;
    assert.deepEqual(
      retried.teamContext?.roleRuns.map((run) => run.status),
      ["succeeded", "pending", "pending"],
    );
    const cancelled = (await (
      await api(`/tasks/${launched.id}/control`, "POST", { action: "cancel" })
    ).json()) as AgentTask;
    assert.equal(cancelled.teamContext?.status, "cancelled");
    assert.deepEqual(
      cancelled.teamContext?.roleRuns.map((run) => run.status),
      ["succeeded", "cancelled", "cancelled"],
    );
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("queued standalone and team work execute immutable model snapshots after catalog remap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-model-snapshot-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const config = (modelName: string): Config => ({
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    models: [
      {
        id: "stable-id",
        label: "Stable ID",
        provider: "openai",
        model: modelName,
        capabilities: ["chat", "coding", "tools"],
        enabled: true,
        available: true,
      },
    ],
  });
  const first = await createApp(db, config("openai/original-model"));
  try {
    const standalone = await first.agent.createTask("owner", {
      prompt: "Run the snapshotted model",
      modelId: "stable-id",
    });
    const createdTeam = await first.agent.createTeam("owner", {
      name: "Snapshot team",
      execution: "sequential",
      roles: [
        {
          id: "coder",
          label: "Coder",
          kind: "coder",
          modelId: "stable-id",
          systemPrompt: "Implement",
          dependsOn: [],
        },
      ],
    });
    const teamTask = await first.agent.createTask("owner", {
      prompt: "Run the snapshotted team",
      teamId: createdTeam.id,
    });
    assert.equal(standalone.modelSnapshot?.model, "openai/original-model");
    assert.equal(teamTask.teamContext?.roles[0]?.modelSnapshot?.model, "openai/original-model");

    const remapped = config("openai/remapped-model");
    const second = await createApp(db, remapped);
    try {
      let standaloneModel = "";
      Object.defineProperty(second.agent, "pi", {
        value: {
          supports: async () => true,
          run: async (input: { profile: ModelProfile }) => {
            standaloneModel = input.profile.model;
            return "snapshot executed";
          },
        },
      });
      let current: AgentTask = { ...standalone, status: "running" };
      await executeModelTask(second.agent, "owner", current, {
        signal: new AbortController().signal,
        guard: async () => {},
        checkpoint: async (patch) => {
          current = { ...current, ...patch };
          return current;
        },
        event: async () => {},
      });
      assert.equal(standaloneModel, "openai/original-model");

      let teamModel = "";
      const executor = new TeamModelExecutor(
        new ModelRegistry(db, remapped),
        new RuntimeHookPipeline([
          {
            id: "capture",
            supports: () => true,
            guard: async () => {},
            prepare: async () => ({}),
            execute: async (request) => {
              teamModel = request.model;
              return { output: "snapshot executed" };
            },
          },
        ]),
      );
      const role = teamTask.teamContext?.roles[0];
      if (!role) throw new Error("missing snapshotted role");
      await executor.execute({
        owner: "owner",
        task: teamTask,
        role,
        dependencyContext: {},
        signal: new AbortController().signal,
      });
      assert.equal(teamModel, "openai/original-model");
    } finally {
      await second.agent.stop();
    }
  } finally {
    await first.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
