import assert from "node:assert/strict";
import test from "node:test";
import { piRetrySettings, piWatchdog } from "../apps/server/src/engine/pi-response.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Pi watchdog aborts only after idleness and keeps running tools alive", async () => {
  const active = piWatchdog(80, 2000);
  for (let n = 0; n < 5; n++) {
    await wait(40);
    active.touch({ type: "message_update" });
  }
  assert.equal(active.aborted, false);
  active.touch({ type: "tool_execution_start" });
  await wait(160);
  assert.equal(active.aborted, false, "a running tool is progress");
  active.touch({ type: "tool_execution_end" });
  await wait(160);
  assert.equal(active.aborted, true);
  assert.match(active.message(), /응답이나 도구 진행이 1분 동안 없어/);
  active.dispose();

  const capped = piWatchdog(1000, 60);
  capped.touch({ type: "tool_execution_start" });
  await wait(120);
  assert.equal(capped.aborted, true);
  assert.match(capped.message(), /실행 상한/);
  capped.dispose();
});

test("Pi transient provider retry is enabled with a bounded budget", () => {
  assert.equal(piRetrySettings.enabled, true);
  assert.ok(piRetrySettings.maxRetries > 0 && piRetrySettings.maxRetries <= 3);
});
