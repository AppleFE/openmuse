import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../apps/server/src/db.ts";
import { ScheduleService, nextScheduleDate } from "../apps/server/src/engine/schedules.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";
test("schedules survive restart, claim due work once across workers and isolate owners", async () => {
  const db = await createStore();
  let clock = Date.parse("2026-10-05T00:00:00Z"),
    calls = 0;
  const launch = async (owner: string, input: any, key: string) => {
    calls++;
    const task = { id: key, status: "queued", ...input } as AgentTask;
    await db.insertIfAbsent(owner, "tasks", task);
    return task;
  };
  try {
    const a = new ScheduleService(db, launch, undefined, () => clock);
    const s = await a.create(
      "alice",
      {
        title: "daily",
        prompt: "read sources",
        timing: { type: "cron", expression: "1 9 * * *", timeZone: "Asia/Seoul" },
      },
      "turn",
    );
    assert.equal(s.nextRunAt, "2026-10-05T00:01:00.000Z");
    assert.equal(
      (
        await a.create(
          "alice",
          {
            title: "daily",
            prompt: "read sources",
            timing: { type: "cron", expression: "1 9 * * *", timeZone: "Asia/Seoul" },
          },
          "turn",
        )
      ).id,
      s.id,
    );
    const b = new ScheduleService(db, launch, undefined, () => clock);
    clock += 60000;
    await Promise.all([a.tick(), b.tick()]);
    assert.equal(calls, 1);
    assert.equal((await a.runs("alice", s.id))[0].status, "dispatched");
    await assert.rejects(a.get("bob", s.id), { status: 404 });
    clock += 86400000;
    await b.tick();
    assert.equal(calls, 1);
    assert.equal((await a.runs("alice", s.id))[0].status, "skipped");
    await a.update("alice", s.id, {
      title: s.title,
      prompt: s.prompt,
      timing: s.timing,
      enabled: false,
    });
    clock += 86400000;
    await a.tick();
    assert.equal(calls, 1);
    const once = await a.create("alice", {
      title: "once",
      prompt: "do it",
      timing: { type: "once", at: new Date(clock + 1000).toISOString() },
    });
    clock += 1000;
    await b.tick();
    await a.tick();
    assert.equal(calls, 2);
    assert.equal((await a.get("alice", once.id)).enabled, false);
    await a.remove("alice", s.id);
    assert.equal((await a.list("alice")).length, 1);
  } finally {
    await db.close();
  }
});
test("cron timezone handles DST and rejects seconds, invalid zones and past one-shot times", async () => {
  const input = {
    title: "x",
    prompt: "x",
    enabled: true,
    timing: { type: "cron" as const, expression: "0 8 * * *", timeZone: "America/New_York" },
  };
  assert.equal(
    nextScheduleDate(input, Date.parse("2026-03-07T14:00:00Z")),
    "2026-03-08T12:00:00.000Z",
  );
  const db = await createStore();
  try {
    const service = new ScheduleService(db, async () => {
      throw new Error();
    });
    await assert.rejects(
      service.create("a", { ...input, timing: { ...input.timing, timeZone: "Invalid/Zone" } }),
      /시간대/,
    );
    await assert.rejects(
      service.create("a", { ...input, timing: { type: "once", at: "2020-01-01T00:00:00Z" } }),
      /미래/,
    );
  } finally {
    await db.close();
  }
});
