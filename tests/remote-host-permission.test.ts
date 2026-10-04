import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { ConnectorService } from "../apps/server/src/connector-service.ts";
import { browserFixture } from "./helpers/browser.ts";

test("owner permission persists, dispatch recovery is idempotent and a changed target cannot reuse the job", async (t) => {
  const token = "host-permission-token-at-least-32-characters";
  let writes = 0;
  let jobId = "";
  const provider = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method === "POST") {
      writes++;
      jobId = JSON.parse(body).jobId;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ job: { id: jobId, status: "running", output: `private\n${token}\nend` } }),
    );
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(async () => {
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
  });
  const addr = provider.address();
  assert.ok(addr && typeof addr !== "string");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const { db, config } = await browserFixture(t, () => ({ data: {} }));
  const service = new ConnectorService(db, config);
  const host = await service.create("owner", {
    provider: "remote_host",
    name: "Host",
    config: { baseUrl, allowAgentShell: false },
    secrets: { token },
  });
  const operationId = randomUUID();
  await assert.rejects(
    () => service.executeHostCommand("owner", host.id, { command: "pwd" }, operationId),
    /허용/,
  );
  assert.equal(writes, 0);
  await service.update("owner", host.id, { config: { baseUrl, allowAgentShell: true } });
  const result = await service.executeHostCommand(
    "owner",
    host.id,
    { command: "pwd" },
    operationId,
  );
  assert.equal(writes, 1);
  assert.ok(!JSON.stringify(result).includes(token));
  await service.executeHostCommand("owner", host.id, { command: "pwd" }, operationId);
  assert.equal(writes, 1);
  await assert.rejects(
    () => service.executeHostCommand("owner", host.id, { command: "different" }, operationId),
    /변경/,
  );
  await assert.rejects(() =>
    service.executeHostCommand("other", host.id, { command: "pwd" }, operationId),
  );
  await service.update("owner", host.id, {
    config: { baseUrl: "http://127.0.0.1:1", allowAgentShell: true },
  });
  await assert.rejects(
    () => service.executeHostCommand("owner", host.id, { command: "pwd" }, operationId),
    /변경/,
  );
  assert.equal(writes, 1);
});
