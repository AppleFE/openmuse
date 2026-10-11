import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createHostAgent } from "../apps/host-agent/src/server.ts";
import { createApp } from "../apps/server/src/app.ts";
import {
  posixInstaller,
  windowsInstaller,
  windowsInstallerWorker,
} from "../apps/server/src/host-installer.ts";
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
  assert.equal(manifest.version, "0.10.4");
  const bootstrap = await app.request(base + "/install.ps1");
  assert.equal(bootstrap.status, 200);
  assert.match(await bootstrap.text(), /install.ps1\?worker=1/);
  const worker = await app.request(base + "/install.ps1?worker=1");
  assert.equal(worker.status, 200);
  assert.match(await worker.text(), /Start-Transcript/);
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
  assert.equal((await app.request(base + "/install.ps1?worker=1")).status, 410);
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
    windows = windowsInstallerWorker(base);
  assert.match(posix, /exec sudo/);
  assert.match(posix, /checksum mismatch/);
  assert.match(windows, /RunAs -WindowStyle Hidden/);
  assert.match(windows, /Get-FileHash/);
  assert.match(windows, /\*S-1-5-18/);
  assert.ok(!posix.includes("service-api-token"));
  assert.ok(!windows.includes("service-api-token"));
});

test("Windows piped bootstrap isolates caller state, preserves Korean text, cleans files and surfaces failure", {
  skip: process.platform !== "win32",
  timeout: 30000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-win-installer-"));
  t.after(async () => {
    assert.ok(directory.startsWith(join(tmpdir(), "openmuse-win-installer-")));
    await rm(directory, { recursive: true, force: true });
  });
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const fixture = join(directory, "한글 파일.txt"),
    report = join(directory, "report.json");
  const content = "Windows PowerShell installer fixture";
  await writeFile(fixture, content);
  let failing = false;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/install.ps1?worker=1");
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(
      // CI's PowerShell 7 parent can pass a module path that lacks Windows PowerShell modules.
      `$ErrorActionPreference='Stop'\nImport-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility')\n[IO.File]::WriteAllText(${quote(report)},(@{ text='한글 설치'; hash=(Get-FileHash -LiteralPath ${quote(fixture)} -Algorithm SHA256).Hash; file=$PSCommandPath } | ConvertTo-Json))\nexit ${failing ? 9 : 0}`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as { port: number }).port;
  const launcher = join(directory, "bootstrap.ps1");
  await writeFile(launcher, windowsInstaller(`http://127.0.0.1:${port}`));
  const command = `
$ErrorActionPreference='Stop'
function global:Get-FileHash { return $null }
$architecture=$null
try { Get-Content -LiteralPath ${quote(launcher)} -Raw -Encoding UTF8 | Invoke-Expression } catch { exit 1 }
`;
  const run = () =>
    promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 12000 },
    );
  await run();
  const result = JSON.parse(await readFile(report, "utf8"));
  assert.equal(result.text, "한글 설치");
  assert.equal(result.hash.toLowerCase(), createHash("sha256").update(content).digest("hex"));
  await assert.rejects(stat(result.file), { code: "ENOENT" });
  failing = true;
  await assert.rejects(run(), { code: 1 });
  const failure = JSON.parse(await readFile(report, "utf8"));
  await assert.rejects(stat(failure.file), { code: "ENOENT" });
});
