import assert from "node:assert/strict";
import { test } from "node:test";
import { chatStreamResponse } from "../apps/server/src/chat-stream.ts";

test("idle SSE emits only comments, preserves events, and cancels the upstream on disconnect", async () => {
  let upstream: ReadableStreamDefaultController<string> | undefined;
  let cancelled = false;
  const response = chatStreamResponse(
    new Response(
      new ReadableStream({
        start(controller) {
          upstream = controller;
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    ),
    10,
  );
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  assert.equal(decoder.decode((await reader.read()).value), ": keepalive\n\n");
  assert.ok(upstream);
  upstream.enqueue('data: {"type":"RUN_STARTED"}\n\n');
  assert.equal(decoder.decode((await reader.read()).value), 'data: {"type":"RUN_STARTED"}\n\n');
  await reader.cancel();
  assert.equal(cancelled, true);
  assert.equal(response.headers.get("X-Accel-Buffering"), "no");
});

test("JSON responses and stream closure/errors retain their original semantics", async () => {
  const json = chatStreamResponse(Response.json({ ok: true }, { status: 202 }));
  assert.equal(json.status, 202);
  assert.deepEqual(await json.json(), { ok: true });
  assert.equal(json.headers.get("X-Accel-Buffering"), null);
  const failed = chatStreamResponse(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("upstream broke"));
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    ),
    10,
  );
  await assert.rejects(failed.text(), /upstream broke/);
});
