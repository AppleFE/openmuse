import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { PNG } from "pngjs";
import { z } from "zod";
import { createApp } from "../apps/server/src/app.ts";
import { automationResultSchema } from "../apps/server/src/automation-result.ts";
import { OpenMuseBrowserToolset, runBrowserBatch } from "../apps/server/src/browser-sdk.ts";
import { browserTools } from "../apps/server/src/browser-tools.ts";
import { runDesktopBatch } from "../apps/server/src/desktop-sdk.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import { browserActionSchema, desktopActionSchema } from "../apps/worker/src/automation-schema.ts";
import type { ModelProfile } from "../packages/domain/src/agent.ts";
import { browserFixture } from "./helpers/browser.ts";
import { piProtocolFixture } from "./helpers/pi-protocol.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6H+sAAAAASUVORK5CYII=";
const tabs = [{ tab_id: "t1", title: "Fixture", url: "https://example.com/", active: true }];

test("native screenshot reattaches a lost helper session; input and authorization failures never replay", async (t) => {
  const calls: string[] = [];
  let missing = true,
    status = 404;
  const { service, db } = await browserFixture(t, (path, body) => {
    calls.push(path);
    if (path === "/sessions") {
      missing = false;
      return {
        data: {
          ...body,
          title: "Native desktop",
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      };
    }
    return missing
      ? {
          status,
          data: {
            error: { message: status === 409 ? "Desktop not found" : "Session unavailable" },
          },
        }
      : { data: { result: { data: png, media_type: "image/png" } } };
  });
  const id = randomUUID();
  await db.put("owner", "browsers", {
    id,
    kind: "desktop",
    desktopMode: "native",
    title: "Native desktop",
    url: "desktop://native",
    status: "active",
    control: "user",
    updatedAt: new Date().toISOString(),
  });
  const shot = await service.runAutomation("owner", {
    sessionId: id,
    actions: [{ action: "screenshot" }],
  });
  assert.equal(shot.isError, false);
  assert.equal(calls.filter((p) => p === "/sessions").length, 1);
  assert.equal((await service.get("owner", id)).control, "user", "recovery preserves user control");
  missing = true;
  status = 409;
  calls.length = 0;
  const legacy = await service.runAutomation("owner", {
    sessionId: id,
    actions: [{ action: "screenshot" }],
  });
  assert.equal(legacy.isError, false);
  assert.equal(calls.filter((p) => p === "/sessions").length, 1);
  await assert.rejects(
    service.runAutomation("other", { sessionId: id, actions: [{ action: "screenshot" }] }),
    { status: 404 },
  );
  await db.compareAndSwap("owner", "browsers", id, {}, { control: "agent" });
  missing = true;
  calls.length = 0;
  const click = await service.runAutomation("owner", {
    sessionId: id,
    actions: [{ action: "left_click", coordinate: [1, 1] }],
  });
  assert.equal(click.isError, true);
  assert.equal(calls.length, 1);
  assert.ok(!calls.includes("/sessions"));
  status = 401;
  calls.length = 0;
  const denied = await service.runAutomation("owner", {
    sessionId: id,
    actions: [{ action: "screenshot" }],
  });
  assert.equal(denied.isError, true);
  assert.equal(calls.length, 1);
});

test("computer observations describe each zoom's actual image-to-screen coordinates", async () => {
  const data = PNG.sync.write(new PNG({ width: 1280, height: 120 })).toString("base64");
  const result = await runDesktopBatch(
    { confirm: async () => true, action: async () => ({ data, media_type: "image/png" }) },
    [
      { action: "zoom", region: [320, 220, 960, 280] },
      { action: "zoom", region: [0, 220, 320, 250] },
    ],
  );
  assert.equal(result.isError, false);
  assert.equal(result.content.length, 4);
  assert.equal(result.content[0].type, "image");
  assert.equal(result.content[2].type, "image");
  assert.match(JSON.stringify(result.content[1]), /round\(320 \+ u \* 640 \/ 1280\)/);
  assert.match(JSON.stringify(result.content[1]), /round\(220 \+ v \* 60 \/ 120\)/);
  assert.match(JSON.stringify(result.content[3]), /round\(0 \+ u \* 320 \/ 1280\)/);
  assert.match(JSON.stringify(result.content[3]), /Never send cropped image coordinates directly/);
  assert.match(JSON.stringify(result.content[3]), /A tab-search result is NOT the active page/);
  assert.ok(automationResultSchema.safeParse(result).success);
});

test("zoom rejects inverted corners before execution and explains how to retry", async (t) => {
  const calls: unknown[] = [];
  const { service, db } = await browserFixture(t, (_path, body) => {
    calls.push(body);
    return { data: { result: { data: png, media_type: "image/png" } } };
  });
  const sessionId = randomUUID();
  await db.put("owner", "browsers", {
    id: sessionId,
    kind: "desktop",
    desktopMode: "native",
    title: "Zoom fixture",
    url: "desktop://native",
    status: "active",
    control: "agent",
    updatedAt: new Date().toISOString(),
  });
  const tool = browserTools(service, "owner", "chat").find((t) => t.name === "computer_use");
  assert.ok(tool?.execute);
  const execute = tool.execute as (input: unknown) => Promise<unknown>;
  for (const region of [
    [325, 218, 640, 55],
    [320, 220, 620, 65],
    [320, 220, 320, 285],
    [320, 220, 960, 220],
  ] as [number, number, number, number][]) {
    const result = await execute({
      sessionId,
      actions: [
        { action: "zoom", region },
        { action: "left_click", coordinate: [10, 10] },
      ],
    });
    assert.match(JSON.stringify(result), /left, top, right, bottom/);
    assert.doesNotMatch(JSON.stringify(result), /Permission|confirmation/);
  }
  assert.deepEqual(calls, [], "invalid zoom must not reach the desktop or click afterward");
  const valid = { action: "zoom" as const, region: [320, 220, 960, 285] as const };
  const parsed = desktopActionSchema.parse(valid);
  const result = automationResultSchema.parse(await execute({ sessionId, actions: [parsed] }));
  assert.notEqual(result.isError, true);
  assert.deepEqual(calls, [valid], "valid corners must reach the driver without reinterpretation");
  assert.ok(result.content.some((b) => b.type === "image" && b.data === png));
  assert.match(JSON.stringify(z.toJSONSchema(desktopActionSchema)), /NOT x\/y\/width\/height/);
});
test("cancellation stops the rest of an automation batch", async () => {
  const controller = new AbortController();
  let count = 0;
  await assert.rejects(
    runDesktopBatch(
      {
        confirm: async () => true,
        action: async () => {
          count++;
          controller.abort();
          return null;
        },
      },
      [
        { action: "left_click", coordinate: [10, 10] },
        { action: "type", text: "must not run" },
      ],
      controller.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(count, 1);
});
test("official browser SDK executes without an Anthropic client, returns images/state and stops failed batches", async () => {
  const calls: string[] = [];
  const backend = {
    state: async () => ({ tabs }),
    confirm: async () => true,
    action: async (a: { action: string }) => {
      calls.push(a.action);
      if (a.action === "screenshot") return { data: png, media_type: "image/png" };
      if (a.action === "form_input") throw Error("Stale reference");
      return "page";
    },
  };
  const result = await runBrowserBatch(backend, [
    { action: "screenshot" },
    { action: "form_input", target: { type: "ref", ref: "r1-1" }, value: "x" },
    { action: "key", text: "Enter" },
  ]);
  assert.deepEqual(calls, ["screenshot", "form_input"]);
  assert.equal(result.isError, true);
  assert.ok(result.content.some((b) => b.type === "image" && b.data === png));
  assert.match(JSON.stringify(result), /browser_state/);
  assert.match(JSON.stringify(result), /Not executed/);
  assert.ok(automationResultSchema.safeParse(result).success);
  const sdk = new OpenMuseBrowserToolset(backend);
  const disabled = await sdk.toolResult({
    id: "blocked",
    type: "tool_use",
    toolset_name: "browser",
    name: "javascript_exec",
    input: { code: 'fetch("file:///etc/passwd")' },
  });
  assert.equal(disabled.is_error, true);
  await sdk.close();
  assert.deepEqual(calls, ["screenshot", "form_input"]);
});
test("computer SDK enforces confirmation; driver input validation rejects malformed coordinates/keys", async () => {
  const calls: string[] = [];
  const result = await runDesktopBatch(
    {
      confirm: async () => false,
      action: async (a) => {
        calls.push(a.action);
        return null;
      },
    },
    [
      { action: "type", text: "do not execute" },
      { action: "left_click", coordinate: [10, 10] },
    ],
  );
  assert.equal(result.isError, true);
  assert.deepEqual(calls, []);
  assert.equal(
    desktopActionSchema.safeParse({ action: "left_click", coordinate: [1280, 10] }).success,
    false,
  );
  assert.equal(
    browserActionSchema.safeParse({ action: "left_click", target: { type: "ref", ref: "forged" } })
      .success,
    false,
  );
  const shot = await runDesktopBatch(
    { confirm: async () => true, action: async () => ({ data: png, media_type: "image/png" }) },
    [{ action: "screenshot" }],
  );
  assert.ok(shot.content.some((b) => b.type === "image" && b.data === png));
});
test("automation keeps ownership, user control and conversation review/bypass on real service boundary", async (t) => {
  const id = randomUUID();
  const calls: string[] = [];
  const fixture = await browserFixture(t, (path, body) => {
    calls.push(path);
    if (path === "/sessions")
      return {
        data: {
          ...body,
          title: "Reattached",
          status: "active",
          updatedAt: new Date().toISOString(),
        },
      };
    return {
      data: path.endsWith("/state")
        ? { tabs }
        : { result: body.action === "screenshot" ? { data: png, media_type: "image/png" } : null },
    };
  });
  const server = await createApp(fixture.db, fixture.config);
  t.after(async () => {
    server.hostEvents.close();
    await server.agent.stop();
  });
  await fixture.db.put("owner", "browsers", {
    id,
    title: "Fixture",
    url: "https://example.com/",
    status: "active",
    control: "user",
    updatedAt: new Date().toISOString(),
  });
  const browser = server.browser;
  await assert.rejects(
    browser.automation("other", "chat", { sessionId: id, actions: [{ action: "screenshot" }] }),
    { status: 404 },
  );
  const refused = await browser.automation("owner", "chat", {
    sessionId: id,
    actions: [{ action: "navigate", url: "https://example.com/" }],
  });
  assert.equal((refused as { isError: boolean }).isError, true);
  assert.ok(!calls.some((p) => p.endsWith("/automation")));
  await browser.setControl("owner", id, "agent");
  const pending = (await browser.automation("owner", "chat", {
    sessionId: id,
    actions: [{ action: "type", text: "test" }],
  })) as { id: string; hash: string; status: string };
  assert.equal(pending.status, "awaiting_review");
  assert.ok(!calls.some((p) => p.endsWith("/automation")));
  await browser.setControl("owner", id, "user");
  const stale = await server.actions.decide("owner", pending.id, pending.hash, "approve");
  assert.equal(stale.status, "failed");
  assert.ok(!calls.some((p) => p.endsWith("/automation")));
  await browser.setControl("owner", id, "agent");
  const thread = await server.conversations.create("owner", { name: "Automation bypass" });
  await server.conversations.setApprovalMode("owner", thread.id, "bypass");
  const executed = await browser.automation("owner", thread.id, {
    sessionId: id,
    actions: [{ action: "type", text: "allowed" }, { action: "screenshot" }],
  });
  assert.ok(automationResultSchema.parse(executed).content.some((b) => b.type === "image"));
  assert.equal(calls.filter((p) => p.endsWith("/automation")).length, 2);
  assert.ok(!JSON.stringify(await fixture.db.list("owner", "actions")).includes(png));
  const desktopId = randomUUID();
  await fixture.db.put("owner", "browsers", {
    id: desktopId,
    kind: "desktop",
    desktopMode: "native",
    title: "Native",
    url: "desktop://native",
    status: "active",
    control: "user",
    updatedAt: new Date().toISOString(),
  });
  await assert.rejects(
    browser.automation(
      "owner",
      thread.id,
      { sessionId: desktopId, actions: [{ action: "left_click", coordinate: [1, 1] }] },
      undefined,
      "desktop",
    ),
    { status: 409 },
  );
  const beforeReopen = calls.length;
  const reopened = await browser.createDesktop("owner", "native");
  assert.equal(reopened.id, desktopId);
  assert.equal(reopened.control, "user", "opening must preserve the user's control");
  assert.deepEqual(calls.slice(beforeReopen), ["/sessions"], "reattach without replaying input");
});
for (const visionSupport of ["supported", "unknown", "unsupported"] as const) {
  test(`Pi screenshot transport with ${visionSupport} vision metadata keeps images out of AG-UI`, async (t) => {
    const id = randomUUID();
    const worker = await browserFixture(t, (path) => ({
      data: path.endsWith("/state") ? { tabs } : { result: { data: png, media_type: "image/png" } },
    }));
    const model: ModelProfile = {
      id: "vision-test",
      label: "Vision test",
      provider: "openai",
      model: "openai/gpt-4o-mini",
      capabilities:
        visionSupport === "supported"
          ? ["chat", "coding", "tools", "vision"]
          : ["chat", "coding", "tools"],
      visionSupport,
      enabled: true,
      available: true,
    };
    const protocol = await piProtocolFixture(t, [
      {
        tool: {
          name: "browser_use",
          arguments: { sessionId: id, actions: [{ action: "screenshot" }] },
        },
      },
      { text: "I can see the screenshot." },
    ]);
    const config = { ...worker.config, agentBackend: "model" as const, models: [model] };
    const server = await createApp(worker.db, config);
    t.after(async () => {
      server.hostEvents.close();
      await server.agent.stop();
    });
    await worker.db.put("owner", "browsers", {
      id,
      title: "Fixture",
      url: "https://example.com/",
      status: "active",
      control: "agent",
      updatedAt: new Date().toISOString(),
    });
    const events: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) =>
      new ConversationAgent(config, server.agent, "owner", model)
        .run({
          threadId: "automation-images",
          runId: randomUUID(),
          messages: [
            { id: randomUUID(), role: "user", content: "Look at the current screenshot." },
          ],
          state: {},
          tools: [],
          context: [],
          forwardedProps: { modelId: model.id },
        })
        .subscribe({
          next: (e) => events.push(e as unknown as Record<string, unknown>),
          error: reject,
          complete: resolve,
        }),
    );
    assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED, JSON.stringify(events));
    assert.equal(protocol.requests.length, 2);
    const input = JSON.stringify(protocol.requests[1].body.input);
    if (visionSupport === "unsupported") {
      assert.doesNotMatch(input, /input_image/);
      assert.match(input, /image input is disabled by this model/);
    } else {
      assert.match(input, /input_image/);
      assert.ok(input.includes(`data:image/png;base64,${png}`));
      assert.doesNotMatch(input, /model does not support images|no vision capability/);
    }
    assert.ok(!JSON.stringify(events).includes(png), "UI events should not duplicate image bytes");
  });
}
