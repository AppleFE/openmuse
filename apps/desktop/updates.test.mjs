import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopUpdates, newerVersion, selectRelease } from "./updates.mjs";

const bytes = Buffer.from("synthetic installer, never executed");
const digest = createHash("sha256").update(bytes).digest("hex");
const release = () => ({
  tag_name: "v0.13.0",
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "OpenMuse-Setup-0.13.0-x64.exe",
      state: "uploaded",
      size: bytes.length,
      browser_download_url:
        "https://github.com/AppleFE/openmuse/releases/download/v0.13.0/OpenMuse-Setup-0.13.0-x64.exe",
      digest: `sha256:${digest}`,
    },
  ],
});
test("updater accepts only newer stable upstream releases with verified x64 installers", () => {
  assert.equal(newerVersion("0.12.10", "0.12.9"), true);
  for (const value of ["0.12.2", "0.12.1", "0.13.0-beta", "bad", "01.13.0"])
    assert.equal(newerVersion(value, "0.12.2"), false);
  assert.equal(selectRelease(release(), "0.12.3").version, "0.13.0");
  assert.equal(selectRelease({ ...release(), prerelease: true }, "0.12.3"), undefined);
  assert.equal(selectRelease({ ...release(), draft: true }, "0.12.3"), undefined);
  for (const change of [
    { digest: null },
    { size: 900 * 1024 * 1024 },
    { browser_download_url: "https://attacker.test/setup.exe" },
  ]) {
    const value = release();
    Object.assign(value.assets[0], change);
    assert.throws(() => selectRelease(value, "0.12.3"));
  }
});
test("manual check, download, persisted automatic preference and execution revalidation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let downloads = 0;
  const fetcher = async (url, options) => {
    assert.ok(!options.headers?.Authorization);
    if (url.includes("api.github.com")) return Response.json(release());
    downloads++;
    return new Response(bytes);
  };
  const updater = new DesktopUpdates({ directory, version: "0.12.3", fetcher });
  await updater.load();
  await updater.configure(false);
  assert.equal((await updater.check()).status, "available");
  assert.equal(downloads, 0);
  assert.equal((await updater.check(true)).status, "ready");
  assert.equal(downloads, 1);
  const installer = await updater.verifiedInstaller();
  assert.deepEqual(await readFile(installer), bytes);
  await writeFile(installer, "tampered");
  await assert.rejects(updater.verifiedInstaller());
  const restarted = new DesktopUpdates({ directory, version: "0.12.3", fetcher });
  await restarted.load();
  assert.equal(restarted.view().automatic, false);
});
test("bad checksum and truncated download never become executable updates; checks deduplicate", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-update-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let corrupt = Buffer.alloc(bytes.length, 1),
    requests = 0;
  const updater = new DesktopUpdates({
    directory,
    version: "0.12.3",
    fetcher: async (url) => {
      requests++;
      return url.includes("api.github.com") ? Response.json(release()) : new Response(corrupt);
    },
  });
  await updater.load();
  await Promise.all([updater.check(true), updater.check(true)]);
  assert.equal(requests, 2);
  assert.equal(updater.view().status, "error");
  await assert.rejects(updater.verifiedInstaller());
  corrupt = Buffer.from("short");
  assert.equal((await updater.check(true)).status, "error");
  await assert.rejects(updater.verifiedInstaller());
});
