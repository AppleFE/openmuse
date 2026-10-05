import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createFrameStream } from "../src/frame-stream.ts";

test("real Chromium publishes fresh JPEG frames without blocking keyboard input or accumulating stale frames", {
  timeout: 30_000,
}, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(
    '<body style="margin:0"><input aria-label="test" autofocus style="font-size:30px"><div id="color" style="height:700px;background:red"></div></body>',
  );
  const frames = createFrameStream(page);
  try {
    const first = await frames.latest();
    assert.equal(first.bytes[0], 0xff);
    assert.equal(first.bytes[1], 0xd8);
    assert.ok(
      first.bytes.length < 100_000,
      "compressed image is much smaller than the 4 MB raw framebuffer",
    );
    const started = performance.now();
    await page.keyboard.type("Hello");
    await page.keyboard.insertText("한글");
    await page.evaluate(() => {
      document.getElementById("color")!.style.background = "blue";
    });
    let next = first;
    for (let i = 0; i < 40 && next.tag === first.tag; i++) {
      await new Promise((r) => setTimeout(r, 25));
      next = await frames.latest();
    }
    assert.notEqual(next.tag, first.tag);
    assert.notDeepEqual(next.bytes, first.bytes);
    assert.equal(await page.locator("input").inputValue(), "Hello한글");
    assert.ok(performance.now() - started < 2000, "input and changed frame finish promptly");
    await frames.close();
    await assert.rejects(frames.latest(), /closed/);
  } finally {
    await frames.close();
    await browser.close();
  }
});
