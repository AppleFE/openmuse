import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const api = "https://api.github.com/repos/AppleFE/openmuse/releases/latest";
const releaseRoot = "https://github.com/AppleFE/openmuse/releases/";
const maxSize = 600 * 1024 * 1024;
class UpdateError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}
async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
function failureMessage(error, downloading) {
  if (error instanceof UpdateError) return error.message;
  if (["ENOSPC", "EDQUOT"].includes(error.code))
    return "설치 파일을 저장할 디스크 공간이 부족합니다.";
  if (["EACCES", "EPERM", "EBUSY"].includes(error.code))
    return "설치 파일 저장이 차단됐습니다. 파일 권한이나 보안 프로그램을 확인하고 다시 시도하세요.";
  if (["TimeoutError", "AbortError"].includes(error.name))
    return "다운로드 제한 시간이 지났습니다. 다시 시도하면 받은 부분부터 이어갑니다.";
  return downloading
    ? "설치 파일 다운로드 연결이 끊겼습니다. 다시 시도하면 받은 부분부터 이어갑니다."
    : "GitHub 업데이트 정보를 가져오지 못했습니다. 네트워크를 확인하고 다시 시도하세요.";
}
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
  constructor({
    directory,
    version,
    enabled = true,
    fetcher = fetch,
    downloadTimeoutMs = 30 * 60 * 1000,
    retryDelayMs = 1000,
  }) {
    this.directory = directory;
    this.fetcher = fetcher;
    this.downloadTimeoutMs = downloadTimeoutMs;
    this.retryDelayMs = retryDelayMs;
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
      .catch((error) => {
        const downloading = ["downloading", "verifying"].includes(this.state.status);
        this.state.status = "error";
        this.state.error = failureMessage(error, downloading);
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
    if (!response.ok)
      throw new UpdateError(
        "RELEASE_HTTP",
        `GitHub 업데이트 조회 실패 (HTTP ${response.status}). 잠시 후 다시 시도하세요.`,
      );
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
    const temporary = join(this.directory, `${release.name}.part`);
    let file;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          let size = await stat(temporary).then(
            (info) => info.size,
            (error) => {
              if (error.code === "ENOENT") return 0;
              throw error;
            },
          );
          if (size === release.size) break;
          if (size > release.size) {
            await rm(temporary);
            size = 0;
          }
          this.state.progress = Math.floor((size / release.size) * 100);
          const response = await this.fetcher(release.url, {
            signal: AbortSignal.timeout(this.downloadTimeoutMs),
            ...(size ? { headers: { Range: `bytes=${size}-` } } : {}),
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
            throw new UpdateError(
              "DOWNLOAD_HTTP",
              `설치 파일 다운로드 실패 (HTTP ${response.status}).`,
              [408, 429].includes(response.status) || response.status >= 500,
            );
          if (response.status === 206) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
              response.headers.get("content-range") ?? "",
            );
            if (
              !range ||
              Number(range[1]) !== size ||
              Number(range[3]) !== release.size ||
              Number(range[2]) !== release.size - 1
            ) {
              await rm(temporary, { force: true });
              throw new UpdateError(
                "INVALID_RANGE",
                "이어받기 응답이 올바르지 않습니다. 다운로드를 다시 시작하세요.",
              );
            }
            file = await open(temporary, size ? "r+" : "w");
          } else {
            size = 0;
            file = await open(temporary, "w");
          }
          for await (const chunk of response.body) {
            if (size + chunk.length > release.size)
              throw new UpdateError("SIZE", "설치 파일 크기가 릴리스 정보와 일치하지 않습니다.");
            let offset = 0;
            while (offset < chunk.length)
              offset += (await file.write(chunk, offset, chunk.length - offset, size + offset))
                .bytesWritten;
            size += chunk.length;
            this.state.progress = Math.floor((size / release.size) * 100);
          }
          await file.close();
          file = undefined;
          if (size !== release.size)
            throw new UpdateError(
              "TRUNCATED",
              "다운로드 연결이 중간에 종료됐습니다. 받은 부분부터 다시 시도합니다.",
              true,
            );
          break;
        } catch (error) {
          await file?.close();
          file = undefined;
          const retryable =
            error.retryable ||
            error instanceof TypeError ||
            ["TimeoutError", "AbortError"].includes(error.name);
          if (!retryable || attempt === 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        }
      }
      this.state.status = "verifying";
      if (
        (await stat(temporary)).size !== release.size ||
        (await fileDigest(temporary)) !== release.digest
      ) {
        await rm(temporary, { force: true });
        throw new UpdateError(
          "CHECKSUM",
          "설치 파일 SHA-256 검증에 실패했습니다. 다시 다운로드하세요.",
        );
      }
      const installer = join(this.directory, release.name);
      await rename(temporary, installer);
      this.installer = installer;
      this.state.status = "ready";
    } finally {
      await file?.close();
    }
  }
  async verifiedInstaller() {
    if (this.state.status !== "ready" || !this.installer || !this.release)
      throw Error("다운로드된 업데이트가 없습니다.");
    // Reverify after download and immediately before execution (including updates on app exit).
    if (
      (await stat(this.installer)).size !== this.release.size ||
      (await fileDigest(this.installer)) !== this.release.digest
    ) {
      this.state.status = "error";
      this.state.error = "업데이트 설치 파일 검증에 실패했습니다. 다시 다운로드하세요.";
      throw Error(this.state.error);
    }
    return this.installer;
  }
}
