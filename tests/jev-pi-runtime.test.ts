import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { ComputerService } from "../apps/server/src/computer.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import {
  type JevDecisionClient,
  JevGuardRuntimeHook,
  JevRuntime,
} from "../apps/server/src/engine/jev-runtime.ts";
import { RuntimeSettingsService } from "../apps/server/src/engine/jev-settings.ts";
import { ModelRegistry } from "../apps/server/src/engine/models.ts";
import {
  configuredPiModel,
  PiRuntimeHook,
  type PiSessionFactory,
} from "../apps/server/src/engine/pi-runtime.ts";
import { RuntimeHookPipeline } from "../apps/server/src/engine/runtime-hooks.ts";
import { TeamModelExecutor } from "../apps/server/src/engine/team-model.ts";
import { createTeamTaskContext, TeamEngine } from "../apps/server/src/engine/teams.ts";
import { TaskWorker } from "../apps/server/src/engine/worker.ts";
import type { AgentTask, AgentTeam, ModelProfile } from "../packages/domain/src/agent.ts";
import { JevClient } from "../packages/integrations/src/jev.ts";

const model: ModelProfile = {
  id: "coder",
  label: "Coder",
  provider: "openai",
  model: "openai/test-coder",
  capabilities: ["chat", "coding", "tools"],
  enabled: true,
};

const configFor = (dataDir: string): Config => ({
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir,
  agentBackend: "model",
  intelligenceApiKey: "test-project-key-never-sent",
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

test("runtime settings API is owner scoped, encrypted, redacted, and disabled by default", async () => {
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
    assert.equal(initial.pi.enabled, false);
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
      dependencyContext: {},
      signal: new AbortController().signal,
      systemPrompt: "Implement safely",
      context: { pi: { profile: "minimal", mode: "jev" } },
    } as const;
    let firstPrompts = 0;
    const firstFactory: PiSessionFactory = async () => ({
      sessionFile: join(directory, "mock-session.jsonl"),
      prompt: async () => {
        firstPrompts++;
        if (firstPrompts === 2) throw new Error("simulated process loss");
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
    const interrupted = await db.get<{ iteration: number; output?: string; status: string }>(
      "owner",
      "pi-runtime",
      "runtime-task:coder",
    );
    assert.equal(interrupted?.iteration, 1);
    assert.equal(interrupted?.output, "first verified step");
    assert.equal(interrupted?.status, "failed");

    let resumedCheckpoint = 0;
    const retry = new PiRuntimeHook(
      db,
      config,
      {} as ComputerService,
      undefined,
      jev,
      async (input) => {
        resumedCheckpoint = input.checkpoint?.iteration ?? -1;
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
