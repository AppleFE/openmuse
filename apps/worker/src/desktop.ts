import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { desktopActionSchema, playwrightKey } from "./automation-schema.ts";
import { type Session, validateSessionId } from "./browser.ts";
import { WorkerError } from "./errors.ts";

export interface DesktopOptions {
  python?: string;
  driver?: string;
  virtualImage?: string;
  nativeProxy?: { url: string; token: string };
  nativeProxyFile?: string;
  idleTimeoutMs?: number;
}
const execFileAsync = promisify(execFile);
function desktopEnv(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "DISPLAY",
    "XAUTHORITY",
    "XDG_SESSION_TYPE",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "SystemRoot",
    "WINDIR",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "TEMP",
    "TMP",
  ];
  return {
    ...Object.fromEntries(
      allowed.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
    ),
    PYTHONIOENCODING: "utf-8",
  };
}
class DesktopRPC {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending?: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private closed = false;
  constructor(command: string, args: string[], env?: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, { stdio: "pipe", windowsHide: true, env });
    this.child.stderr.resume();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 12 * 1024 * 1024) {
        this.fail("Desktop screenshot exceeded the response limit");
        this.child.kill();
        return;
      }
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      const p = this.pending;
      if (!p) return;
      this.pending = undefined;
      clearTimeout(p.timer);
      try {
        const data = JSON.parse(line);
        if (data.error) p.reject(new WorkerError("DESKTOP_UNAVAILABLE", data.error, 409));
        else p.resolve(data.result);
      } catch {
        p.reject(
          new WorkerError("DESKTOP_PROTOCOL", "Desktop helper returned an invalid response", 502),
        );
      }
    });
    this.child.on("error", () =>
      this.fail("Desktop runtime could not start. Install its dependencies first."),
    );
    this.child.on("close", () => {
      this.closed = true;
      this.fail("Desktop helper stopped. Reopen the desktop session.");
    });
    this.child.stdin.on("error", () => this.fail("Desktop helper input is closed"));
  }
  private fail(message: string) {
    const p = this.pending;
    if (p) {
      this.pending = undefined;
      clearTimeout(p.timer);
      p.reject(new WorkerError("DESKTOP_UNAVAILABLE", message, 503));
    }
  }
  request(input: unknown): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new WorkerError("DESKTOP_CLOSED", "Desktop session is closed", 409));
    if (this.pending) return Promise.reject(Error("Concurrent desktop RPC"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail("Desktop action timed out; its outcome is uncertain. Inspect before retrying.");
        this.child.kill();
      }, 15000);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(JSON.stringify(input) + "\n");
    });
  }
  async close(reset = true) {
    if (!this.closed) {
      if (reset) await this.request({ action: "reset" }).catch(() => {});
      this.child.stdin.end();
      this.child.kill();
    }
    this.closed = true;
  }
}

export async function createDesktopManager(dataDir: string, options: DesktopOptions = {}) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  type Desktop = Session & { kind: "desktop"; desktopMode: "virtual" | "native" };
  const sessions = new Map<string, Desktop>(),
    running = new Map<string, DesktopRPC>(),
    queues = new Map<string, Promise<unknown>>(),
    buttons = new Map<string, number>();
  const touched = new Map<string, number>();
  async function refreshOptions() {
    if (
      options.nativeProxyFile &&
      ![...sessions.values()].some((s) => s.status === "active" && s.desktopMode === "native")
    ) {
      try {
        const config = JSON.parse(await readFile(options.nativeProxyFile, "utf8"));
        if (
          typeof config.desktopProxy?.url === "string" &&
          typeof config.desktopProxy?.token === "string" &&
          config.desktopProxy.token.length >= 32
        )
          options.nativeProxy = config.desktopProxy;
      } catch {
        /* The installed service may not have a native desktop helper yet. */
      }
    }
  }
  const container = (id: string) =>
    `openmuse-desktop-${createHash("sha256")
      .update(dataDir + id)
      .digest("hex")
      .slice(0, 24)}`;
  const path = (id: string) => join(dataDir, validateSessionId(id) + ".json");
  async function removeContainer(id: string) {
    await execFileAsync("docker", ["rm", "-f", container(id)], {
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 8192,
    }).catch(() => {});
  }
  for (const name of await readdir(dataDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const value = JSON.parse(await readFile(join(dataDir, name), "utf8"));
      validateSessionId(value.id);
      sessions.set(value.id, { ...value, status: "closed" });
      if (value.desktopMode === "virtual" && value.status === "active")
        await removeContainer(value.id);
    } catch {}
  }
  async function save(s: Desktop) {
    sessions.set(s.id, s);
    await writeFile(path(s.id), JSON.stringify(s), { mode: 0o600 });
    return s;
  }
  async function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    queues.set(id, next);
    try {
      return await next;
    } finally {
      if (queues.get(id) === next) queues.delete(id);
    }
  }
  async function proxy(endpoint: string, body?: unknown) {
    if (!options.nativeProxy)
      throw new WorkerError("DESKTOP_UNAVAILABLE", "Logged-in user helper is not configured", 409);
    const base = new URL(options.nativeProxy.url);
    if (!["127.0.0.1", "[::1]"].includes(base.hostname))
      throw new Error("Desktop helper must use loopback");
    const response = await fetch(new URL(endpoint, base), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + options.nativeProxy.token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(18000),
    }).catch(() => {
      throw new WorkerError(
        "DESKTOP_UNAVAILABLE",
        "The logged-in user helper is offline. Sign in and start OpenMuse Desktop.",
        503,
      );
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new WorkerError(
        "DESKTOP_UNAVAILABLE",
        error?.error?.message ?? "Desktop helper rejected the request",
        409,
      );
    }
    return response;
  }
  const get = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new WorkerError("SESSION_NOT_FOUND", "Desktop not found", 404);
    return s;
  };
  const isProxy = (id: string) => get(id).desktopMode === "native" && !!options.nativeProxy;
  async function rpc(id: string, input: unknown) {
    const driver = running.get(id);
    if (!driver) throw new WorkerError("SESSION_CLOSED", "Open the desktop first", 409);
    touched.set(id, Date.now());
    return driver.request(input);
  }
  async function stop(id: string) {
    const s = get(id);
    if (isProxy(id)) await proxy(`/sessions/${id}/close`, {});
    else {
      await running.get(id)?.close();
      running.delete(id);
      if (s.desktopMode === "virtual") await removeContainer(id);
    }
    touched.delete(id);
    buttons.delete(id);
    return save({ ...s, status: "closed", updatedAt: new Date().toISOString() });
  }
  const sweeper = setInterval(() => {
    for (const [id, time] of touched)
      if (Date.now() - time > (options.idleTimeoutMs ?? 30 * 60_000))
        void serial(id, () => stop(id)).catch(() => {});
  }, 60000);
  sweeper.unref();
  function nativeDriver() {
    if (!options.python)
      throw new WorkerError("DESKTOP_UNCONFIGURED", "Desktop Python is not configured", 409);
    return new DesktopRPC(
      options.python,
      [
        "-u",
        options.driver ??
          fileURLToPath(new URL("../../../infra/desktop/driver.py", import.meta.url)),
      ],
      desktopEnv(),
    );
  }
  async function status() {
    await refreshOptions();
    let virtual: { available: boolean; reason?: string } = {
      available: false,
      reason: "가상 데스크톱 이미지를 설치하고 OPENMUSE_DESKTOP_IMAGE를 설정하세요.",
    };
    let native: { available: boolean; reason?: string } = {
      available: false,
      reason:
        "로그인 사용자용 OpenMuse Desktop 보조 프로그램을 설치하세요. SYSTEM/root 셸과 화면 접근은 별개입니다.",
    };
    if (options.virtualImage)
      try {
        await execFileAsync("docker", ["image", "inspect", options.virtualImage], {
          timeout: 5000,
          windowsHide: true,
          maxBuffer: 128 * 1024,
        });
        virtual = { available: true };
      } catch {
        virtual.reason = "Docker를 실행하고 가상 데스크톱 이미지를 빌드하세요.";
      }
    if (options.nativeProxy)
      try {
        native = (await (await proxy("/capabilities")).json()).desktop.native;
      } catch (e) {
        native.reason = e instanceof Error ? e.message : "Desktop helper offline";
      }
    else if (options.python) {
      const driver = nativeDriver();
      try {
        await driver.request({ action: "status" });
        native = { available: true };
      } catch (e) {
        native.reason = e instanceof Error ? e.message : "Desktop helper unavailable";
      } finally {
        await driver.close(false);
      }
    }
    return { virtual, native };
  }
  return {
    has: (id: string) => sessions.has(id),
    list: () => [...sessions.values()],
    status,
    create: (id: string, mode: "virtual" | "native") =>
      serial("create", () =>
        serial(id, async () => {
          await refreshOptions();
          validateSessionId(id);
          const existing = sessions.get(id);
          if (existing && existing.desktopMode !== mode)
            throw new WorkerError(
              "SESSION_MODE",
              "Desktop mode cannot change for an existing session",
              409,
            );
          if (existing?.status === "active") return existing;
          if (sessions.size >= 20 && !existing)
            throw new WorkerError("PROFILE_LIMIT", "Delete an old desktop session first", 409);
          if ([...sessions.values()].filter((s) => s.status === "active").length >= 3)
            throw new WorkerError("SESSION_LIMIT", "Close an active desktop first", 409);
          if (
            mode === "native" &&
            [...sessions.values()].some(
              (s) => s.desktopMode === "native" && s.status === "active" && s.id !== id,
            )
          )
            throw new WorkerError(
              "DESKTOP_BUSY",
              "The native desktop is already attached to another session",
              409,
            );
          const session: Desktop = {
            id,
            kind: "desktop",
            desktopMode: mode,
            title: mode === "native" ? "호스트 데스크톱" : "가상 데스크톱",
            url: "desktop://" + mode,
            status: "active",
            updatedAt: new Date().toISOString(),
          };
          await save({ ...session, status: "error" });
          touched.set(id, Date.now());
          if (mode === "native" && options.nativeProxy) {
            await proxy("/sessions", {
              id,
              kind: "desktop",
              desktopMode: "native",
              url: "desktop://native",
            });
            return save(session);
          }
          let driver: DesktopRPC;
          if (mode === "virtual") {
            if (!options.virtualImage)
              throw new WorkerError(
                "DESKTOP_UNCONFIGURED",
                "가상 데스크톱 이미지를 설치하고 OPENMUSE_DESKTOP_IMAGE를 설정하세요.",
                409,
              );
            driver = new DesktopRPC("docker", [
              "run",
              "--rm",
              "-i",
              "--name",
              container(id),
              "--label",
              "dev.openmuse.desktop=true",
              "--network",
              "none",
              "--read-only",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges",
              "--memory",
              "1g",
              "--pids-limit",
              "128",
              "--cpus",
              "2",
              "--tmpfs",
              "/tmp:rw,nosuid,nodev,size=256m",
              "--tmpfs",
              "/home/desktop:rw,nosuid,nodev,size=256m,uid=1000,gid=1000",
              options.virtualImage,
            ]);
          } else {
            if (!options.python)
              throw new WorkerError(
                "DESKTOP_UNCONFIGURED",
                "로그인 사용자용 OpenMuse Desktop을 설치하세요. 백그라운드 SYSTEM 계정은 화면에 접근할 수 없습니다.",
                409,
              );
            driver = nativeDriver();
          }
          running.set(id, driver);
          try {
            await driver.request({ action: "status" });
            await driver.request({ action: "screenshot" });
            return await save(session);
          } catch (e) {
            await driver.close();
            running.delete(id);
            if (mode === "virtual") {
              sessions.set(id, { ...session, status: "error" });
              await stop(id);
            }
            throw e;
          }
        }),
      ),
    action: (id: string, raw: unknown) =>
      serial(id, async () => {
        const input = desktopActionSchema.parse(raw);
        if (input.action === "key") input.text = playwrightKey(input.text);
        touched.set(id, Date.now());
        if (isProxy(id))
          return (await (await proxy(`/sessions/${id}/automation`, input)).json()).result;
        return rpc(id, input);
      }),
    screenshot: (id: string, live = false) =>
      serial(id, async () => {
        touched.set(id, Date.now());
        if (isProxy(id))
          return Buffer.from(
            await (await proxy(`/sessions/${id}/${live ? "frame" : "screenshot"}`)).arrayBuffer(),
          );
        const image = z
          .object({ data: z.string().max(8 * 1024 * 1024) })
          .parse(await rpc(id, { action: live ? "frame" : "screenshot" }));
        return Buffer.from(image.data, "base64");
      }),
    input: (id: string, input: Record<string, unknown>) =>
      serial(id, async () => {
        touched.set(id, Date.now());
        if (isProxy(id)) return (await proxy(`/sessions/${id}/input`, input)).json();
        let action: unknown;
        if (input.type === "vnc_reset") {
          buttons.delete(id);
          action = { action: "reset" };
        } else if (input.type === "vnc_mouse") {
          const coordinate = desktopActionSchema.parse({
            action: "mouse_move",
            coordinate: [input.x, input.y],
          });
          const value = input.buttons;
          if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255)
            throw new Error("Invalid mouse");
          action = {
            action: "pointer_event",
            coordinate: "coordinate" in coordinate ? coordinate.coordinate : [],
            buttons: value,
            previous: buttons.get(id) ?? 0,
          };
          buttons.set(id, value);
        } else if (input.type === "vnc_key") {
          if (typeof input.key !== "string" || typeof input.down !== "boolean")
            throw new Error("Invalid key");
          if ([...input.key].length === 1 && !/^[a-zA-Z0-9]$/.test(input.key)) {
            if (!input.down) return { ok: true };
            action = { action: "type", text: input.key };
          } else action = { action: "key_event", key: playwrightKey(input.key), down: input.down };
        } else if (input.type === "text")
          action = desktopActionSchema.parse({ action: "type", text: input.text });
        else if (input.type === "click")
          action = desktopActionSchema.parse({
            action: "left_click",
            coordinate: [input.x, input.y],
          });
        else if (input.type === "key")
          action = desktopActionSchema.parse({
            action: "key",
            text: playwrightKey(String(input.key)),
          });
        else throw new WorkerError("INVALID_INPUT", "Unsupported desktop input", 422);
        await rpc(id, action);
        return { ok: true };
      }),
    closeSession: (id: string) => serial(id, () => stop(id)),
    remove: (id: string) =>
      serial(id, async () => {
        if (get(id).status === "active") await stop(id);
        if (isProxy(id)) await proxy(`/sessions/${id}/delete`, {});
        sessions.delete(id);
        touched.delete(id);
        buttons.delete(id);
        await unlink(path(id)).catch(() => {});
        return { ok: true };
      }),
    close: async () => {
      clearInterval(sweeper);
      for (const [id, s] of sessions)
        if (s.status === "active") await serial(id, () => stop(id)).catch(() => {});
    },
  };
}
