import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { createBrowserManager } from "../src/browser.ts";
import { BrowserAutomation } from "../src/browser-automation.ts";

test("real Chromium references target live elements, forms and Unicode; stale/cross-tab references fail", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(
      '<label>Name<input aria-label="Name"></label><input type="checkbox" aria-label="Agree"><select aria-label="Choice"><option value="a">A</option><option value="b">B</option></select><button onclick="document.body.dataset.sent=1">Send</button>',
    );
    const automation = new BrowserAutomation(page);
    const read = JSON.parse(await automation.read());
    const ref = (label: string) =>
      read.elements.find((e: { label: string }) => e.label === label).ref;
    await automation.execute({
      action: "form_input",
      target: { type: "ref", ref: ref("Name") },
      value: "안녕하세요 OpenMuse",
    });
    await automation.execute({
      action: "form_input",
      target: { type: "ref", ref: ref("Agree") },
      value: true,
    });
    await automation.execute({
      action: "form_input",
      target: { type: "ref", ref: ref("Choice") },
      value: "b",
    });
    assert.equal(await page.locator("input").first().inputValue(), "안녕하세요 OpenMuse");
    assert.equal(await page.locator("input[type=checkbox]").isChecked(), true);
    assert.equal(await page.locator("select").inputValue(), "b");
    const second = await browser.newPage();
    await second.setContent("<button>Different</button>");
    const other = new BrowserAutomation(second);
    await other.read();
    await assert.rejects(
      other.execute({ action: "left_click", target: { type: "ref", ref: ref("Send") } }),
      { code: "STALE_REFERENCE" },
    );
    await automation.execute({ action: "left_click", target: { type: "ref", ref: ref("Send") } });
    assert.equal(await page.locator("body").getAttribute("data-sent"), "1");
    const image = (await automation.execute({ action: "screenshot" })) as {
      data: string;
      media_type: string;
    };
    assert.equal(image.media_type, "image/png");
    assert.equal(Buffer.from(image.data, "base64").readUInt32BE(16), 1280);
    await automation.read();
    await assert.rejects(
      automation.execute({ action: "left_click", target: { type: "ref", ref: ref("Send") } }),
      { code: "STALE_REFERENCE" },
    );
    await automation.clear();
    await other.clear();
  } finally {
    await browser.close();
  }
});
test("managed browser creates, switches and closes tabs with the user frame following the active tab", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-tabs-test-"));
  const browser = await createBrowserManager({ dataDir: root });
  const id = randomUUID();
  try {
    await browser.create(id, "about:blank");
    assert.equal((await browser.automationState(id)).tabs.length, 1);
    await browser.automation(id, { action: "new_tab" });
    let state = await browser.automationState(id);
    assert.equal(state.tabs.length, 2);
    assert.equal(state.tabs.find((t) => t.active)?.tab_id, "t2");
    await browser.automation(id, { action: "switch_tab", tab_id: "t1" });
    state = await browser.automationState(id);
    assert.equal(state.tabs.find((t) => t.active)?.tab_id, "t1");
    const frame = await browser.screenshot(id);
    assert.equal(frame.readUInt32BE(16), 1280);
    await browser.automation(id, { action: "close_tab", tab_id: "t2" });
    assert.equal((await browser.automationState(id)).tabs.length, 1);
    await assert.rejects(browser.automation(id, { action: "close_tab", tab_id: "t1" }), {
      code: "LAST_TAB",
    });
    assert.equal((await browser.read(id)).url, "about:blank");
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});
