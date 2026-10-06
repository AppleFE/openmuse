import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import type { PiAgentRunInput } from "../apps/server/src/engine/pi-agent.ts";
import { TeamModelExecutor } from "../apps/server/src/engine/team-model.ts";
import {
  ThreadKnowledgeService,
  threadKnowledgeTools,
} from "../apps/server/src/thread-knowledge.ts";
import {
  emptyThreadKnowledge,
  threadKnowledgePrompt,
} from "../packages/domain/src/thread-knowledge.ts";
import { modelFixture } from "./helpers/model.ts";

let db: Store,
  directory: string,
  config: Config,
  server: Awaited<ReturnType<typeof createApp>>,
  token: string;
const path = (id: string) => `/api/copilotkit/threads/${id}/knowledge`;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const previousKey = process.env.OPENAI_API_KEY;
async function create(id: string) {
  const response = await server.app.request("/api/copilotkit/threads", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ id, name: id }),
  });
  assert.equal(response.status, 201);
}
const book = (notes = "IP=192.0.2.11; ssh operator@192.0.2.11 -p 2222") => ({
  ...emptyThreadKnowledge(),
  category: "홈서버",
  issue: "스토리지 #42",
  notes,
  documents: [
    { id: "access", title: "접속 방법", content: "PINNED_ACCESS_MARKER", pinned: true },
    { id: "manual", title: "운영 문서", content: "UNPINNED_DOCUMENT_MARKER", pinned: false },
  ],
});
function input(threadId: string): RunAgentInput {
  return {
    threadId,
    runId: crypto.randomUUID(),
    messages: [
      {
        id: crypto.randomUUID(),
        role: "user",
        content: "저장된 접속 방법과 운영 문서를 확인하세요.",
      },
    ],
    tools: [],
    context: [],
    state: {},
  };
}
before(async () => {
  process.env.OPENAI_API_KEY = "notebook-test-key";
  directory = await mkdtemp(join(tmpdir(), "openmuse-notebook-"));
  db = await createStore();
  config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    googleRedirectUri: "http://localhost/callback",
    allowedOrigins: [],
    models: [
      {
        id: "model",
        label: "Model",
        model: "openai/fixture",
        provider: "openai",
        capabilities: ["chat", "tools", "coding"],
        enabled: true,
        available: true,
      },
    ],
  };
  server = await createApp(db, config);
  token = (await server.auth.session()).token;
});
after(async () => {
  if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousKey;
  await server?.agent.stop();
  await db?.close();
  await rm(directory, { recursive: true, force: true });
});

test("notebooks require authentication and owner scope, default empty and survive fresh service instances", async () => {
  await create("owner-book");
  assert.equal((await server.app.request(path("owner-book"))).status, 401);
  assert.deepEqual(
    await server.agent.knowledge.get("local-user", "owner-book"),
    emptyThreadKnowledge(),
  );
  const otherToken = "another-owner-token";
  await db.put("system", "sessions", {
    id: createHash("sha256").update(otherToken).digest("hex"),
    owner: "other-owner",
    expiresAt: Date.now() + 60000,
  });
  assert.equal(
    (
      await server.app.request(path("owner-book"), {
        headers: { Authorization: `Bearer ${otherToken}` },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await server.app.request(path("owner-book"), {
        method: "PUT",
        headers: { Authorization: `Bearer ${otherToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(book()),
      })
    ).status,
    404,
  );
  const response = await server.app.request(path("owner-book"), {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(book()),
  });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.revision, 1);
  assert.deepEqual(await new ThreadKnowledgeService(db).get("local-user", "owner-book"), saved);
  await create("empty-book");
  assert.equal((await server.agent.knowledge.get("local-user", "empty-book")).notes, "");
});

test("concurrent first saves and stale revisions cannot overwrite edits; archives remain readable", async () => {
  await create("race-book");
  const results = await Promise.all(
    ["A", "B"].map((notes) =>
      server.app.request(path("race-book"), {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify(book(notes)),
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const saved = await server.agent.knowledge.get("local-user", "race-book");
  await server.app.request("/api/copilotkit/threads/race-book/archive", {
    method: "POST",
    headers: headers(),
  });
  await assert.rejects(server.agent.knowledge.save("local-user", "race-book", saved), {
    status: 409,
  });
  assert.deepEqual(await server.agent.knowledge.get("local-user", "race-book"), saved);
  await server.app.request("/api/copilotkit/threads/race-book/restore", {
    method: "POST",
    headers: headers(),
  });
  assert.equal(
    (await server.agent.knowledge.save("local-user", "race-book", { ...saved, notes: "updated" }))
      .revision,
    2,
  );
});

test("limits are explicit, always-included content is not silently truncated and document reads are scoped", async () => {
  await create("limit-book");
  for (const invalid of [
    { ...book(), notes: "x".repeat(6001) },
    {
      ...book(),
      documents: [{ id: "big", title: "Big", content: "x".repeat(12001), pinned: true }],
    },
    { ...book(), documents: [book().documents[0], book().documents[0]] },
  ])
    assert.equal(
      (
        await server.app.request(path("limit-book"), {
          method: "PUT",
          headers: headers(),
          body: JSON.stringify(invalid),
        })
      ).status,
      422,
    );
  const saved = await server.agent.knowledge.save("local-user", "limit-book", book());
  const prompt = threadKnowledgePrompt(saved);
  assert.match(prompt, /192.0.2.11/);
  assert.match(prompt, /PINNED_ACCESS_MARKER/);
  assert.ok(!prompt.includes("UNPINNED_DOCUMENT_MARKER"));
  const read = threadKnowledgeTools(saved).find((t) => t.name === "read_thread_document");
  assert.ok(read?.execute);
  assert.equal(
    ((await read.execute({ id: "manual", offset: 0, limit: 8 })) as { content: string }).content,
    "UNPINNED",
  );
  assert.ok(
    "error" in ((await read.execute({ id: "foreign-id", offset: 0, limit: 10 })) as object),
  );
});

test("thread search uses category/issue across pagination without returning notebook contents", async () => {
  const response = await server.app.request("/api/copilotkit/threads?query=%2342&limit=1", {
    headers: headers(),
  });
  const first = await response.json();
  assert.equal(first.threads.length, 1);
  assert.equal(first.threads[0].knowledgeSummary.issue, "스토리지 #42");
  assert.ok(!("knowledge" in first.threads[0]));
  assert.ok(!JSON.stringify(first).includes("PINNED_ACCESS_MARKER"));
  assert.ok(first.nextCursor);
  const second = await (
    await server.app.request(
      `/api/copilotkit/threads?query=%2342&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
      { headers: headers() },
    )
  ).json();
  assert.notEqual(first.threads[0].id, second.threads[0].id);
});

test("every Pi turn receives current notebook revision; clearing notes overrides previous context and memory defaults to chat", async () => {
  await create("pi-book");
  await server.agent.knowledge.save("local-user", "pi-book", book());
  const calls: PiAgentRunInput[] = [],
    pi = server.agent.pi;
  Object.defineProperty(server.agent, "pi", {
    configurable: true,
    value: {
      supports: async () => true,
      run: async (arg: PiAgentRunInput) => {
        calls.push(arg);
        return "done";
      },
    },
  });
  try {
    const agent = new ConversationAgent(config, server.agent, "local-user", config.models?.[0]);
    await lastValueFrom(agent.run(input("pi-book")).pipe(toArray()));
    assert.match(calls[0].systemPrompt, /PINNED_ACCESS_MARKER/);
    const memory = calls[0].tools.find((t) => t.name === "remember_fact");
    assert.ok(memory?.execute);
    await memory.execute({ text: "remembered only here", scope: "conversation" });
    await memory.execute({ text: "remembered only here", scope: "conversation" });
    const latest = await server.agent.knowledge.get("local-user", "pi-book");
    assert.equal(latest.documents.filter((d) => d.content === "remembered only here").length, 1);
    assert.equal((await db.list("local-user", "memories")).length, 0);
    await server.agent.knowledge.save("local-user", "pi-book", {
      ...emptyThreadKnowledge(),
      revision: latest.revision,
    });
    await lastValueFrom(agent.run(input("pi-book")).pipe(toArray()));
    assert.ok(!calls[1].systemPrompt.includes("PINNED_ACCESS_MARKER"));
    assert.match(calls[1].systemPrompt, /supersedes/);
    await lastValueFrom(agent.run(input("empty-book")).pipe(toArray()));
    assert.ok(!calls[2].systemPrompt.includes("remembered only here"));
  } finally {
    Object.defineProperty(server.agent, "pi", { configurable: true, value: pi });
  }
});

test("standard model transport sees pinned facts and can read unpinned documents without editing history", async (t) => {
  await create("transport-book");
  await server.agent.knowledge.save("local-user", "transport-book", book());
  const { requests } = await modelFixture(t, (i) =>
    i === 0
      ? { name: "read_thread_document", arguments: { id: "manual", offset: 0, limit: 1000 } }
      : undefined,
  );
  const pi = server.agent.pi;
  Object.defineProperty(server.agent, "pi", {
    configurable: true,
    value: { supports: async () => false },
  });
  try {
    const original = input("transport-book"),
      snapshot = structuredClone(original);
    const events = await lastValueFrom(
      new ConversationAgent(config, server.agent, "local-user", config.models?.[0])
        .run(original)
        .pipe(toArray()),
    );
    assert.equal(events.at(-1)?.type, "RUN_FINISHED");
    assert.match(requests[0].body, /PINNED_ACCESS_MARKER/);
    assert.ok(!requests[0].body.includes("UNPINNED_DOCUMENT_MARKER"));
    assert.match(requests[1].body, /UNPINNED_DOCUMENT_MARKER/);
    assert.deepEqual(original, snapshot);
  } finally {
    Object.defineProperty(server.agent, "pi", { configurable: true, value: pi });
  }
});

test("delegated tasks snapshot their origin notebook, retain it for team roles, and do not broadcast it in agent status", async (t) => {
  const { requests } = await modelFixture(t, () => undefined);
  await create("task-book");
  const saved = await server.agent.knowledge.save("local-user", "task-book", book("SNAPSHOT_ONLY"));
  const task = await server.agent.createTask(
    "local-user",
    { kind: "agent", prompt: "Use this notebook", modelId: "model" },
    "notebook-task",
    true,
    "task-book",
  );
  assert.deepEqual(task.threadKnowledge, saved);
  await server.agent.knowledge.save("local-user", "task-book", { ...saved, notes: "NEW_VALUE" });
  assert.equal(
    (await server.agent.getTask("local-user", task.id)).threadKnowledge?.notes,
    "SNAPSHOT_ONLY",
  );
  assert.ok(!(await server.agent.snapshot("local-user")).tasks.some((t) => "threadKnowledge" in t));
  await new TeamModelExecutor(server.agent.models).execute({
    owner: "local-user",
    task,
    role: {
      id: "reviewer",
      label: "Reviewer",
      kind: "reviewer",
      modelId: "model",
      systemPrompt: "Review",
      dependsOn: [],
    },
    dependencyContext: {},
    signal: new AbortController().signal,
  });
  assert.match(requests[0].body, /SNAPSHOT_ONLY/);
  assert.match(requests[0].body, /read_thread_document/);
  assert.ok(!requests[0].body.includes("NEW_VALUE"));
});

test("deleting a conversation deletes its notebook and editing a running chat preserves run state", async () => {
  await create("delete-book");
  await db.compareAndSwap(
    "local-user",
    "conversation-threads",
    "delete-book",
    { activeRunId: null },
    { activeRunId: "running", state: { count: 9 } },
  );
  await server.agent.knowledge.save("local-user", "delete-book", book());
  const thread = await db.get<{ activeRunId: string; state: { count: number } }>(
    "local-user",
    "conversation-threads",
    "delete-book",
  );
  assert.equal(thread?.activeRunId, "running");
  assert.equal(thread?.state.count, 9);
  await db.compareAndSwap(
    "local-user",
    "conversation-threads",
    "delete-book",
    { activeRunId: "running" },
    { activeRunId: null },
  );
  assert.equal(
    (
      await server.app.request("/api/copilotkit/threads/delete-book", {
        method: "DELETE",
        headers: headers(),
      })
    ).status,
    200,
  );
  assert.equal((await server.app.request(path("delete-book"), { headers: headers() })).status, 404);
});
