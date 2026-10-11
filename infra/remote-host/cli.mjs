#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const version = "0.10.3";
const output = (data) => process.stdout.write(JSON.stringify({ ok: true, data }) + "\n");
const fail = (message, code = "INVALID_INPUT", exitCode = 2) =>
  Object.assign(new Error(message), { code, exitCode });
const directory =
  process.env.OPENMUSE_CLI_HOME ??
  (process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? homedir(), "OpenMuseCLI")
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "openmuse-cli"));
const settingsPath = join(directory, "config.json");
async function settings() {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw fail("CLI 설정을 읽을 수 없습니다");
  }
}
const validTarget = (v) => {
  if (
    !v.trim() ||
    v.trim().length > 205 ||
    Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw fail("대상은 main, host 또는 기존 대화 ID/이름이어야 합니다");
  return v.trim();
};
async function api(path, body, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw fail("유효하지 않은 로컬 알림 포트입니다");
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "X-OpenMuse-Client": "cli",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw fail("이 PC의 OpenMuse Host Agent가 실행 중인지 확인하세요", "HOST_AGENT_UNAVAILABLE", 3);
  }
  const result = await response.json();
  if (!response.ok)
    throw fail(
      result.error ?? "보고를 전송하지 못했습니다. delivery show로 기록을 확인하세요",
      `HTTP_${response.status}`,
      response.status === 409 || response.status === 422 ? 2 : 1,
    );
  return result;
}
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      message: { type: "string" },
      file: { type: "string" },
      stdin: { type: "boolean" },
      target: { type: "string" },
      "thread-name": { type: "string" },
      type: { type: "string" },
      source: { type: "string" },
      task: { type: "string" },
      "idempotency-key": { type: "string" },
      "no-reply": { type: "boolean" },
      "dry-run": { type: "boolean" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
  if (values.version) console.log(version);
  else if (values.help || !positionals.length)
    console.log(
      `OpenMuse Host Agent CLI ${version}\n\nopenmuse send --message "작업 완료" [--target main|host|THREAD_ID|NAME] [--type completed|question|error|progress]\n  --thread-name NAME              이름으로 명시적 선택 (main/host 예약 이름 포함)\n  --file PATH | --stdin            UTF-8 메시지 (최대 32,000바이트)\n  --source codex --task TASK_ID    보고한 에이전트와 작업 이름\n  --idempotency-key KEY            재시도할 때 같은 키 사용\n  --no-reply                      대화에 저장만 하고 AI는 호출하지 않음\n  --dry-run                       입력만 검증\nopenmuse delivery show KEY\nopenmuse status\nopenmuse config set-target main|host|THREAD_ID|NAME\nopenmuse config show\nopenmuse schema\n\n설치된 Host Agent의 로컬 API(127.0.0.1:8792)를 사용합니다. 별도 로그인은 필요하지 않습니다.\n`,
    );
  else {
    const config = await settings(),
      port = Number(values.port ?? process.env.OPENMUSE_NOTIFY_PORT ?? 8792),
      cmd = positionals.join(" ");
    if (positionals[0] === "send" && positionals.length === 1) {
      if (
        [values.message !== undefined, values.file !== undefined, !!values.stdin].filter(Boolean)
          .length !== 1
      )
        throw fail("--message, --file, --stdin 중 하나를 지정하세요");
      let bytes;
      if (values.message !== undefined) bytes = Buffer.from(values.message, "utf8");
      else if (values.file !== undefined) {
        const p = resolve(values.file);
        if ((await stat(p)).size > 32000) throw fail("메시지가 32,000바이트를 초과했습니다");
        bytes = await readFile(p);
      } else {
        if (process.stdin.isTTY) throw fail("--stdin은 파이프 입력이 필요합니다");
        const chunks = [];
        let size = 0;
        for await (const chunk of process.stdin) {
          size += chunk.length;
          if (size > 32000) throw fail("메시지가 32,000바이트를 초과했습니다");
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
      }
      if (bytes.length > 32000) throw fail("메시지가 32,000바이트를 초과했습니다");
      let message;
      try {
        message = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
      } catch {
        throw fail("메시지는 UTF-8이어야 합니다");
      }
      if (!message || message.includes("\0")) throw fail("메시지가 비어 있거나 유효하지 않습니다");
      const input = {
        key: values["idempotency-key"] ?? randomUUID(),
        target: validTarget(
          values["thread-name"] === undefined
            ? (values.target ?? config.target ?? "main")
            : `name:${values["thread-name"].trim()}`,
        ),
        type: values.type ?? "completed",
        source: values.source ?? "agent",
        ...(values.task ? { task: values.task } : {}),
        message,
        reply: !values["no-reply"],
      };
      if (values.target !== undefined && values["thread-name"] !== undefined)
        throw fail("--target과 --thread-name 중 하나만 지정하세요");
      if (
        values["thread-name"] !== undefined &&
        (!values["thread-name"].trim() || values["thread-name"].trim().length > 200)
      )
        throw fail("대화 이름은 1~200자여야 합니다");
      if (!["completed", "question", "error", "progress"].includes(input.type))
        throw fail("유효하지 않은 보고 유형입니다");
      for (const [v, max] of [
        [input.key, 160],
        [input.source, 80],
        ...(input.task ? [[input.task, 160]] : []),
      ])
        if (!v.trim() || v.length > max || v.includes("\0"))
          throw fail("키·에이전트·작업 이름을 확인하세요");
      output(
        values["dry-run"]
          ? {
              dryRun: true,
              target: input.target,
              bytes: bytes.length,
              key: input.key,
              reply: input.reply,
            }
          : await api("/events", input, port),
      );
    } else if (cmd === "status") output(await api("/status", undefined, port));
    else if (positionals[0] === "delivery" && positionals[1] === "show" && positionals.length === 3)
      output(await api("/events/" + encodeURIComponent(positionals[2]), undefined, port));
    else if (cmd === "config show") output({ target: config.target ?? "main", port });
    else if (
      positionals[0] === "config" &&
      positionals[1] === "set-target" &&
      positionals.length === 3
    ) {
      config.target = validTarget(positionals[2]);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(settingsPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      output(config);
    } else if (cmd === "schema")
      output({
        version,
        transport: "Host Agent loopback HTTP",
        endpoint: "http://127.0.0.1:8792/events",
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenMuse-Client": "cli" },
        input: {
          key: "string, stable unique key, max 160",
          target:
            "main (default), host, existing thread ID or unique name; name:NAME forces name lookup",
          type: ["completed", "question", "error", "progress"],
          source: "string, max 80",
          task: "optional string, max 160",
          message: "UTF-8 string, max 32000 bytes",
          reply: "boolean, default true",
        },
        statuses: {
          queued: "saved locally; retry pending",
          accepted: "stored by OpenMuse; event.status shows AI delivery",
          failed: "rejected; inspect error",
        },
      });
    else throw fail("지원하지 않는 명령입니다. openmuse --help를 확인하세요");
  }
} catch (e) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: {
        code: e.code ?? "FAILED",
        message: e.message,
        retryable: e.code === "HOST_AGENT_UNAVAILABLE",
      },
    }) + "\n",
  );
  process.exitCode = e.exitCode ?? (e.code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1);
}
