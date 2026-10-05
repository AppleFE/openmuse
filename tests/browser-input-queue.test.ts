import assert from "node:assert/strict";
import test from "node:test";
import { browserFixture } from "./helpers/browser.ts";

test("pointer bursts merge pending motion but preserve button transitions, keys and HTTP input order", async (t) => {
  const events: Record<string, unknown>[] = [];
  const { db, service } = await browserFixture(t, async (_path, body) => {
    events.push(body);
    await new Promise((r) => setTimeout(r, 10));
    return { data: { ok: true } };
  });
  const id = "c541b4f1-0969-450a-ac13-0f1905a8da8c";
  await db.put("owner", "browsers", {
    id,
    title: "fixture",
    url: "https://example.com",
    status: "active",
    control: "user",
    updatedAt: new Date().toISOString(),
  });
  const promises: Promise<unknown>[] = [];
  promises.push(service.streamInput("owner", id, { type: "vnc_mouse", x: 10, y: 10, buttons: 1 }));
  for (let x = 11; x < 80; x++)
    promises.push(service.streamInput("owner", id, { type: "vnc_mouse", x, y: 10, buttons: 1 }));
  promises.push(service.streamInput("owner", id, { type: "vnc_mouse", x: 80, y: 10, buttons: 0 }));
  promises.push(service.streamInput("owner", id, { type: "vnc_key", key: "A", down: true }));
  promises.push(service.streamInput("owner", id, { type: "vnc_mouse", x: 90, y: 10, buttons: 0 }));
  promises.push(service.input("owner", id, { type: "vnc_key", key: "Enter", down: true }));
  promises.push(service.streamInput("owner", id, { type: "vnc_mouse", x: 100, y: 10, buttons: 0 }));
  await Promise.all(promises);
  assert.deepEqual(
    events.map((e) => (e.type === "vnc_mouse" ? `${e.buttons}:${e.x}` : e.key)),
    ["1:10", "1:79", "0:80", "A", "0:90", "Enter", "0:100"],
  );
});
