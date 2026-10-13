import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const api = "https://api.github.com/repos/AppleFE/openmuse/releases/latest";
const releaseRoot = "https://github.com/AppleFE/openmuse/releases/";
const maxSize = 600 * 1024 * 1024;
export function newerVersion(candidate, current) {
  const parse = (v) => /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(v)?.slice(1).map(Number);
  const a = parse(candidate),
    b = parse(current);
  if (!a || !b || [...a, ...b].some((n) => !Number.isSafeInteger(n))) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function selectRelease(release, current) {
  if (release.draft || release.prerelease || !newerVersion(release.tag_name, current)) return;
  const version = release.tag_name.replace(/^v/, "");
  const name = `OpenMuse-Setup-${version}-x64.exe`;
  const asset = release.assets?.find((a) => a.name === name && a.state === "uploaded");
  if (
    !asset ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 1 ||
    asset.size > maxSize ||
    asset.browser_download_url !== `${releaseRoot}download/${release.tag_name}/${name}` ||
    !/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? "")
  )
    throw Error("릴리스의 설치 파일 또는 SHA-256 검증 정보가 올바르지 않습니다.");
  return {
    version,
    name,
    url: asset.browser_download_url,
    size: asset.size,
    digest: asset.digest.slice(7).toLowerCase(),
    releaseUrl: `${releaseRoot}tag/${release.tag_name}`,
  };
}

/** Only the public upstream release can supply installers. No account/API tokens are sent. */
export class DesktopUpdates {
  constructor({ directory, version, enabled = true, fetcher = fetch }) {
    this.directory = directory;
    this.fetcher = fetcher;
    this.state = { currentVersion: version, enabled, automatic: true, status: "idle", progress: 0 };
  }
  async load() {
    await mkdir(this.directory, { recursive: true });
    try {
      const config = JSON.parse(await readFile(join(this.directory, "settings.json"), "utf8"));
      if (typeof config.automatic === "boolean") this.state.automatic = config.automatic;
    } catch (error) {
      if (error.code !== "ENOENT") this.state.error = "업데이트 설정을 읽지 못했습니다.";
    }
  }
  view() {
    return { ...this.state };
  }
  async configure(automatic) {
    if (typeof automatic !== "boolean") throw Error("잘못된 업데이트 설정입니다.");
    await writeFile(join(this.directory, "settings.json"), JSON.stringify({ automatic }));
    this.state.automatic = automatic;
    if (automatic) void this.check(true);
    return this.view();
  }
  check(download = false) {
    if (!this.state.enabled || this.state.status === "ready") return Promise.resolve(this.view());
    if (this.pending) return this.pending;
    this.pending = this.perform(download)
      .catch(() => {
        this.state.status = "error";
        this.state.error =
          "업데이트를 확인하거나 다운로드하지 못했습니다. 네트워크를 확인하고 다시 시도하세요.";
        return this.view();
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  async perform(download) {
    this.state.status = "checking";
    delete this.state.error;
    const response = await this.fetcher(api, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "OpenMuse-Desktop" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("GitHub release unavailable");
    const release = selectRelease(await response.json(), this.state.currentVersion);
    this.state.checkedAt = new Date().toISOString();
    if (!release) {
      this.state.status = "current";
      return this.view();
    }
    this.release = release;
    this.state.latestVersion = release.version;
    this.state.releaseUrl = release.releaseUrl;
    this.state.status = "available";
    if (download) await this.download();
    return this.view();
  }
  async download() {
    const release = this.release;
    this.state.status = "downloading";
    this.state.progress = 0;
    const temporary = join(this.directory, `${randomUUID()}.part`);
    let file;
    try {
      const response = await this.fetcher(release.url, {
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
      const final = new URL(response.url || release.url);
      if (
        !response.ok ||
        !response.body ||
        final.protocol !== "https:" ||
        ![
          "github.com",
          "release-assets.githubusercontent.com",
          "objects.githubusercontent.com",
        ].includes(final.hostname)
      )
        throw Error("Invalid download response");
      file = await open(temporary, "wx");
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > release.size) throw Error("Installer exceeds expected size");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length)
          offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
        this.state.progress = Math.floor((size / release.size) * 100);
      }
      await file.close();
      file = undefined;
      if (size !== release.size || hash.digest("hex") !== release.digest)
        throw Error("Installer checksum mismatch");
      const installer = join(this.directory, release.name);
      await rename(temporary, installer);
      this.installer = installer;
      this.state.status = "ready";
    } finally {
      await file?.close();
      await rm(temporary, { force: true });
    }
  }
  async verifiedInstaller() {
    if (this.state.status !== "ready" || !this.installer || !this.release)
      throw Error("다운로드된 업데이트가 없습니다.");
    // Reverify after download and immediately before execution (including updates on app exit).
    const bytes = await readFile(this.installer);
    if (
      bytes.length !== this.release.size ||
      createHash("sha256").update(bytes).digest("hex") !== this.release.digest
    ) {
      this.state.status = "error";
      this.state.error = "업데이트 설치 파일 검증에 실패했습니다. 다시 다운로드하세요.";
      throw Error(this.state.error);
    }
    return this.installer;
  }
}
