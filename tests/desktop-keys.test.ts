import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDesktopBatch } from "../apps/server/src/desktop-sdk.ts";
import { playwrightKey } from "../apps/worker/src/automation-schema.ts";
import { createWorkerServer } from "../apps/worker/src/server.ts";

test("desktop SDK normalizes Windows shortcuts before the native helper and reports invalid keys", async () => {
  const path = await mkdtemp(join(tmpdir(), "openmuse-keys-"));
  const token = "key-test-token-at-least-32-characters";
  const received: string[] = [];
  let helperAttached = false;
  const helper = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (req.url === "/sessions") helperAttached = true;
    if (req.url?.endsWith("/automation") && !helperAttached) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Open the desktop first" } }));
      return;
    }
    if (req.url?.endsWith("/automation")) received.push(body.text);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ result: null }));
  });
  helper.listen(0, "127.0.0.1");
  await once(helper, "listening");
  const address = helper.address();
  assert.ok(address && typeof address !== "string");
  const worker = await createWorkerServer({
    dataDir: path,
    token,
    desktop: { nativeProxy: { url: `http://127.0.0.1:${address.port}`, token } },
  });
  worker.server.listen(0, "127.0.0.1");
  await once(worker.server, "listening");
  const workerAddress = worker.server.address();
  assert.ok(workerAddress && typeof workerAddress !== "string");
  const request = (route: string, body: unknown) =>
    fetch(`http://127.0.0.1:${workerAddress.port}${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const id = randomUUID();
    assert.equal(
      (await request("/sessions", { id, kind: "desktop", desktopMode: "native" })).status,
      201,
    );
    const action = async (input: unknown) => {
      const r = await request(`/sessions/${id}/automation`, input);
      const value = await r.json();
      if (!r.ok) throw new Error(value.error.message);
      return value.result;
    };
    const result = await runDesktopBatch({ confirm: async () => true, action }, [
      { action: "key", text: "WIN+r" },
      { action: "key", text: "Windows+R" },
      { action: "key", text: "SUPER+r" },
      { action: "key", text: "ENTER" },
      { action: "key", text: "Ctrl+Shift+f5" },
    ]);
    assert.equal(result.isError, false);
    assert.deepEqual(received, ["Meta+r", "Meta+R", "Meta+r", "Enter", "Control+Shift+F5"]);
    assert.equal(playwrightKey(" Command + Option + r "), "Meta+Alt+r");
    const invalid = await request(`/sessions/${id}/automation`, {
      action: "key",
      text: "UnsupportedKey",
    });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error.code, "INVALID_KEY");
    const failed = await runDesktopBatch({ confirm: async () => true, action }, [
      { action: "key", text: "UnsupportedKey" },
      { action: "key", text: "Enter" },
    ]);
    assert.equal(failed.isError, true);
    assert.match(JSON.stringify(failed), /지원하지 않는 키/);
    assert.match(JSON.stringify(failed), /Not executed/);
    assert.equal(received.length, 5);
    helperAttached = false; // A helper restart loses the active session; Host Agent stays online.
    await assert.rejects(() => action({ action: "key", text: "Win+r" }), /Open the desktop first/);
    assert.equal(
      (await request("/sessions", { id, kind: "desktop", desktopMode: "native" })).status,
      201,
    );
    assert.ok(helperAttached);
    assert.equal(received.length, 5, "reopening must not replay input");
    await action({ action: "key", text: "Win+r" });
    assert.equal(received.at(-1), "Meta+r");
  } finally {
    await worker.close();
    helper.closeAllConnections();
    await new Promise<void>((resolve) => helper.close(() => resolve()));
    await rm(path, { recursive: true, force: true });
  }
});
