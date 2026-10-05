import assert from "node:assert/strict";
import test from "node:test";
import { ActionService } from "../apps/server/src/actions.ts";
import { createApp } from "../apps/server/src/app.ts";
import { browserFixture } from "./helpers/browser.ts";

const email = {
  kind: "email.send",
  data: {
    to: ["fixture@example.com"],
    cc: [],
    bcc: [],
    subject: "fixture",
    body: "fixture",
    attachmentIds: [],
  },
};

test("session bypass stays owner/thread scoped, cannot replay writes, and atomically honors revocation", async (t) => {
  const { db } = await browserFixture(t, async () => ({ data: {} }));
  for (const id of ["auto", "manual"])
    await db.put("alice", "conversation-threads", {
      id,
      approvalMode: id === "auto" ? "bypass" : "review",
      archived: false,
    });
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      return "receipt";
    },
    connected: async () => true,
  });
  const manual = await service.proposeForConversation("alice", "manual", email, "manual");
  assert.equal(manual.status, "awaiting_review");
  const foreign = await service.proposeForConversation("bob", "auto", email, "foreign");
  assert.equal(foreign.status, "awaiting_review");
  const [first] = await Promise.all([
    service.proposeForConversation("alice", "auto", email, "once"),
    service.proposeForConversation("alice", "auto", email, "once"),
  ]);
  assert.ok(["succeeded", "executing"].includes(first.status));
  const saved = await service.proposeForConversation("alice", "auto", email, "once");
  assert.equal(saved.status, "succeeded");
  assert.equal(saved.approvalMethod, "session-bypass");
  assert.equal(saved.conversationId, "auto");
  assert.equal(calls, 1);
  const ordinary = await service.propose("alice", email);
  assert.equal(ordinary.status, "awaiting_review");
  await assert.rejects(
    service.decide("alice", ordinary.id, ordinary.hash, "approve", "session-bypass"),
    /원본 대화/,
  );
  const revoke = new ActionService(db, {
    execute: async () => {
      calls++;
      return "unexpected";
    },
    connected: async () => {
      await db.put("alice", "conversation-threads", {
        id: "auto",
        approvalMode: "review",
        archived: false,
      });
      return true;
    },
  });
  assert.equal(
    (await revoke.proposeForConversation("alice", "auto", email, "revoked")).status,
    "awaiting_review",
  );
  assert.equal(calls, 1);
  await db.put("alice", "conversation-threads", {
    id: "auto",
    approvalMode: "bypass",
    archived: true,
  });
  assert.equal(
    (await service.proposeForConversation("alice", "auto", email, "archived")).status,
    "awaiting_review",
  );
  await db.put("alice", "conversation-threads", {
    id: "auto",
    approvalMode: "bypass",
    archived: false,
  });
  await db.put("alice", "tasks", { id: "cancelled", status: "cancelled" });
  await assert.rejects(
    service.proposeForConversation("alice", "auto", email, "cancelled", "cancelled"),
    /Cancelled tasks/,
  );
  assert.equal(calls, 1);
});

test("approval settings are authenticated, persistent, reject active edits and ignore model-supplied provenance", async (t) => {
  const fixture = await browserFixture(t, async () => ({ data: {} }));
  const app = await createApp(fixture.db, fixture.config);
  t.after(() => app.agent.stop());
  const { token } = await app.auth.session();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const path = "/api/copilotkit/threads/setting-fixture/approval";
  assert.equal((await app.app.request(path)).status, 401);
  assert.deepEqual(await (await app.app.request(path, { headers })).json(), { mode: "review" });
  assert.deepEqual(
    await (
      await app.app.request(path, {
        headers,
        method: "PUT",
        body: JSON.stringify({ mode: "bypass" }),
      })
    ).json(),
    { mode: "bypass" },
  );
  assert.deepEqual(await (await app.app.request(path, { headers })).json(), { mode: "bypass" });
  assert.equal(
    (
      await app.app.request(path, {
        headers,
        method: "PUT",
        body: JSON.stringify({ mode: "unknown" }),
      })
    ).status,
    422,
  );
  await fixture.db.compareAndSwap(
    "local-user",
    "conversation-threads",
    "setting-fixture",
    {},
    { activeRunId: "active" },
  );
  assert.equal(
    (
      await app.app.request(path, {
        headers,
        method: "PUT",
        body: JSON.stringify({ mode: "review" }),
      })
    ).status,
    409,
  );
  const task = await app.agent.createTask("local-user", {
    kind: "agent",
    prompt: "fixture",
    sourceThreadId: "setting-fixture",
    approvalMode: "bypass",
  });
  assert.equal(task.sourceThreadId, undefined);
  const bound = await app.agent.createTask(
    "local-user",
    { kind: "agent", prompt: "fixture" },
    undefined,
    false,
    "setting-fixture",
  );
  assert.equal(bound.sourceThreadId, "setting-fixture");
});
