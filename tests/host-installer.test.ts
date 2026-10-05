import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { createHostAgent } from "../apps/host-agent/src/server.ts";
import { createApp } from "../apps/server/src/app.ts";
import { posixInstaller, windowsInstaller } from "../apps/server/src/host-installer.ts";
import { browserFixture } from "./helpers/browser.ts";

test("self-hosted installers issue expiring single-use enrollment without exposing host credentials", async (t) => {
  const f = await browserFixture(t, () => ({ data: {} })),
    { app, auth, agent } = await createApp(f.db, f.config);
  t.after(() => agent.stop());
  const session = await auth.session(),
    headers = { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" };
  assert.equal(
    (await app.request("/api/host-agent/invitations", { method: "POST", body: "{}" })).status,
    401,
  );
  const r = await app.request("/api/host-agent/invitations", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "fixture-host" }),
  });
  assert.equal(r.status, 200);
  const commands = await r.json();
  const base = /curl -fsSL '([^']+)\/install.sh'/.exec(commands.posix)![1];
  const manifest = await (await app.request(base + "/manifest")).json();
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.version, "0.3.0");
  const token = "private-host-test-token-".repeat(3),
    host = await createHostAgent({ token, dataDir: join(f.config.dataDir, "native-agent") });
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  t.after(() => host.close());
  const address = host.server.address() as { port: number };
  const enrolled = await app.request(base + "/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}`, token }),
  });
  assert.equal(enrolled.status, 200);
  const view = await enrolled.json();
  assert.equal(JSON.stringify(view).includes(token), false);
  const list = await (await app.request("/api/connectors", { headers })).json();
  assert.equal(list.connectors[0].config.allowAgentShell, true);
  assert.equal(
    list.connectors[0].config.platform,
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
  );
  assert.ok(!JSON.stringify(list).includes(token));
  assert.equal((await app.request(base + "/manifest")).status, 410);
  assert.equal(
    (
      await app.request(base + "/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    410,
  );
});
test("installer bootstrap verifies pinned runtime checksums and uses native administrator services", () => {
  const base = "https://openmuse.example/api/host-agent/install/" + "a".repeat(64),
    posix = posixInstaller(base),
    windows = windowsInstaller(base);
  assert.match(posix, /exec sudo/);
  assert.match(posix, /checksum mismatch/);
  assert.match(windows, /RunAs -WindowStyle Hidden/);
  assert.match(windows, /Get-FileHash/);
  assert.match(windows, /\*S-1-5-18/);
  assert.ok(!posix.includes("service-api-token"));
  assert.ok(!windows.includes("service-api-token"));
});
