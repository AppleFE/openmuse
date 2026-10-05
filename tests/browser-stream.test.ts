import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import test from "node:test";
import { serve } from "@hono/node-server";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { WebSocket } from "ws";
import { createApp } from "../apps/server/src/app.ts";
import { attachBrowserStreams } from "../apps/server/src/browser-stream.ts";
import { browserFixture } from "./helpers/browser.ts";

for (const encoding of ["raw", "tight-jpeg"] as const) {
  test(`actual noVNC client receives ${encoding} framebuffer and sends ordered direct input through owner controls`, async (t) => {
    const inputs: Record<string, unknown>[] = [];
    const fixture = await browserFixture(t, async (_path, body) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      inputs.push(body);
      return { data: { ok: true } };
    });
    const id = "c541b4f1-0969-450a-ac13-0f1905a8da8c";
    await fixture.db.put("owner", "browsers", {
      id,
      title: "fixture",
      url: "https://example.com",
      status: "active",
      control: "agent",
      updatedAt: new Date().toISOString(),
    });
    let handler: (request: Request) => Response | Promise<Response>;
    const server = serve({
      fetch: (request) => handler(request),
      port: 0,
      hostname: "127.0.0.1",
    }) as Server;
    await once(server, "listening");
    const address = server.address() as { port: number };
    fixture.config.publicUrl = `http://127.0.0.1:${address.port}`;
    const app = await createApp(fixture.db, fixture.config);
    handler = app.app.fetch;
    t.after(() => app.agent.stop());
    const png = new PNG({ width: 1280, height: 800 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 45;
      png.data[i + 1] = 85;
      png.data[i + 2] = 125;
      png.data[i + 3] = 255;
    }
    t.mock.method(app.browser, "preview", async (owner: string, sessionId: string) => {
      await app.browser.get(owner, sessionId);
      return new Response(new Uint8Array(PNG.sync.write(png)));
    });
    const streams = attachBrowserStreams(server, app.auth, app.browser);
    t.after(() => {
      streams.close();
      server.closeAllConnections();
      server.close();
    });
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const jpeg = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 800;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "rgb(45,85,125)";
      context.fillRect(0, 0, 1280, 800);
      return canvas.toDataURL("image/jpeg", 0.75).split(",")[1];
    });
    let sentFrames = 0;
    t.mock.method(
      app.browser,
      "liveFrame",
      async (owner: string, sessionId: string, tag?: string) => {
        await app.browser.get(owner, sessionId);
        if (encoding === "tight-jpeg" && tag === '"test-frame"')
          return new Response(null, { status: 304 });
        sentFrames++;
        return new Response(
          new Uint8Array(
            encoding === "tight-jpeg" ? Buffer.from(jpeg, "base64") : PNG.sync.write(png),
          ),
          {
            headers: {
              "content-type": encoding === "tight-jpeg" ? "image/jpeg" : "image/png",
              etag: '"test-frame"',
            },
          },
        );
      },
    );
    const errors: string[] = [],
      diagnostics: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => diagnostics.push(m.text()));
    page.on("response", (r) => {
      if (r.status() >= 400) diagnostics.push(`${r.status()} ${new URL(r.url()).pathname}`);
    });
    page.on("requestfailed", (r) => diagnostics.push(r.failure()?.errorText ?? "failed"));
    await page.goto(app.browser.decorate("owner", await app.browser.get("owner", id)).consoleUrl);
    await page
      .waitForFunction(
        () => {
          const c = document.querySelector("canvas");
          return c?.width === 1280 && c.height === 800;
        },
        {},
        { timeout: 8000 },
      )
      .catch(async (e) => {
        throw new Error(
          `${e.message}; page errors=${JSON.stringify(errors)}; diagnostics=${JSON.stringify(diagnostics)}; body=${await page.locator("body").innerText()}`,
        );
      });
    await page
      .waitForFunction(
        () => {
          const c = document.querySelector("canvas");
          const value = c?.getContext("2d")?.getImageData(0, 0, 1, 1).data[0];
          return value !== undefined && Math.abs(value - 45) <= 3;
        },
        {},
        { timeout: 8000 },
      )
      .catch(async (e) => {
        throw new Error(
          `${e.message}; image errors=${JSON.stringify(errors)}; diagnostics=${JSON.stringify(diagnostics)}; pixel=${JSON.stringify(await page.locator("canvas").evaluate((el) => Array.from((el as HTMLCanvasElement).getContext("2d")!.getImageData(0, 0, 1, 1).data)))}`,
        );
      });
    assert.equal(inputs.length, 0);
    await page.getByRole("button", { name: "직접 제어", exact: true }).click();
    await page.locator("canvas").click({ position: { x: 100, y: 100 } });
    await page.keyboard.type("Hello");
    await page.getByRole("button", { name: "키보드", exact: true }).click();
    await page.locator("#ime").evaluate((el) => {
      el.dispatchEvent(new CompositionEvent("compositionstart"));
      (el as HTMLTextAreaElement).value = "한글";
      el.dispatchEvent(new CompositionEvent("compositionend", { data: "한글" }));
    });
    await page.locator("#ime").press("Enter");
    for (
      let i = 0;
      i < 50 && !inputs.some((v) => v.type === "vnc_key" && v.key === "Enter" && v.down === false);
      i++
    )
      await page.waitForTimeout(50);
    assert.ok(inputs.some((v) => v.type === "vnc_mouse" && (v.buttons as number) & 1));
    assert.ok(inputs.some((v) => v.type === "vnc_key" && v.key === "Enter"));
    assert.equal(
      inputs
        .filter((v) => v.type === "vnc_key" && v.down && v.key !== "Shift")
        .map((v) => v.key)
        .join(""),
      "Hello한글Enter",
    );
    assert.deepEqual(errors, []);
    await page.getByRole("button", { name: "에이전트에게 반환", exact: true }).click();
    await page.getByRole("button", { name: "직접 제어", exact: true }).waitFor();
    assert.equal((await app.browser.get("owner", id)).control, "agent");
    if (encoding === "tight-jpeg")
      assert.equal(sentFrames, 1, "unchanged frames are not retransmitted");
    const unsigned = new WebSocket(`ws://127.0.0.1:${address.port}/api/browsers/${id}/stream`);
    const denied = await new Promise<number>((resolve) => {
      unsigned.on("unexpected-response", (_req, res) => {
        res.resume();
        unsigned.terminate();
        resolve(res.statusCode!);
      });
      unsigned.on("error", () => {});
    });
    assert.equal(denied, 403);
  });
}
