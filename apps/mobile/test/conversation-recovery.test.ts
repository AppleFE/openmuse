import assert from "node:assert/strict";
import { test } from "node:test";
import { runHttpRequest } from "@ag-ui/client";
import { lastValueFrom } from "rxjs";
import {
  isConversationConnectionError,
  recoverConversationRun,
  runConversationTurn,
} from "../src/conversation-run.ts";
import { conversationFetch } from "../src/conversation-transport.ts";

test("AG-UI transport reports a failed read once without an unhandled cleanup rejection", async () => {
  const fetcher = conversationFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("Load failed"));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  await assert.rejects(
    lastValueFrom(runHttpRequest(() => fetcher("https://fixture.invalid"))),
    /Load failed/,
  );
  // node:test fails this test if the SDK's fire-and-forget cancellation rethrows.
  await new Promise((r) => setTimeout(r, 20));
});

test("a lost client connection restores the existing run, even if the next connection also fails", async () => {
  let connections = 0;
  const waits: number[] = [];
  await recoverConversationRun({
    signal: new AbortController().signal,
    wait: async (ms) => {
      waits.push(ms);
    },
    status: async () => ({ status: connections < 2 ? "running" : "completed" }),
    connect: async () => {
      connections++;
      if (connections === 1) throw new TypeError("Load failed");
    },
  });
  assert.equal(connections, 2);
  assert.deepEqual(waits, [500]);
});

test("a completed run still restores its messages; failed and interrupted runs remain failures", async () => {
  for (const status of ["completed", "stopped", "failed", "interrupted"] as const) {
    let connections = 0;
    const restore = recoverConversationRun({
      signal: new AbortController().signal,
      status: async () => ({ status, error: "Server-side failure" }),
      connect: async () => {
        connections++;
      },
    });
    if (status === "failed" || status === "interrupted")
      await assert.rejects(restore, /Server-side failure/);
    else await restore;
    assert.equal(connections, 1);
  }
});

test("recovery is bounded, never retries authorization errors, and stops on unmount", async () => {
  let reads = 0;
  await assert.rejects(
    recoverConversationRun({
      signal: new AbortController().signal,
      wait: async () => {},
      status: async () => {
        reads++;
        throw new TypeError("Failed to fetch");
      },
      connect: async () => {
        assert.fail("unreachable");
      },
    }),
    /Failed to fetch/,
  );
  assert.equal(reads, 3);
  reads = 0;
  await assert.rejects(
    recoverConversationRun({
      signal: new AbortController().signal,
      status: async () => {
        reads++;
        throw new Error("Session expired");
      },
      connect: async () => {
        assert.fail("unreachable");
      },
    }),
    /Session expired/,
  );
  assert.equal(reads, 1);
  const controller = new AbortController();
  await assert.rejects(
    recoverConversationRun({
      signal: controller.signal,
      status: async () => {
        controller.abort();
        return { status: "running" };
      },
      connect: async () => {
        assert.fail("must not reattach after unmount");
      },
    }),
    { name: "AbortError" },
  );
});

test("a provider RUN_ERROR named Load failed is not a client network failure", async () => {
  let listener: (event: { error: unknown; context: { source: string } }) => void = () => {};
  let unsubscribed = false;
  await assert.rejects(
    runConversationTurn(
      "main",
      async () => {
        listener({ error: new Error("Load failed"), context: { source: "onRunErrorEvent" } });
        listener({ error: new TypeError("Failed to fetch"), context: { source: "onRunFailed" } });
      },
      (onError) => {
        listener = onError;
        return {
          unsubscribe: () => {
            unsubscribed = true;
          },
        };
      },
    ),
    (error) => {
      assert.equal(isConversationConnectionError(error), false);
      assert.equal((error as Error).message, "Load failed");
      return true;
    },
  );
  assert.equal(unsubscribed, true);
  assert.equal(isConversationConnectionError(new TypeError("Load failed")), true);
});
