import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { type RemoteJob, remoteCommandSchema } from "../../domain/src/remote-host.ts";

export type RemoteCommand = z.output<typeof remoteCommandSchema>;
export interface JobControl {
  input(text: string): void;
  stop(): void;
  stopMayDetach?: boolean;
}
export type JobDriver = (
  command: RemoteCommand,
  output: (text: string) => void,
  exit: (code: number | null) => void,
) => Promise<JobControl>;
const MAX_OUTPUT = 128 * 1024;
const MAX_JOBS = 100;
const timestamp = () => new Date().toISOString();
const validId = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
export class RemoteJobError extends Error {}

/** Private durable receipts. Running processes are not silently replayed after a restart. */
export class RemoteJobManager {
  private readonly jobs = new Map<string, { job: RemoteJob; input: RemoteCommand }>();
  private readonly running = new Map<string, JobControl>();
  private readonly starting = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stopReasons = new Map<string, "stopped" | "timed_out">();
  private writes: Promise<unknown> = Promise.resolve();
  private dirty = new Set<string>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private admissions: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly directory: string,
    private readonly driver: JobDriver,
  ) {}
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(this.directory))
      .filter((v) => /^[a-f0-9-]{36}\.json$/.test(v))
      .slice(-MAX_JOBS)) {
      try {
        const record = JSON.parse(await readFile(join(this.directory, name), "utf8"));
        const input = remoteCommandSchema.parse(record.input);
        const job = record.job as RemoteJob;
        if (job.id !== name.slice(0, -5) || typeof job.output !== "string") continue;
        if (job.status === "running" || job.status === "stopping") {
          job.status = "interrupted";
          job.updatedAt = timestamp();
        }
        this.jobs.set(job.id, { job, input });
        this.dirty.add(job.id);
      } catch {
        /* An incomplete receipt does not grant a running session. */
      }
    }
    await this.flush();
    return this;
  }
  list() {
    return [...this.jobs.values()]
      .map(({ job }) => ({
        ...job,
        command: job.command.slice(0, 1000),
        output: job.output.slice(-500),
        outputTruncated: job.outputTruncated || job.output.length > 500,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  get(id: string): RemoteJob {
    const record = this.jobs.get(id) ?? this.archived(id);
    if (!record) throw new RemoteJobError("원격 셸 작업을 찾을 수 없습니다");
    return { ...record.job };
  }
  private archived(id: string): { job: RemoteJob; input: RemoteCommand } | undefined {
    if (!validId(id)) throw new RemoteJobError("유효한 작업 ID가 필요합니다");
    try {
      const record = JSON.parse(
        readFileSync(join(this.directory, "archive", `${id}.json`), "utf8"),
      );
      if (record.job?.id !== id || typeof record.job.output !== "string")
        throw new Error("Invalid archived receipt");
      return { job: record.job, input: remoteCommandSchema.parse(record.input) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async archiveCompleted() {
    if (this.jobs.size < MAX_JOBS) return;
    const oldest = [...this.jobs.values()]
      .filter(
        ({ job }) =>
          !this.starting.has(job.id) &&
          !this.running.has(job.id) &&
          job.status !== "running" &&
          job.status !== "stopping",
      )
      .sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt))[0];
    if (!oldest)
      throw new RemoteJobError("실행 중인 호스트 작업이 너무 많습니다. 완료 후 다시 실행하세요");
    // Preserve the full receipt and operation ID: retries of archived commands must never replay.
    await this.flush();
    const archive = join(this.directory, "archive");
    await mkdir(archive, { recursive: true, mode: 0o700 });
    await rename(
      join(this.directory, `${oldest.job.id}.json`),
      join(archive, `${oldest.job.id}.json`),
    );
    this.jobs.delete(oldest.job.id);
  }
  private changed(id: string) {
    this.dirty.add(id);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch(() => {});
    }, 200);
  }
  async flush() {
    const ids = [...this.dirty];
    this.dirty.clear();
    const records = ids.map((id) => ({ id, value: JSON.stringify(this.jobs.get(id)) }));
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        for (const { id, value } of records) {
          const path = join(this.directory, `${id}.json`);
          await writeFile(`${path}.tmp`, value, { mode: 0o600 });
          await rename(`${path}.tmp`, path);
        }
      });
    await this.writes;
  }
  start(raw: unknown, id: string = randomUUID()): Promise<RemoteJob> {
    const next = this.admissions.catch(() => {}).then(() => this.startJob(raw, id));
    this.admissions = next;
    return next;
  }
  private async startJob(raw: unknown, id: string): Promise<RemoteJob> {
    if (this.closed) throw new RemoteJobError("호스트 에이전트가 종료 중입니다");
    if (!validId(id)) throw new RemoteJobError("유효한 작업 ID가 필요합니다");
    const input = remoteCommandSchema.parse(raw);
    const existing = this.jobs.get(id) ?? this.archived(id);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input))
        throw new RemoteJobError("같은 작업 ID의 명령을 변경할 수 없습니다");
      return this.get(id);
    }
    if (this.running.size + this.starting.size >= 4)
      throw new RemoteJobError("동시에 실행할 수 있는 작업은 4개입니다");
    await this.archiveCompleted();
    if (this.closed) throw new RemoteJobError("호스트 에이전트가 종료 중입니다");
    const job: RemoteJob = {
      id,
      command: input.command,
      cwd: input.cwd,
      pty: input.pty,
      status: "running",
      output: "",
      outputTruncated: false,
      exitCode: null,
      createdAt: timestamp(),
      updatedAt: timestamp(),
    };
    this.jobs.set(id, { job, input });
    this.starting.add(id);
    this.dirty.add(id);
    const finish = (code: number | null) => {
      if (job.status !== "running" && job.status !== "stopping") return;
      job.status =
        code === null && this.running.get(id)?.stopMayDetach
          ? "interrupted"
          : (this.stopReasons.get(id) ??
            (code === 0 ? "succeeded" : code === null ? "interrupted" : "failed"));
      this.stopReasons.delete(id);
      job.exitCode = code;
      job.updatedAt = timestamp();
      this.running.delete(id);
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.changed(id);
    };
    try {
      await this.flush();
      const control = await this.driver(
        input,
        (text) => {
          job.output += text;
          const bytes = Buffer.from(job.output, "utf8");
          if (bytes.length > MAX_OUTPUT) {
            let offset = bytes.length - MAX_OUTPUT;
            while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
            job.output = bytes.subarray(offset).toString("utf8");
            job.outputTruncated = true;
          }
          job.updatedAt = timestamp();
          this.changed(id);
        },
        finish,
      );
      if (this.closed) {
        control.stop();
        job.status = "interrupted";
      }
      if (job.status === "running") {
        this.running.set(id, control);
        const timer = setTimeout(() => {
          this.stopReasons.set(id, "timed_out");
          job.status = "stopping";
          job.updatedAt = timestamp();
          control.stop();
          this.changed(id);
        }, input.timeoutSeconds * 1000);
        timer.unref();
        this.timers.set(id, timer);
      }
    } catch {
      job.output += "\n셸 실행을 시작하지 못했습니다. 호스트 연결 및 명령을 확인하세요.";
      finish(1);
    } finally {
      this.starting.delete(id);
    }
    this.dirty.add(id);
    await this.flush();
    return this.get(id);
  }
  input(id: string, text: string) {
    const control = this.running.get(id);
    if (!control || this.get(id).status !== "running")
      throw new RemoteJobError("실행 중인 작업만 입력할 수 있습니다");
    control.input(text);
    return this.get(id);
  }
  stop(id: string) {
    const control = this.running.get(id);
    if (control) {
      this.stopReasons.set(id, "stopped");
      this.jobs.get(id)!.job.status = "stopping";
      this.jobs.get(id)!.job.updatedAt = timestamp();
      control.stop();
      this.changed(id);
    }
    return this.get(id);
  }
  async close() {
    this.closed = true;
    for (const [id, control] of this.running) {
      control.stop();
      this.jobs.get(id)!.job.status = "interrupted";
      this.dirty.add(id);
    }
    for (const id of this.starting) {
      this.jobs.get(id)!.job.status = "interrupted";
      this.dirty.add(id);
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    clearTimeout(this.flushTimer);
    await this.flush();
  }
}

/** Native Windows PowerShell or POSIX shell. Children never inherit the host API credential. */
export const localJobDriver: JobDriver = async (input, output, exit) => {
  if (input.pty)
    throw new Error("이 호스트 에이전트는 PTY를 지원하지 않습니다. SSH PTY 모드를 사용하세요");
  const windows = process.platform === "win32";
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/TOKEN|SECRET|API_KEY|ACCESS_KEY|ENCRYPTION_KEY/i.test(key)) delete env[key];
  const shell = windows ? "powershell.exe" : "/bin/sh";
  const args = windows
    ? [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(
          `[Console]::InputEncoding = [Text.UTF8Encoding]::new(); [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $OutputEncoding = [Text.UTF8Encoding]::new(); $ErrorActionPreference = 'Stop'; & { ${input.command}\n }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`,
          "utf16le",
        ).toString("base64"),
      ]
    : ["-lc", input.command];
  const child = spawn(shell, args, {
    cwd: input.cwd,
    env,
    windowsHide: true,
    detached: !windows,
    stdio: "pipe",
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", output);
  child.stderr.on("data", output);
  child.on("error", () => exit(1));
  child.on("close", (code) => exit(code));
  child.stdin.on("error", () => {});
  const kill = (force: boolean) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (windows)
      spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => child.kill());
    else {
      try {
        process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      } catch {}
    }
  };
  return {
    input: (text) => {
      if (!child.stdin.writable) throw new Error("작업 입력이 닫혔습니다");
      child.stdin.write(text);
    },
    stop: () => {
      kill(false);
      const timer = setTimeout(() => kill(true), 3000);
      timer.unref();
    },
  };
};
