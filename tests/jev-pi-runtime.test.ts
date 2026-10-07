import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { createApp } from "../apps/server/src/app.ts";
import type { ComputerService } from "../apps/server/src/computer.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import {
  type JevDecisionClient,
  JevGuardRuntimeHook,
  JevRuntime,
} from "../apps/server/src/engine/jev-runtime.ts";
import { RuntimeSettingsService } from "../apps/server/src/engine/jev-settings.ts";
import { executeModelTask } from "../apps/server/src/engine/model.ts";
import { ModelRegistry } from "../apps/server/src/engine/models.ts";
import {
  type PiAgentRunInput,
  PiAgentRunner,
  type PiAgentSessionFactory,
} from "../apps/server/src/engine/pi-agent.ts";
import {
  configuredPiModel,
  PiRuntimeHook,
  type PiSessionFactory,
} from "../apps/server/src/engine/pi-runtime.ts";
import { adaptCopilotTools } from "../apps/server/src/engine/pi-tools.ts";
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
import { JevClient } from "../packages/integrations/src/jev.ts";
import { fixture as computerFixture, ok, sandbox } from "./helpers/computer.ts";

process.env.OPENAI_API_KEY ??= "test-openai-server-key";

const model: ModelProfile = {
  id: "coder",
  label: "Coder",
  provider: "openai",
  model: "openai/test-coder",
  capabilities: ["chat", "coding", "tools"],
  enabled: true,
  available: true,
};

const configFor = (dataDir: string): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "model",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
  models: [model],
});

const team = (): AgentTeam => ({
  id: "coding-team",
  name: "Coding team",
  execution: "sequential",
  roles: [
    {
      id: "coder",
      label: "Coder",
      kind: "coder",
      modelId: model.id,
      systemPrompt: "Implement and verify the change",
      dependsOn: [],
    },
  ],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  revision: 1,
});

const task = (): AgentTask => {
  const selected = team();
  return {
    id: "runtime-task",
    title: "Implement a bounded change",
    prompt: "Create and verify a small implementation",
    kind: "agent",
    status: "queued",
    teamId: selected.id,
    teamContext: createTeamTaskContext(selected),
    plan: [],
    evidence: [],
    input: {},
    state: { teamExecution: "sequential" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attempts: 0,
    leaseId: null,
    leaseUntil: null,
    artifactIds: [],
  };
};

const standaloneTask = (): AgentTask => ({
  ...task(),
  id: "standalone-runtime-task",
  status: "running",
  modelId: model.id,
  teamId: undefined,
  teamContext: undefined,
  state: {},
});

test("official Jev SDK adapter sends constrained System One questions with bounded retries", async () => {
  const calls: { url: string; init?: RequestInit; body: Record<string, unknown> }[] = [];
  const client = new JevClient({
    apiKey: "jev-test-key",
    model: "jev-latest",
    timeoutMs: 1500,
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        init,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          model: "jev-latest",
          answers: {
            execution: {
              type: "choice",
              choice: "allow",
              confidence: 0.97,
              probabilities: { allow: 0.97, block: 0.03 },
            },
          },
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  const answer = await client.guardExecution(
    {
      taskId: "task",
      taskKind: "agent",
      taskPrompt: "safe work",
      roleId: "coder",
      roleKind: "coder",
      model: "openai/test",
      dependencyCount: 0,
    },
    new AbortController().signal,
  );
  assert.equal(answer.choice, "allow");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer jev-test-key");
  assert.equal(calls[0]?.body.model, "jev-latest");
  const questions = calls[0]?.body.questions as Record<string, { type: string }> | undefined;
  assert.equal(questions?.execution?.type, "choice");
});

test("pi registers an allowlisted OpenCodex model on the Responses API without exposing its key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-opencodex-"));
  try {
    const { runtime, model: configured } = await configuredPiModel(
      {
        ...configFor(directory),
        openCodexBaseUrl: "https://data.example.test/v1",
        openCodexApiKey: "ocx-server-data-key",
      },
      directory,
      "opencodex/vendor/coder",
    );
    assert.equal(configured.id, "vendor/coder");
    assert.equal(configured.api, "openai-responses");
    assert.equal(configured.baseUrl, "https://data.example.test/v1");
    assert.equal(configured.provider, "openmuse-opencodex");
    assert.equal(JSON.stringify(configured).includes("ocx-server-data-key"), false);
    assert.equal(runtime.hasConfiguredAuth("openmuse-opencodex"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime settings API is owner scoped, encrypted, redacted, and pi-enabled by default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-jev-settings-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(db, configFor(directory));
  try {
    const session = await server.app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const token = String((await session.json()).token);
    const request = (method: string, body?: unknown) =>
      server.app.request("/api/agent/runtime-settings", {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const initial = await (await request("GET")).json();
    assert.equal(initial.jev.enabled, false);
    assert.equal(initial.jev.configured, false);
    assert.equal(initial.pi.enabled, true);
    assert.equal((await request("PATCH", { jev: { enabled: true } })).status, 422);
    const savedResponse = await request("PATCH", {
      jev: { apiKey: "jev-owner-secret", enabled: true, failMode: "local-budget" },
      pi: { enabled: true, maxIterations: 2, timeoutMs: 20000 },
    });
    assert.equal(savedResponse.status, 200);
    const savedText = await savedResponse.text();
    assert.equal(savedText.includes("jev-owner-secret"), false);
    const saved = JSON.parse(savedText);
    assert.equal(saved.jev.configured, true);
    assert.equal(saved.pi.maxIterations, 2);
    const credential = await db.get<{ secret: string }>("local-user", "runtime-credentials", "jev");
    assert.ok(credential?.secret.startsWith("v1."));
    assert.equal(credential?.secret.includes("jev-owner-secret"), false);
    const afterRestart = await new RuntimeSettingsService(db, configFor(directory)).view(
      "local-user",
    );
    assert.equal(afterRestart.jev.enabled, true);
    assert.equal(afterRestart.jev.configured, true);
    assert.equal((await request("PATCH", { jev: { apiKey: null } })).status, 422);
    assert.equal((await (await request("GET")).json()).jev.configured, true);
    const disabled = await (
      await request("PATCH", { jev: { enabled: false, apiKey: null } })
    ).json();
    assert.equal(disabled.jev.configured, false);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("team coder path invokes Jev guard/context/termination and applies continue then complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-jev-pi-path-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  try {
    const config = configFor(directory);
    const settings = new RuntimeSettingsService(db, config);
    await settings.update("owner", {
      jev: { apiKey: "jev-test-key", enabled: true },
      pi: { enabled: true, maxIterations: 3, timeoutMs: 20000 },
    });
    const calls = { guard: 0, context: 0, termination: 0, prompts: 0 };
    const decisions: JevDecisionClient = {
      guardExecution: async () => {
        calls.guard++;
        return { choice: "allow", confidence: 0.99 };
      },
      selectContext: async () => {
        calls.context++;
        return { choice: "dependencies", confidence: 0.9 };
      },
      guardTool: async () => ({ choice: "allow", confidence: 1 }),
      decideTermination: async () => ({
        choice: ++calls.termination === 1 ? "continue" : "complete",
        confidence: 0.95,
      }),
    };
    const jev = new JevRuntime(settings, () => decisions);
    const outputs = ["implemented", "implemented and verified"];
    const factory: PiSessionFactory = async () => ({
      prompt: async () => {
        calls.prompts++;
      },
      abort: async () => {},
      dispose: () => {},
      getLastAssistantText: () => outputs[calls.prompts - 1],
    });
    const hooks = new RuntimeHookPipeline([
      new JevGuardRuntimeHook(jev),
      new PiRuntimeHook(db, config, {} as ComputerService, undefined, jev, factory),
    ]);
    const roleExecutor = new TeamModelExecutor(new ModelRegistry(db, config), hooks);
    const engine = new TeamEngine(db, (input) => roleExecutor.execute(input));
    const initial = task();
    await db.put("owner", "tasks", initial);
    await new TaskWorker(db, (owner, value, ctx) => engine.execute(owner, value, ctx)).tick();
    const saved = await db.get<AgentTask>("owner", "tasks", initial.id);
    assert.equal(saved?.status, "succeeded");
    assert.equal(saved?.teamContext?.sharedContext.coder, "implemented and verified");
    assert.deepEqual(calls, { guard: 1, context: 1, termination: 2, prompts: 2 });
    const checkpoint = await db.get<{
      id: string;
      status: string;
      iteration: number;
      toolCalls: number;
      output: string;
      updatedAt: string;
    }>("owner", "pi-runtime", `${initial.id}:coder`);
    assert.deepEqual(checkpoint, {
      id: `${initial.id}:coder`,
      iteration: 2,
      toolCalls: 0,
      status: "succeeded",
      output: "implemented and verified",
      updatedAt: checkpoint?.updatedAt,
    });
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("all Ollama team roles use pi and persist dependency-aware speaker metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-ollama-team-roles-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  try {
    const ollama: ModelProfile = {
      id: "local-team",
      label: "Local team",
      provider: "ollama",
      model: "ollama/qwen3:8b",
      capabilities: ["chat", "tools"],
      enabled: true,
      available: true,
    };
    const config = {
      ...configFor(directory),
      models: [ollama],
      ollamaBaseUrl: "http://127.0.0.1:11434",
    };
    const settings = new RuntimeSettingsService(db, config);
    const jev = new JevRuntime(settings);
    const prompts = new Map<string, string>();
    const hook = new PiRuntimeHook(
      db,
      config,
      {} as ComputerService,
      undefined,
      jev,
      async (input) => ({
        prompt: async (prompt) => {
          prompts.set(input.request.role.id, prompt);
        },
        abort: async () => {},
        dispose: () => {},
        getLastAssistantText: () => `${input.request.role.id}-output`,
      }),
    );
    const selected: AgentTeam = {
      id: "ollama-role-team",
      name: "Ollama role team",
      execution: "sequential",
      roles: [
        {
          id: "planner",
          label: "Planner",
          kind: "planner",
          modelId: ollama.id,
          systemPrompt: "Plan the work",
          dependsOn: [],
        },
        {
          id: "coder",
          label: "Coder",
          kind: "coder",
          modelId: ollama.id,
          systemPrompt: "Implement the plan",
          dependsOn: ["planner"],
        },
        {
          id: "reviewer",
          label: "Reviewer",
          kind: "reviewer",
          modelId: ollama.id,
          systemPrompt: "Review the result",
          dependsOn: ["planner", "coder"],
        },
      ],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      revision: 1,
    };
    const value: AgentTask = {
      ...task(),
      id: "ollama-role-task",
      teamId: selected.id,
      teamContext: createTeamTaskContext(selected),
    };
    const planner = selected.roles[0];
    if (!planner) throw new Error("missing planner role");
    const executor = new TeamModelExecutor(
      new ModelRegistry(db, config),
      new RuntimeHookPipeline([hook]),
    );
    await db.put("owner", "tasks", value);
    await new TaskWorker(db, (owner, next, ctx) =>
      new TeamEngine(db, (input) => executor.execute(input)).execute(owner, next, ctx),
    ).tick();

    const saved = await db.get<AgentTask>("owner", "tasks", value.id);
    assert.equal(saved?.status, "succeeded");
    assert.match(prompts.get("coder") ?? "", /planner-output/);
    assert.match(prompts.get("reviewer") ?? "", /planner-output/);
    assert.match(prompts.get("reviewer") ?? "", /coder-output/);
    const messages = await db.list<TaskThreadMessage>("owner", "task-thread-messages");
    assert.deepEqual(
      messages
        .map(({ role, roleId, roleLabel, modelId }) => ({ role, roleId, roleLabel, modelId }))
        .sort((a, b) => String(a.roleId).localeCompare(String(b.roleId))),
      [
        { role: "assistant", roleId: "coder", roleLabel: "Coder", modelId: ollama.id },
        { role: "assistant", roleId: "planner", roleLabel: "Planner", modelId: ollama.id },
        { role: "assistant", roleId: "reviewer", roleLabel: "Reviewer", modelId: ollama.id },
      ],
    );
    assert.equal(
      await hook.supports({
        owner: "owner",
        task: value,
        role: { ...planner, modelId: model.id },
        model: model.model,
        capabilities: model.capabilities,
        dependencyContext: {},
        signal: new AbortController().signal,
      }),
      false,
      "non-Ollama planner roles must retain their existing conversation path",
    );
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("team pi propagates isolated Jev preflight and tool fallbacks into one-turn output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-team-fallback-propagation-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  try {
    const config = configFor(directory);
    const settings = new RuntimeSettingsService(db, config);
    await settings.update("owner", {
      jev: { apiKey: "jev-test-key", enabled: true, failMode: "local-budget" },
      pi: { enabled: true, maxIterations: 5, timeoutMs: 20000 },
    });
    for (const stage of ["preflight", "tool"] as const) {
      let prompts = 0;
      const jev = new JevRuntime(settings, () => ({
        guardExecution: async () => {
          if (stage === "preflight") throw new Error("preflight unavailable");
          return { choice: "allow", confidence: 1 };
        },
        selectContext: async () => ({ choice: "minimal", confidence: 1 }),
        guardTool: async () => ({ choice: "allow", confidence: 1 }),
        decideTermination: async () => ({ choice: "continue", confidence: 1 }),
      }));
      const hook = new PiRuntimeHook(
        db,
        config,
        {} as ComputerService,
        undefined,
        jev,
        async (input) => ({
          prompt: async () => {
            prompts++;
            if (stage === "tool") input.onPolicyFallback();
          },
          abort: async () => {},
          dispose: () => {},
          getLastAssistantText: () => "bounded team result",
        }),
      );
      const executor = new TeamModelExecutor(
        new ModelRegistry(db, config),
        new RuntimeHookPipeline([new JevGuardRuntimeHook(jev), hook]),
      );
      const role = team().roles[0];
      if (!role) throw new Error("missing role");
      const result = await executor.execute({
        owner: "owner",
        task: { ...task(), id: `team-${stage}` },
        role,
        dependencyContext: {},
        signal: new AbortController().signal,
      });
      assert.equal(prompts, 1);
      assert.match(result.output, /one-turn local budget/);
    }
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("team pi keeps preflight fallback context minimal and honors a later termination block", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-team-fallback-precedence-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  try {
    const config = configFor(directory);
    const settings = new RuntimeSettingsService(db, config);
    await settings.update("owner", {
      jev: { apiKey: "jev-test-key", enabled: true, failMode: "local-budget" },
      pi: { enabled: true, maxIterations: 5, timeoutMs: 20000 },
    });
    const jev = new JevRuntime(settings, () => ({
      guardExecution: async () => {
        throw new Error("preflight unavailable");
      },
      selectContext: async () => ({ choice: "full", confidence: 1 }),
      guardTool: async () => ({ choice: "allow", confidence: 1 }),
      decideTermination: async () => ({ choice: "block", confidence: 1 }),
    }));
    let receivedPrompt = "";
    const hook = new PiRuntimeHook(db, config, {} as ComputerService, undefined, jev, async () => ({
      prompt: async (prompt) => {
        receivedPrompt = prompt;
      },
      abort: async () => {},
      dispose: () => {},
      getLastAssistantText: () => "unsafe team result",
    }));
    const executor = new TeamModelExecutor(
      new ModelRegistry(db, config),
      new RuntimeHookPipeline([new JevGuardRuntimeHook(jev), hook]),
    );
    const role = team().roles[0];
    if (!role) throw new Error("missing coder role");
    await assert.rejects(
      executor.execute({
        owner: "owner",
        task: { ...task(), id: "team-fallback-precedence", prompt: "x".repeat(10000) },
        role,
        dependencyContext: {},
        signal: new AbortController().signal,
      }),
      /Jev blocked the coding loop result/,
    );
    assert.match(receivedPrompt, /\[truncated by context diet\]/);
    assert.ok(receivedPrompt.length < 7000);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Jev block prevents pi session creation and local-budget outage permits only one turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-jev-guard-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  try {
    const config = configFor(directory);
    const settings = new RuntimeSettingsService(db, config);
    await settings.update("owner", {
      jev: { apiKey: "jev-test-key", enabled: true },
      pi: { enabled: true, maxIterations: 5, timeoutMs: 20000 },
    });
    let sessions = 0;
    const blocked = new JevRuntime(settings, () => ({
      guardExecution: async () => ({ choice: "block", confidence: 0.99 }),
      selectContext: async () => ({ choice: "full", confidence: 1 }),
      guardTool: async () => ({ choice: "block", confidence: 1 }),
      decideTermination: async () => ({ choice: "complete", confidence: 1 }),
    }));
    const factory: PiSessionFactory = async () => {
      sessions++;
      return {
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        getLastAssistantText: () => "bounded output",
      };
    };
    const role = team().roles[0];
    if (!role) throw new Error("missing coder role");
    const request = {
      owner: "owner",
      task: task(),
      role,
      capabilities: model.capabilities,
      dependencyContext: {},
      signal: new AbortController().signal,
    };
    const executor = new TeamModelExecutor(
      new ModelRegistry(db, config),
      new RuntimeHookPipeline([
        new JevGuardRuntimeHook(blocked),
        new PiRuntimeHook(db, config, {} as ComputerService, undefined, blocked, factory),
      ]),
    );
    await assert.rejects(executor.execute(request), /Jev blocked/);
    assert.equal(sessions, 0);

    await settings.update("owner", { jev: { failMode: "local-budget" } });
    const unavailable = new JevRuntime(settings, () => ({
      guardExecution: async () => {
        throw new Error("service unavailable");
      },
      selectContext: async () => {
        throw new Error("service unavailable");
      },
      guardTool: async () => {
        throw new Error("service unavailable");
      },
      decideTermination: async () => {
        throw new Error("service unavailable");
      },
    }));
    const fallback = new TeamModelExecutor(
      new ModelRegistry(db, config),
      new RuntimeHookPipeline([
        new JevGuardRuntimeHook(unavailable),
        new PiRuntimeHook(db, config, {} as ComputerService, undefined, unavailable, factory),
      ]),
    );
    const result = await fallback.execute({
      ...request,
      task: { ...request.task, id: "fallback-task" },
    });
    assert.match(result.output, /^bounded output/);
    assert.match(result.output, /one-turn local budget/);
    assert.equal(sessions, 1);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pi interruption is cancelled and a retry resumes the durable bounded iteration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-resume-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  try {
    const config = configFor(directory);
    const settings = new RuntimeSettingsService(db, config);
    await settings.update("owner", {
      jev: { apiKey: "jev-test-key", enabled: true },
      pi: { enabled: true, maxIterations: 3, timeoutMs: 20000 },
    });
    let terminationCalls = 0;
    const jev = new JevRuntime(settings, () => ({
      guardExecution: async () => ({ choice: "allow", confidence: 1 }),
      selectContext: async () => ({ choice: "minimal", confidence: 1 }),
      guardTool: async () => ({ choice: "allow", confidence: 1 }),
      decideTermination: async () => ({
        choice: ++terminationCalls === 1 ? "continue" : "complete",
        confidence: 1,
      }),
    }));
    const role = team().roles[0];
    if (!role) throw new Error("missing coder role");
    const roleRequest = {
      owner: "owner",
      task: task(),
      role,
      model: model.model,
      capabilities: model.capabilities,
      dependencyContext: {},
      signal: new AbortController().signal,
      systemPrompt: "Implement safely",
      context: { pi: { profile: "minimal", mode: "jev" } },
    } as const;
    let firstPrompts = 0;
    const firstFactory: PiSessionFactory = async (input) => ({
      sessionFile: join(directory, "mock-session.jsonl"),
      prompt: async () => {
        firstPrompts++;
        if (firstPrompts === 2) {
          await input.onToolCall();
          throw new Error("simulated process loss");
        }
      },
      abort: async () => {},
      dispose: () => {},
      getLastAssistantText: () => "first verified step",
    });
    const first = new PiRuntimeHook(
      db,
      config,
      {} as ComputerService,
      undefined,
      jev,
      firstFactory,
    );
    await assert.rejects(first.execute(roleRequest), /simulated process loss/);
    const interrupted = await db.get<{
      iteration: number;
      output?: string;
      status: string;
      toolCalls: number;
    }>("owner", "pi-runtime", "runtime-task:coder");
    assert.equal(interrupted?.iteration, 1);
    assert.equal(interrupted?.output, "first verified step");
    assert.equal(interrupted?.status, "failed");
    assert.equal(interrupted?.toolCalls, 1);

    let resumedCheckpoint = 0;
    let resumedToolCalls = 0;
    const retry = new PiRuntimeHook(
      db,
      config,
      {} as ComputerService,
      undefined,
      jev,
      async (input) => {
        resumedCheckpoint = input.checkpoint?.iteration ?? -1;
        resumedToolCalls = input.checkpoint?.toolCalls ?? -1;
        return {
          prompt: async () => {},
          abort: async () => {},
          dispose: () => {},
          getLastAssistantText: () => "resumed and complete",
        };
      },
    );
    assert.equal((await retry.execute(roleRequest)).output, "resumed and complete");
    assert.equal(resumedCheckpoint, 1);
    assert.equal(resumedToolCalls, 1);

    const cancelController = new AbortController();
    let rejectPrompt: ((error: Error) => void) | undefined;
    let aborts = 0;
    const cancelledTask = { ...roleRequest.task, id: "cancelled-runtime-task" };
    const cancelled = new PiRuntimeHook(
      db,
      config,
      {} as ComputerService,
      undefined,
      jev,
      async () => ({
        prompt: () =>
          new Promise<void>((_resolve, reject) => {
            rejectPrompt = reject;
          }),
        abort: async () => {
          aborts++;
          rejectPrompt?.(new Error("cancelled by task signal"));
        },
        dispose: () => {},
        getLastAssistantText: () => undefined,
      }),
    );
    const running = cancelled.execute({
      ...roleRequest,
      task: cancelledTask,
      signal: cancelController.signal,
    });
    setTimeout(() => cancelController.abort(), 10);
    await assert.rejects(running, /cancelled by task signal/);
    assert.equal(aborts, 1);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared pi runner persists non-team sessions, reuses completed runs, and records cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-shared-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  try {
    const config = configFor(directory);
    const settings = new RuntimeSettingsService(db, config);
    const jev = new JevRuntime(settings);
    let sessions = 0;
    let resumedFile: string | undefined;
    const factory: PiAgentSessionFactory = async (input) => {
      sessions++;
      resumedFile = input.sessionFile;
      return {
        sessionFile: join(directory, "shared-session.jsonl"),
        prompt: async () => {},
        abort: async () => {},
        dispose: () => {},
        getLastAssistantText: () => "completed through embedded pi",
        subscribe: () => () => {},
      };
    };
    const runner = new PiAgentRunner(db, config, jev, factory);
    const taskValue = standaloneTask();
    const request = {
      owner: "owner",
      task: taskValue,
      role: {
        id: "agent",
        label: "Delegated agent",
        kind: "coder" as const,
        modelId: model.id,
        systemPrompt: "Use reviewed tools",
        dependsOn: [],
      },
      model: model.model,
      capabilities: model.capabilities,
      dependencyContext: {},
      signal: new AbortController().signal,
    };
    const run = {
      owner: "owner",
      profile: model,
      request,
      sessionKey: `task:${taskValue.id}`,
      runKey: `task:${taskValue.id}:1`,
      systemPrompt: "Use reviewed tools",
      prompt: taskValue.prompt,
      tools: [],
    };
    assert.equal(await runner.run(run), "completed through embedded pi");
    assert.equal(
      await new PiAgentRunner(db, config, jev, factory).run(run),
      "completed through embedded pi",
    );
    assert.equal(sessions, 1);
    await runner.run({ ...run, runKey: `task:${taskValue.id}:2` });
    assert.equal(sessions, 2);
    assert.equal(resumedFile, join(directory, "shared-session.jsonl"));

    const controller = new AbortController();
    let rejectPrompt: ((error: Error) => void) | undefined;
    const cancelled = new PiAgentRunner(db, config, jev, async () => ({
      prompt: () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
      abort: async () => rejectPrompt?.(new Error("cancelled by shared signal")),
      dispose: () => {},
      getLastAssistantText: () => undefined,
      subscribe: () => () => {},
    }));
    const cancelledRun = cancelled.run({
      ...run,
      request: { ...request, signal: controller.signal },
      runKey: `task:${taskValue.id}:cancel`,
    });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(cancelledRun, /cancelled by shared signal/);
    const records = await db.list<{ status: string; error?: string }>("owner", "pi-agent-runs");
    assert.ok(records.some((record) => record.status === "cancelled"));
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("formal task completion reprompts narrative-only pi output until a terminal tool outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-formal-completion-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  try {
    const config = configFor(directory);
    const jev = new JevRuntime(new RuntimeSettingsService(db, config));
    const prompts: string[] = [];
    let terminal = false;
    const runner = new PiAgentRunner(db, config, jev, async () => ({
      prompt: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 2) terminal = true;
      },
      abort: async () => {},
      dispose: () => {},
      getLastAssistantText: () =>
        prompts.length === 1
          ? "I would use the tools and then claim completion."
          : "Completed only after the terminal tool outcome.",
      subscribe: () => () => {},
    }));
    const taskValue = { ...standaloneTask(), id: "formal-completion-task" };
    const retryPrompt = "Use the registered terminal task tool now.";
    const output = await runner.run({
      owner: "owner",
      profile: model,
      request: {
        owner: "owner",
        task: taskValue,
        role: {
          id: "agent",
          label: "Delegated agent",
          kind: "coder",
          modelId: model.id,
          systemPrompt: "Use reviewed tools",
          dependsOn: [],
        },
        model: model.model,
        capabilities: model.capabilities,
        dependencyContext: {},
        signal: new AbortController().signal,
      },
      sessionKey: `task:${taskValue.id}`,
      runKey: `task:${taskValue.id}:formal`,
      systemPrompt: "Use reviewed tools",
      prompt: taskValue.prompt,
      tools: [],
      completion: { isTerminal: () => terminal, retryPrompt },
    });
    assert.equal(output, "Completed only after the terminal tool outcome.");
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1], retryPrompt);
    const [checkpoint] = await db.list<{ status: string; iteration: number }>(
      "owner",
      "pi-agent-runs",
    );
    assert.equal(checkpoint?.status, "succeeded");
    assert.equal(checkpoint?.iteration, 2);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("formal task completion fails at the existing iteration bound without a terminal tool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-formal-bound-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  try {
    const config = configFor(directory);
    const settings = new RuntimeSettingsService(db, config);
    await settings.update("owner", { pi: { maxIterations: 2 } });
    const jev = new JevRuntime(settings);
    let prompts = 0;
    const runner = new PiAgentRunner(db, config, jev, async () => ({
      prompt: async () => {
        prompts += 1;
      },
      abort: async () => {},
      dispose: () => {},
      getLastAssistantText: () => "Narrative output without a terminal tool call.",
      subscribe: () => () => {},
    }));
    const taskValue = { ...standaloneTask(), id: "formal-bound-task" };
    await assert.rejects(
      runner.run({
        owner: "owner",
        profile: model,
        request: {
          owner: "owner",
          task: taskValue,
          role: {
            id: "agent",
            label: "Delegated agent",
            kind: "coder",
            modelId: model.id,
            systemPrompt: "Use reviewed tools",
            dependsOn: [],
          },
          model: model.model,
          capabilities: model.capabilities,
          dependencyContext: {},
          signal: new AbortController().signal,
        },
        sessionKey: `task:${taskValue.id}`,
        runKey: `task:${taskValue.id}:formal`,
        systemPrompt: "Use reviewed tools",
        prompt: taskValue.prompt,
        tools: [],
        completion: { isTerminal: () => false, retryPrompt: "Use a terminal tool." },
      }),
      /2-iteration limit without a terminal task tool outcome/,
    );
    assert.equal(prompts, 2);
    const [checkpoint] = await db.list<{ status: string; iteration: number; error?: string }>(
      "owner",
      "pi-agent-runs",
    );
    assert.equal(checkpoint?.status, "failed");
    assert.equal(checkpoint?.iteration, 2);
    assert.match(checkpoint?.error ?? "", /terminal task tool outcome/);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("default pi admits adapted tools with Jev disabled and aborts in-flight execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-adapted-cancel-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  try {
    const settings = new RuntimeSettingsService(db, configFor(directory));
    const jev = new JevRuntime(settings);
    const controller = new AbortController();
    let aborted = 0;
    const request = {
      owner: "owner",
      task: standaloneTask(),
      role: {
        id: "agent",
        label: "Agent",
        kind: "coder" as const,
        modelId: model.id,
        systemPrompt: "Use reviewed tools",
        dependsOn: [],
      },
      model: model.model,
      capabilities: model.capabilities,
      dependencyContext: {},
      signal: new AbortController().signal,
    };
    const [adapted] = adaptCopilotTools(
      [
        defineTool({
          name: "wait_for_abort",
          description: "Wait until the runtime cancels",
          parameters: z.object({}),
          execute: () => new Promise(() => {}),
        }),
      ],
      { jev },
      request,
      () => 1,
      32,
      () => {
        aborted++;
      },
    );
    if (!adapted) throw new Error("missing adapted tool");
    const running = adapted.execute("call", {}, controller.signal, undefined, {} as never);
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(running, /cancelled/);
    assert.equal(aborted, 1);
    assert.deepEqual(await jev.guardTool(request, "safe_tool", {}, request.signal), {
      value: "allow",
      fallback: false,
      confidence: 1,
    });
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared pi first-prompt recovery restores bounded context without resetting its run key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-first-prompt-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  try {
    const config = configFor(directory);
    const jev = new JevRuntime(new RuntimeSettingsService(db, config));
    const taskValue = standaloneTask();
    const request = {
      owner: "owner",
      task: taskValue,
      role: {
        id: "agent",
        label: "Agent",
        kind: "coder" as const,
        modelId: model.id,
        systemPrompt: "Use reviewed tools",
        dependsOn: [],
      },
      model: model.model,
      capabilities: model.capabilities,
      dependencyContext: {},
      signal: new AbortController().signal,
    };
    const run = {
      owner: "owner",
      profile: model,
      request,
      sessionKey: `task:${taskValue.id}`,
      runKey: `task:${taskValue.id}:stable-generation`,
      systemPrompt: "Use reviewed tools",
      prompt: "Original durable task context",
      tools: [],
    };
    const sessionFile = join(directory, "first-prompt.jsonl");
    const interrupted = new PiAgentRunner(db, config, jev, async (input) => ({
      sessionFile,
      prompt: async () => {
        await input.onToolCall();
        throw new Error("process lost during first prompt");
      },
      abort: async () => {},
      dispose: () => {},
      getLastAssistantText: () => undefined,
      subscribe: () => () => {},
    }));
    await assert.rejects(interrupted.run(run), /process lost/);
    assert.ok(
      (await db.list<{ toolCalls: number }>("owner", "pi-agent-runs")).some(
        (record) => record.toolCalls === 1,
      ),
    );

    let recoveryPrompt = "";
    let resumedFile: string | undefined;
    const resumed = new PiAgentRunner(db, config, jev, async (input) => {
      resumedFile = input.sessionFile;
      return {
        sessionFile,
        prompt: async (prompt) => {
          recoveryPrompt = prompt;
        },
        abort: async () => {},
        dispose: () => {},
        getLastAssistantText: () => "recovered",
        subscribe: () => () => {},
      };
    });
    assert.equal(await resumed.run(run), "recovered");
    assert.equal(resumedFile, sessionFile);
    assert.match(recoveryPrompt, /Original durable task context/);
    assert.match(recoveryPrompt, /without repeating completed side effects/);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared pi applies one-turn four-tool local budget when Jev fails before or after a prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-shared-budget-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  try {
    const config = configFor(directory);
    const settings = new RuntimeSettingsService(db, config);
    await settings.update("owner", {
      jev: { apiKey: "jev-test-key", enabled: true, failMode: "local-budget" },
      pi: { enabled: true, maxIterations: 8, timeoutMs: 20000 },
    });
    const request = {
      owner: "owner",
      task: standaloneTask(),
      role: {
        id: "agent",
        label: "Agent",
        kind: "coder" as const,
        modelId: model.id,
        systemPrompt: "Use reviewed tools",
        dependsOn: [],
      },
      model: model.model,
      capabilities: model.capabilities,
      dependencyContext: {},
      signal: new AbortController().signal,
    };
    const baseRun = {
      owner: "owner",
      profile: model,
      request,
      sessionKey: "task:budget",
      systemPrompt: "Use reviewed tools",
      prompt: "Complete within fallback bounds",
      tools: [],
    };
    for (const stage of ["preflight", "tool", "termination"] as const) {
      let prompts = 0;
      let maxTools = 0;
      const jev = new JevRuntime(settings, () => ({
        guardExecution: async () => {
          if (stage === "preflight") throw new Error("preflight unavailable");
          return { choice: "allow", confidence: 1 };
        },
        selectContext: async () => ({ choice: "minimal", confidence: 1 }),
        guardTool: async () => ({ choice: "allow", confidence: 1 }),
        decideTermination: async () => {
          if (stage === "termination") throw new Error("termination unavailable");
          return { choice: "continue", confidence: 1 };
        },
      }));
      const runner = new PiAgentRunner(db, config, jev, async (input) => {
        maxTools = input.maxToolCalls;
        return {
          prompt: async () => {
            prompts++;
            if (stage === "tool") input.onPolicyFallback();
          },
          abort: async () => {},
          dispose: () => {},
          getLastAssistantText: () => "bounded result",
          subscribe: () => () => {},
        };
      });
      const output = await runner.run({
        ...baseRun,
        runKey: `task:budget:${stage}`,
      });
      assert.equal(prompts, 1);
      assert.equal(maxTools, 4);
      assert.match(output, /one-turn local budget/);
    }
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared pi keeps preflight fallback context minimal and honors a later termination block", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-shared-fallback-precedence-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  try {
    const config = configFor(directory);
    const settings = new RuntimeSettingsService(db, config);
    await settings.update("owner", {
      jev: { apiKey: "jev-test-key", enabled: true, failMode: "local-budget" },
      pi: { enabled: true, maxIterations: 5, timeoutMs: 20000 },
    });
    const jev = new JevRuntime(settings, () => ({
      guardExecution: async () => {
        throw new Error("preflight unavailable");
      },
      selectContext: async () => ({ choice: "full", confidence: 1 }),
      guardTool: async () => ({ choice: "allow", confidence: 1 }),
      decideTermination: async () => ({ choice: "block", confidence: 1 }),
    }));
    let receivedPrompt = "";
    const runner = new PiAgentRunner(db, config, jev, async () => ({
      prompt: async (prompt) => {
        receivedPrompt = prompt;
      },
      abort: async () => {},
      dispose: () => {},
      getLastAssistantText: () => "unsafe shared result",
      subscribe: () => () => {},
    }));
    await assert.rejects(
      runner.run({
        owner: "owner",
        profile: model,
        request: {
          owner: "owner",
          task: standaloneTask(),
          role: {
            id: "agent",
            label: "Agent",
            kind: "coder",
            modelId: model.id,
            systemPrompt: "Use reviewed tools",
            dependsOn: [],
          },
          model: model.model,
          capabilities: model.capabilities,
          dependencyContext: {},
          signal: new AbortController().signal,
        },
        sessionKey: "task:fallback-precedence",
        runKey: "task:fallback-precedence:run",
        systemPrompt: "Use reviewed tools",
        prompt: "x".repeat(20000),
        tools: [],
      }),
      /Jev blocked the runtime result/,
    );
    assert.match(receivedPrompt, /\[truncated by runtime limit\]/);
    assert.ok(receivedPrompt.length < 13000);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("coding-capable standalone task and conversation paths select the shared pi runner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-call-paths-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(db, configFor(directory));
  try {
    const calls: PiAgentRunInput[] = [];
    const fakePi = {
      supports: async (_owner: string, profile: ModelProfile) =>
        profile.capabilities.includes("coding"),
      run: async (input: PiAgentRunInput) => {
        calls.push(input);
        input.onTextDelta?.("streamed by pi");
        input.onToolStart?.("pi-tool", "agent_status", {});
        input.onToolStart?.("pi-tool-parallel", "runtime_status", {});
        input.onToolEnd?.("pi-tool-parallel", "runtime_status", { parallel: true }, false);
        input.onToolEnd?.("pi-tool", "agent_status", { ok: true }, false);
        return "streamed by pi";
      },
    };
    Object.defineProperty(server.agent, "pi", { value: fakePi });

    let current = standaloneTask();
    const taskResult = await executeModelTask(server.agent, "owner", current, {
      signal: new AbortController().signal,
      guard: async () => {},
      checkpoint: async (patch) => {
        current = { ...current, ...patch };
        return current;
      },
      event: async () => {},
    });
    assert.equal(calls[0]?.request.task.id, current.id);
    assert.equal(
      calls[0]?.tools.some((tool) => tool.name === "finish_task"),
      true,
    );
    assert.equal(taskResult.status, "waiting_input");

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    await new Promise<void>((resolve, reject) => {
      new ConversationAgent(configFor(directory), server.agent, "owner", model)
        .run({
          threadId: "pi-chat",
          runId: "pi-chat-run",
          messages: [{ id: "user-message", role: "user", content: "Inspect status" }],
          state: {},
          tools: [],
          context: [],
          forwardedProps: {},
        })
        .subscribe({
          next: (event) => events.push(event),
          error: reject,
          complete: resolve,
        });
    });
    assert.equal(calls[1]?.sessionKey, "chat:pi-chat");
    assert.equal(
      calls[1]?.tools.some((tool) => tool.name === "agent_status"),
      true,
    );
    assert.ok(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT"));
    assert.ok(events.some((event) => event.type === "TOOL_CALL_START"));
    assert.ok(events.some((event) => event.type === "RUN_FINISHED"));
    assert.deepEqual(
      events.filter((e) => e.type.startsWith("TOOL_CALL_")).map((e) => [e.type, e.toolCallId]),
      [
        ["TOOL_CALL_START", "pi-tool"],
        ["TOOL_CALL_ARGS", "pi-tool"],
        ["TOOL_CALL_END", "pi-tool"],
        ["TOOL_CALL_START", "pi-tool-parallel"],
        ["TOOL_CALL_ARGS", "pi-tool-parallel"],
        ["TOOL_CALL_END", "pi-tool-parallel"],
        ["TOOL_CALL_RESULT", "pi-tool-parallel"],
        ["TOOL_CALL_RESULT", "pi-tool"],
      ],
    );
    // Exercise AG-UI's actual event validator, including a follow-up on this ID.
    const chat = new ConversationAgent(configFor(directory), server.agent, "owner", model);
    chat.threadId = "pi-chat-validated";
    for (const runId of ["parallel-first", "parallel-followup"]) {
      await chat.runAgent({ runId });
      assert.equal(chat.messages.filter((m) => m.role === "tool").length > 0, true);
    }
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("formal finish rejects durable failed computer evidence until a later recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-completion-evidence-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(db, configFor(directory));
  try {
    let unresolved = true;
    Object.defineProperty(server.agent, "computer", {
      value: {
        completionEvidence: async () =>
          unresolved
            ? {
                commandCount: 1,
                successfulCount: 0,
                unresolvedFailure: {
                  id: "failed-command",
                  status: "failed",
                  startedAt: new Date().toISOString(),
                },
              }
            : { commandCount: 2, successfulCount: 1 },
      } as unknown as ComputerService,
    });
    const finishResults: unknown[] = [];
    Object.defineProperty(server.agent, "pi", {
      value: {
        supports: async () => true,
        run: async (input: PiAgentRunInput) => {
          const finish = input.tools.find((tool) => tool.name === "finish_task");
          assert.ok(finish?.execute);
          finishResults.push(await finish.execute({ summary: "Recovered computer work." }));
          return "Attempted formal completion.";
        },
      },
    });
    let current: AgentTask = {
      ...standaloneTask(),
      id: "failed-resume-completion-task",
      attempts: 2,
      state: { answer: "Retry the failed operation." },
    };
    const context = {
      signal: new AbortController().signal,
      guard: async () => {},
      checkpoint: async (patch: Partial<AgentTask>) => {
        current = { ...current, ...patch };
        return current;
      },
      event: async () => {},
    };
    const blocked = await executeModelTask(server.agent, "owner", current, context);
    assert.equal(blocked.status, "waiting_input");
    assert.deepEqual(finishResults[0], {
      complete: false,
      error:
        "A task-scoped computer command is not durably successful. Wait for it or recover with a later successful command, then verify the result before finishing.",
      commandStatus: "failed",
    });
    assert.equal((await db.list("owner", "agent-artifacts")).length, 0);

    unresolved = false;
    const recovered = await executeModelTask(server.agent, "owner", current, context);
    assert.equal(recovered.status, "succeeded");
    assert.deepEqual(finishResults[1], { complete: true });
    assert.equal((await db.list("owner", "agent-artifacts")).length, 1);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("formal finish rejects a stopped-computer failure before receipt creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-prereceipt-failure-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const inspection = sandbox(false);
  const computer = computerFixture({ inspect: inspection });
  const server = await createApp(
    db,
    { ...configFor(directory), computerEnabled: true },
    { docker: computer.runner },
  );
  try {
    const taskId = "prereceipt-failure-task";
    const scope = `task:${taskId}`;
    let runs = 0;
    const finishResults: unknown[] = [];
    Object.defineProperty(server.agent, "pi", {
      value: {
        supports: async () => true,
        run: async (input: PiAgentRunInput) => {
          runs++;
          const command = input.tools.find((tool) => tool.name === "run_computer_command");
          const finish = input.tools.find((tool) => tool.name === "finish_task");
          assert.ok(command?.execute);
          assert.ok(finish?.execute);
          const commandResult = await command.execute({
            operationId: runs === 1 ? "stopped" : "recovery",
            command: runs === 1 ? "false" : "printf recovered",
            cwd: "/workspace",
          });
          if (runs === 1)
            assert.deepEqual(commandResult, {
              error: "Start the computer before using its terminal or files",
            });
          finishResults.push(await finish.execute({ summary: "Recovered computer work." }));
          return "Attempted formal completion.";
        },
      },
    });
    let current: AgentTask = { ...standaloneTask(), id: taskId };
    const context = {
      signal: new AbortController().signal,
      guard: async () => {},
      checkpoint: async (patch: Partial<AgentTask>) => {
        current = { ...current, ...patch };
        return current;
      },
      event: async () => {},
    };
    const blocked = await executeModelTask(server.agent, "owner", current, context);
    assert.equal(blocked.status, "waiting_input");
    assert.equal(
      (await server.agent.computer.completionEvidence("owner", scope)).unresolvedFailure?.status,
      "pending",
    );
    assert.deepEqual(finishResults[0], {
      complete: false,
      error:
        "A task-scoped computer command is not durably successful. Wait for it or recover with a later successful command, then verify the result before finishing.",
      commandStatus: "pending",
    });
    assert.equal((await db.list("owner", "agent-artifacts")).length, 0);

    inspection.State.Running = true;
    const recovered = await executeModelTask(server.agent, "owner", current, context);
    assert.equal(recovered.status, "succeeded");
    assert.deepEqual(finishResults[1], { complete: true });
    assert.equal((await db.list("owner", "agent-artifacts")).length, 1);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("formal finish blocks an in-flight scoped command and permits its durable success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-inflight-completion-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  let releaseCommand: (() => void) | undefined;
  let commandStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  const computer = computerFixture({
    command: async () => {
      commandStarted?.();
      await released;
      return ok("recovered");
    },
  });
  const server = await createApp(
    db,
    { ...configFor(directory), computerEnabled: true },
    { docker: computer.runner },
  );
  try {
    const taskId = "inflight-completion-task";
    const scope = `task:${taskId}`;
    const runningCommand = server.agent.computer.execute(
      "owner",
      { command: "printf recovered" },
      { idempotencyKey: `${scope}:overlap`, scope },
    );
    await started;
    const finishResults: unknown[] = [];
    Object.defineProperty(server.agent, "pi", {
      value: {
        supports: async () => true,
        run: async (input: PiAgentRunInput) => {
          const finish = input.tools.find((tool) => tool.name === "finish_task");
          assert.ok(finish?.execute);
          finishResults.push(await finish.execute({ summary: "Recovered computer work." }));
          return "Attempted formal completion.";
        },
      },
    });
    let current: AgentTask = { ...standaloneTask(), id: taskId };
    const context = {
      signal: new AbortController().signal,
      guard: async () => {},
      checkpoint: async (patch: Partial<AgentTask>) => {
        current = { ...current, ...patch };
        return current;
      },
      event: async () => {},
    };
    const blocked = await executeModelTask(server.agent, "owner", current, context);
    assert.equal(blocked.status, "waiting_input");
    assert.deepEqual(finishResults[0], {
      complete: false,
      error:
        "A task-scoped computer command is not durably successful. Wait for it or recover with a later successful command, then verify the result before finishing.",
      commandStatus: "running",
    });
    assert.equal((await db.list("owner", "agent-artifacts")).length, 0);

    releaseCommand?.();
    assert.equal((await runningCommand).status, "succeeded");
    const recovered = await executeModelTask(server.agent, "owner", current, context);
    assert.equal(recovered.status, "succeeded");
    assert.deepEqual(finishResults[1], { complete: true });
    assert.equal((await db.list("owner", "agent-artifacts")).length, 1);
  } finally {
    releaseCommand?.();
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-batch computer command serializes before formal finish evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-same-batch-completion-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  let releaseCommand: (() => void) | undefined;
  let commandStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  const computer = computerFixture({
    command: async () => {
      commandStarted?.();
      await released;
      return { ...ok(), exitCode: 7 };
    },
  });
  const server = await createApp(
    db,
    { ...configFor(directory), computerEnabled: true },
    { docker: computer.runner },
  );
  try {
    const taskId = "same-batch-completion-task";
    let finishSettledBeforeCommand = false;
    let finishResult: unknown;
    Object.defineProperty(server.agent, "pi", {
      value: {
        supports: async () => true,
        run: async (input: PiAgentRunInput) => {
          const command = input.tools.find((tool) => tool.name === "run_computer_command");
          const finish = input.tools.find((tool) => tool.name === "finish_task");
          assert.ok(command?.execute);
          assert.ok(finish?.execute);
          const commandPromise = command.execute({
            operationId: "same-batch",
            command: "exit 7",
            cwd: "/workspace",
          });
          let finishSettled = false;
          const finishPromise = finish
            .execute({ summary: "Must not finish early." })
            .then((value) => {
              finishSettled = true;
              return value;
            });
          await started;
          await new Promise((resolve) => setImmediate(resolve));
          finishSettledBeforeCommand = finishSettled;
          releaseCommand?.();
          const [commandResult, terminalResult] = await Promise.all([
            commandPromise,
            finishPromise,
          ]);
          assert.equal((commandResult as { status?: string }).status, "failed");
          finishResult = terminalResult;
          return "Attempted same-batch completion.";
        },
      },
    });
    let current: AgentTask = { ...standaloneTask(), id: taskId };
    const result = await executeModelTask(server.agent, "owner", current, {
      signal: new AbortController().signal,
      guard: async () => {},
      checkpoint: async (patch) => {
        current = { ...current, ...patch };
        return current;
      },
      event: async () => {},
    });
    assert.equal(finishSettledBeforeCommand, false);
    assert.equal(result.status, "waiting_input");
    assert.deepEqual(finishResult, {
      complete: false,
      error:
        "A task-scoped computer command is not durably successful. Wait for it or recover with a later successful command, then verify the result before finishing.",
      commandStatus: "failed",
    });
    assert.equal((await db.list("owner", "agent-artifacts")).length, 0);
  } finally {
    releaseCommand?.();
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("formal finish remains valid for text-only tasks without computer receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-text-completion-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(db, configFor(directory));
  try {
    Object.defineProperty(server.agent, "computer", {
      value: {
        completionEvidence: async () => ({ commandCount: 0, successfulCount: 0 }),
      } as unknown as ComputerService,
    });
    Object.defineProperty(server.agent, "pi", {
      value: {
        supports: async () => true,
        run: async (input: PiAgentRunInput) => {
          const finish = input.tools.find((tool) => tool.name === "finish_task");
          assert.ok(finish?.execute);
          assert.deepEqual(await finish.execute({ summary: "Text-only work completed." }), {
            complete: true,
          });
          return "Text-only work completed.";
        },
      },
    });
    let current = { ...standaloneTask(), id: "text-only-completion-task" };
    const result = await executeModelTask(server.agent, "owner", current, {
      signal: new AbortController().signal,
      guard: async () => {},
      checkpoint: async (patch) => {
        current = { ...current, ...patch };
        return current;
      },
      event: async () => {},
    });
    assert.equal(result.status, "succeeded");
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("standalone pi abort bridge reaches an in-flight isolated computer command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pi-computer-abort-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(db, configFor(directory));
  try {
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve;
    });
    let observedAbort = false;
    Object.defineProperty(server.agent, "computer", {
      value: {
        execute: async (_owner: string, _args: unknown, options: { signal?: AbortSignal }) => {
          commandStarted();
          await new Promise<void>((_resolve, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                reject(new Error("computer command interrupted"));
              },
              { once: true },
            );
          });
        },
      } as unknown as ComputerService,
    });
    Object.defineProperty(server.agent, "pi", {
      value: {
        supports: async () => true,
        run: async (input: PiAgentRunInput) => {
          const command = input.tools.find((tool) => tool.name === "run_computer_command");
          if (!command?.execute) throw new Error("missing computer command tool");
          const running = command.execute({ operationId: "cancel-me", command: "sleep 30" });
          await started;
          input.abortTools?.();
          assert.deepEqual(await running, { error: "computer command interrupted" });
          return "cancelled safely";
        },
      },
    });
    let current = standaloneTask();
    await executeModelTask(server.agent, "owner", current, {
      signal: new AbortController().signal,
      guard: async () => {},
      checkpoint: async (patch) => {
        current = { ...current, ...patch };
        return current;
      },
      event: async () => {},
    });
    assert.equal(observedAbort, true);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
