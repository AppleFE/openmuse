import { createHash, timingSafeEqual } from "node:crypto";
import ssh2 from "ssh2";
import { z } from "zod";
import type { ConnectorOperationInfo } from "../../../domain/src/connectors.ts";
import {
  parseRemoteOperation,
  type RemoteHostConfig,
  type RemoteHostSecrets,
  remoteHostConfigSchema,
  remoteHostSecretsSchema,
  remoteHostStatusSchema,
  remoteOperationLabels,
  remoteReadSchemas,
  remoteWriteSchemas,
} from "../../../domain/src/remote-host.ts";
import { type JobDriver, RemoteJobManager } from "../remote-jobs.ts";
import { ConnectorError, httpJson, redact } from "./http.ts";
import type { ConnectorAdapter, ConnectorContext } from "./types.ts";

const managers = new Map<string, Promise<RemoteJobManager>>();
const { Client } = ssh2;
const secretsOf = (s: RemoteHostSecrets) => [s.token, s.privateKey, s.passphrase];
function context(ctx: ConnectorContext) {
  const config = remoteHostConfigSchema.parse(ctx.config),
    secrets = remoteHostSecretsSchema.parse(ctx.secrets);
  if (config.mode === "agent" && !secrets.token)
    throw new ConnectorError("Host Agent 토큰이 필요합니다", undefined, "auth");
  if (config.mode === "ssh" && !secrets.privateKey)
    throw new ConnectorError("SSH 개인 키가 필요합니다", undefined, "auth");
  return { config, secrets };
}
export function sshCommand(
  config: Pick<RemoteHostConfig, "platform">,
  command: string,
  cwd?: string,
) {
  if (config.platform === "windows") {
    const script = `[Console]::InputEncoding = [Text.UTF8Encoding]::new(); [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $OutputEncoding = [Text.UTF8Encoding]::new(); $ErrorActionPreference = 'Stop'; ${cwd ? `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ` : ""}& { ${command}\n }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
    return `powershell.exe -NoLogo -NoProfile -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  const quote = (v: string) => `'${v.replace(/'/g, `'"'"'`)}'`;
  return `/bin/sh -lc ${quote(`${cwd ? `cd ${quote(cwd)} || exit 1\n` : ""}${command}`)}`;
}
export function sshJobDriver(config: RemoteHostConfig, secrets: RemoteHostSecrets): JobDriver {
  return (input, output, exit) =>
    new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      client.on("error", () => {
        if (!settled)
          reject(
            new ConnectorError(
              "SSH 연결 실패: 주소·사용자·개인 키·호스트 지문을 확인하세요",
              undefined,
              "unreachable",
            ),
          );
        else exit(null);
      });
      client.on("close", () => {
        if (!settled) reject(new ConnectorError("SSH 연결이 닫혔습니다", undefined, "unreachable"));
        else exit(null);
      });
      client.on("ready", () =>
        client.exec(
          sshCommand(config, input.command, input.cwd),
          {
            ...(input.pty
              ? { pty: { term: "xterm-256color", cols: 120, rows: 40, width: 0, height: 0 } }
              : {}),
          },
          (error, channel) => {
            if (error) {
              client.end();
              reject(new ConnectorError("SSH 명령 채널을 열 수 없습니다"));
              return;
            }
            settled = true;
            channel.setEncoding("utf8");
            channel.stderr.setEncoding("utf8");
            channel.on("data", output);
            channel.stderr.on("data", output);
            channel.on("error", () => {
              exit(null);
              client.end();
            });
            channel.on("close", (code: number | undefined) => {
              exit(typeof code === "number" ? code : null);
              client.end();
            });
            resolve({
              stopMayDetach: true,
              input: (text) => {
                if (!channel.writable) throw new Error("SSH 입력 채널이 닫혔습니다");
                channel.write(text);
              },
              stop: () => {
                channel.signal("TERM");
                const timer = setTimeout(() => {
                  channel.close();
                  client.end();
                }, 3000);
                timer.unref();
              },
            });
          },
        ),
      );
      client.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        privateKey: secrets.privateKey,
        passphrase: secrets.passphrase,
        readyTimeout: 15000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => {
          const actual = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
          const expected = config.hostFingerprint?.replace(/=+$/, "") ?? "";
          return (
            actual.length === expected.length &&
            timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
          );
        },
      });
    });
}
async function sshStatus(
  config: RemoteHostConfig,
  secrets: RemoteHostSecrets,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const command =
    config.platform === "windows"
      ? `[pscustomobject]@{hostname=$env:COMPUTERNAME;platform='win32';arch=$env:PROCESSOR_ARCHITECTURE;shell='powershell.exe'} | ConvertTo-Json -Compress`
      : `printf '%s\\n' "$(hostname)" "$(uname -s)" "$(uname -m)" '/bin/sh'`;
  return new Promise<unknown>((resolve, reject) => {
    let output = "",
      control: Awaited<ReturnType<JobDriver>> | undefined,
      cancelled = false;
    const abort = () => {
      cancelled = true;
      control?.stop();
      reject(new ConnectorError("SSH 상태 조회가 중단되었습니다"));
    };
    const timer = setTimeout(abort, 20000);
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    sshJobDriver(config, secrets)(
      { command, pty: false, timeoutSeconds: 20 },
      (text) => {
        output += text;
        if (output.length > 8192) abort();
      },
      (code) => {
        cleanup();
        if (code !== 0) {
          reject(new ConnectorError("SSH 호스트 정보 조회 실패"));
          return;
        }
        try {
          const values = output.trim().split("\n");
          const status =
            config.platform === "windows"
              ? JSON.parse(output)
              : { hostname: values[0], platform: values[1], arch: values[2], shell: values[3] };
          resolve({
            ...status,
            capabilities: { shell: true, browser: false, pty: true, desktop: false },
          });
        } catch {
          reject(new ConnectorError("SSH 호스트 정보 응답이 올바르지 않습니다"));
        }
      },
    ).then(
      (value) => {
        control = value;
        if (cancelled || signal?.aborted) abort();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
async function manager(
  ctx: ConnectorContext,
  config: RemoteHostConfig,
  secrets: RemoteHostSecrets,
) {
  if (!ctx.stateDir) throw new ConnectorError("SSH 작업 기록 디렉터리가 설정되지 않았습니다");
  const version = createHash("sha256").update(JSON.stringify({ config, secrets })).digest("hex");
  const key = `${ctx.stateDir}/${version}`;
  let value = managers.get(key);
  if (!value) {
    value = new RemoteJobManager(key, sshJobDriver(config, secrets)).initialize();
    managers.set(key, value);
    value.catch(() => managers.delete(key));
  }
  return value;
}
function operations(): ConnectorOperationInfo[] {
  return [...Object.entries(remoteReadSchemas), ...Object.entries(remoteWriteSchemas)].map(
    ([name, schema]) => ({
      name,
      label: remoteOperationLabels[name],
      description: remoteOperationLabels[name],
      kind: name in remoteWriteSchemas ? "write" : "read",
      params: [],
      paramsSchema: z.toJSONSchema(schema, { io: "input" }),
    }),
  );
}
export function remoteHostAdapter(): ConnectorAdapter {
  const request = (ctx: ConnectorContext, path: string, body?: unknown) => {
    const { config, secrets } = context(ctx);
    const url = new URL(`${config.baseUrl!.replace(/\/$/, "")}${path}`);
    return httpJson(url, {
      method: body === undefined ? "GET" : "POST",
      json: body,
      headers: { Authorization: `Bearer ${secrets.token}` },
      secrets: secretsOf(secrets),
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      maxBytes: 1024 * 1024,
    });
  };
  const scrub = (value: unknown, secrets: RemoteHostSecrets): unknown => {
    if (typeof value === "string") return redact(value, secretsOf(secrets));
    if (Array.isArray(value)) return value.map((item) => scrub(item, secrets));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          redact(key, secretsOf(secrets)),
          scrub(item, secrets),
        ]),
      );
    return value;
  };
  return {
    info: {
      provider: "remote_host",
      label: "원격 호스트",
      description: "Linux·Windows·macOS의 SSH 셸 또는 Host Agent 셸·공유 브라우저를 연결합니다.",
      configFields: [
        {
          name: "mode",
          label: "연결 방식",
          required: true,
          type: "text",
          description: "agent 또는 ssh",
          enum: ["agent", "ssh"],
        },
        {
          name: "platform",
          label: "대상 운영체제",
          required: true,
          type: "text",
          description: "linux / windows / macos",
          enum: ["linux", "windows", "macos"],
        },
        {
          name: "allowAgentShell",
          label: "에이전트 셸 명령 실행 허용",
          required: false,
          type: "boolean",
          description:
            "켜면 에이전트가 이 호스트 사용자 권한으로 명령을 실행할 수 있습니다. 끄면 기존 작업 검토를 사용합니다.",
        },
        {
          name: "baseUrl",
          label: "Host Agent 주소",
          required: false,
          type: "url",
          description: "agent 방식: http://대상주소:8791",
        },
        { name: "host", label: "SSH 호스트", required: false },
        { name: "port", label: "SSH 포트", required: false, description: "기본값 22" },
        { name: "username", label: "SSH 사용자", required: false },
        {
          name: "hostFingerprint",
          label: "SSH 호스트 지문",
          required: false,
          description: "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub로 확인한 SHA256: 지문",
        },
      ],
      secretFields: [
        { name: "token", label: "Host Agent 토큰", required: false, type: "password" },
        {
          name: "privateKey",
          label: "SSH 개인 키 (PEM/OpenSSH)",
          required: false,
          type: "password",
        },
        { name: "passphrase", label: "SSH 개인 키 암호", required: false, type: "password" },
      ],
      operations: operations(),
    },
    async test(ctx) {
      try {
        const result = (await this.run(ctx, "host_status", {})) as {
          hostname: string;
          platform: string;
          arch: string;
        };
        return { ok: true, detail: `${result.hostname} · ${result.platform} · ${result.arch}` };
      } catch (error) {
        return {
          ok: false,
          detail:
            error instanceof ConnectorError
              ? error.message
              : "호스트 연결 실패: 주소와 인증 정보를 확인하세요",
        };
      }
    },
    async run(ctx, operation, params) {
      const parsed = parseRemoteOperation(operation, params),
        { config, secrets } = context(ctx);
      let result: unknown;
      if (config.mode === "agent")
        result = await request(
          ctx,
          operation === "host_status"
            ? "/host"
            : operation === "host_jobs"
              ? "/jobs"
              : `/jobs/${parsed.jobId}`,
        );
      else if (operation === "host_status") result = await sshStatus(config, secrets, ctx.signal);
      else {
        const jobs = await manager(ctx, config, secrets);
        result =
          operation === "host_jobs"
            ? { jobs: jobs.list() }
            : { job: jobs.get(String(parsed.jobId)) };
      }
      if (operation === "host_status") {
        const status = remoteHostStatusSchema.safeParse(result);
        if (!status.success)
          throw new ConnectorError(
            "호스트 상태 응답이 올바르지 않습니다. Host Agent 주소를 확인하세요",
            undefined,
            "malformed",
          );
        result = status.data;
      }
      return scrub(result, secrets);
    },
    async write(ctx, input) {
      const parsed = parseRemoteOperation(input.operation, input.params, true),
        { config, secrets } = context(ctx);
      let result: unknown;
      if (config.mode === "agent")
        result = await request(
          ctx,
          input.operation === "host_command"
            ? "/jobs"
            : `/jobs/${parsed.jobId}/${input.operation === "host_input" ? "input" : "stop"}`,
          parsed,
        );
      else {
        const jobs = await manager(ctx, config, secrets);
        const { jobId, ...command } = parsed;
        result = {
          job:
            input.operation === "host_command"
              ? await jobs.start(command, typeof jobId === "string" ? jobId : undefined)
              : input.operation === "host_input"
                ? jobs.input(String(jobId), String(parsed.text))
                : jobs.stop(String(jobId)),
        };
      }
      return scrub(result, secrets);
    },
  };
}
