import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { ConversationThread } from "../apps/server/src/conversations.ts";
import { createStore } from "../apps/server/src/db.ts";
import { threadNameKey } from "../packages/domain/src/thread-name.ts";

let directory: string,
  db: Awaited<ReturnType<typeof createStore>>,
  server: Awaited<ReturnType<typeof createApp>>;
let headers: Record<string, string>;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-session-names-"));
  db = await createStore();
  server = await createApp(db, {
    mode: "sample",
    agentBackend: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    googleRedirectUri: "http://localhost/callback",
    allowedOrigins: [],
  });
  headers = {
    Authorization: `Bearer ${(await server.auth.session()).token}`,
    "Content-Type": "application/json",
  };
});
after(async () => {
  server.hostEvents.close();
  await server.agent.stop();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});
const create = (id: string, name: string) =>
  server.app.request("/api/copilotkit/threads", {
    method: "POST",
    headers,
    body: JSON.stringify({ id, name }),
  });

test("normalized names are atomic and owner-scoped; rejected creation leaves no ghost thread", async () => {
  const results = await Promise.all([
    create("race-a", "Ｐｉｃｋｅｒ"),
    create("race-b", " picker "),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const response = results.find((r) => r.status === 201);
  assert.ok(response);
  const winner = await response.json();
  assert.equal(
    (await db.list<ConversationThread>("local-user", "conversation-threads")).filter((t) =>
      t.id.startsWith("race-"),
    ).length,
    1,
  );
  assert.equal((await server.conversations.resolveTarget("local-user", "PiCkEr")).id, winner.id);
  await server.conversations.create("other", { id: "other-picker", name: "picker" });
  assert.equal((await server.conversations.resolveTarget("other", "picker")).id, "other-picker");
  await assert.rejects(server.conversations.resolveTarget("stranger", "picker"), { status: 404 });
  await server.conversations.setArchived("local-user", winner.id, true);
  assert.equal((await create("duplicate-archived", "picker")).status, 409);
  assert.equal(await db.get("local-user", "conversation-threads", "duplicate-archived"), null);
});

test("rename conflicts preserve messages, ID and names, including concurrent renames", async () => {
  for (const id of ["rename-a", "rename-b"])
    await server.conversations.create("local-user", { id, name: id });
  const result = await Promise.allSettled([
    server.conversations.rename("local-user", "rename-a", "한글 이름"),
    server.conversations.rename("local-user", "rename-b", "한글  이름"),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  const loser = result[0].status === "rejected" ? "rename-a" : "rename-b";
  assert.equal((await server.conversations.get("local-user", loser)).name, loser);
  await assert.rejects(server.conversations.rename("local-user", loser, "\n"));
  assert.equal(
    (await server.conversations.resolveTarget("local-user", "name:한글 이름")).name,
    "한글 이름",
  );
});

test("legacy duplicate names migrate deterministically without modifying history or selection IDs", async () => {
  for (const [id, archived] of [
    ["legacy-active", false],
    ["legacy-archived", true],
  ] as const) {
    const thread = await server.conversations.ensure("legacy-owner", id);
    await db.put("legacy-owner", "conversation-threads", {
      ...thread,
      name: "Duplicate",
      archived,
      messages: [{ id: "saved", role: "user", content: "Preserve this" }],
    });
  }
  await server.conversations.prepareNames();
  const active = await server.conversations.get("legacy-owner", "legacy-active"),
    archived = await server.conversations.get("legacy-owner", "legacy-archived");
  assert.equal(active.name, "Duplicate");
  assert.ok(active.name && archived.name);
  assert.notEqual(threadNameKey(active.name), threadNameKey(archived.name));
  assert.equal(archived.messages[0].content, "Preserve this");
  assert.equal(archived.archived, true);
  const again = JSON.stringify(await db.list("legacy-owner", "conversation-threads"));
  await server.conversations.prepareNames();
  assert.equal(JSON.stringify(await db.list("legacy-owner", "conversation-threads")), again);
});

test("read-only metadata/approval and reconnect do not create sessions; archive filtering precedes pagination", async () => {
  for (const path of [
    "/api/copilotkit/threads/deleted-session",
    "/api/copilotkit/threads/deleted-session/approval",
  ])
    assert.equal((await server.app.request(path, { headers })).status, 404);
  assert.equal(await db.get("local-user", "conversation-threads", "deleted-session"), null);
  const owner = "pagination-owner";
  await server.conversations.create(owner, { id: "active-thread", name: "Active" });
  for (let n = 0; n < 5; n++) {
    await server.conversations.create(owner, { id: `archived-${n}`, name: `Archived ${n}` });
    await server.conversations.setArchived(owner, `archived-${n}`, true);
  }
  const active = await server.conversations.list(owner, {
    includeArchived: true,
    archived: false,
    limit: 1,
  });
  assert.equal(active.threads[0].id, "active-thread");
  assert.equal(active.nextCursor, null);
  const archived = await server.conversations.list(owner, {
    includeArchived: true,
    archived: true,
    limit: 2,
  });
  assert.equal(archived.threads.length, 2);
  assert.ok(archived.threads.every((t) => t.archived));
  assert.ok(archived.nextCursor);
  const thread = await server.conversations.get(owner, "active-thread");
  assert.ok(!("nameKey" in server.conversations.metadata(thread)));
});
