import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import {
  type HostEvent,
  type HostEventInput,
  hostEventInputSchema,
} from "../../../packages/domain/src/host-events.ts";
import { readBody } from "../../worker/src/server.ts";

type Config = { token: string; connectorId: string; enrollmentOrigin: string };
type Receipt = {
  id: string;
  input: HostEventInput;
  binding: string;
  status: "queued" | "accepted" | "failed";
  createdAt: string;
  attempts: number;
  retryAt: number;
  event?: HostEvent;
  error?: string;
};
const configSchema = z.object({
  token: z.string().min(32).max(512),
  connectorId: z.uuid(),
  enrollmentOrigin: z.url().refine((v) => {
    const u = new URL(v);
    return (
      /^https?:$/.test(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === "/"
    );
  }),
});
const digest = (v: string) => createHash("sha256").update(v).digest("hex");

/** Loopback-only reporting gateway. It never exposes credentials or shell/browser operations. */
export async function createNotificationGateway(options: {
  dataDir: string;
  config: () => Promise<unknown>;
  retryMs?: number;
  fetch?: typeof fetch;
}) {
  const path = join(options.dataDir, "notifications.json"),
    request = options.fetch ?? fetch;
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  let records: Receipt[] = [];
  try {
    records = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (!Array.isArray(records)) throw new Error("Invalid notification outbox");
  let lock: Promise<unknown> = Promise.resolve(),
    flushing: Promise<void> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    closed = false;
  const serial = <T>(fn: () => Promise<T>) => {
    const result = lock.then(fn);
    lock = result.catch(() => {});
    return result;
  };
  const save = async () => {
    const final = records
      .filter((r) => r.status !== "queued")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const retain = new Set(final.slice(0, 500).map((r) => r.id));
    records = records.filter((r) => r.status === "queued" || retain.has(r.id));
    await writeFile(path + ".tmp", JSON.stringify(records), { mode: 0o600 });
    await rename(path + ".tmp", path);
  };
  const configuration = async (): Promise<Config> => configSchema.parse(await options.config());
  const endpoint = (c: Config) =>
    `${new URL(c.enrollmentOrigin).origin}/api/host-agent/${c.connectorId}/events`;
  function schedule() {
    if (timer) clearTimeout(timer);
    if (closed) return;
    const next = records
      .filter((r) => r.status === "queued")
      .sort((a, b) => a.retryAt - b.retryAt)[0];
    if (next) {
      timer = setTimeout(() => void flush(), Math.max(100, next.retryAt - Date.now()));
      timer.unref();
    }
  }
  function flush(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      while (!closed) {
        const item = records.find((r) => r.status === "queued" && r.retryAt <= Date.now());
        if (!item) break;
        let status: number | undefined, event: HostEvent | undefined;
        try {
          const config = await configuration();
          if (item.binding !== endpoint(config)) {
            status = 409;
            throw Error("Host enrollment changed");
          }
          const response = await request(endpoint(config), {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(item.input),
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          status = response.status;
          if (response.ok) {
            const body = (await response.json()) as { event?: HostEvent };
            if (
              !body.event ||
              body.event.key !== item.input.key ||
              body.event.connectorId !== config.connectorId
            )
              throw Error("Invalid receipt");
            event = body.event;
          }
        } catch {
          /* Persist a retry without logging request credentials or provider bodies. */
        }
        await serial(async () => {
          const current = records.find((r) => r.id === item.id)!;
          current.attempts++;
          if (event) {
            current.status = "accepted";
            current.event = event;
            delete current.error;
          } else if (status && status >= 400 && status < 500 && ![408, 429].includes(status)) {
            current.status = "failed";
            current.error = `서버가 보고를 거부했습니다 (HTTP ${status}). 연결·대상·중복 키를 확인하세요.`;
          } else {
            current.retryAt =
              Date.now() +
              Math.min(60000, (options.retryMs ?? 2000) * 2 ** Math.min(current.attempts - 1, 5));
            current.error = "서버 연결 대기 중입니다. 저장된 보고를 자동으로 재전송합니다.";
          }
          await save();
        });
      }
    })()
      .catch(() => {
        /* A local disk failure is reported by receipt/status and never reported as sent. */
      })
      .finally(() => {
        flushing = undefined;
        schedule();
      });
    return flushing;
  }
  const server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(body));
    };
    try {
      const port = (server.address() as { port: number } | null)?.port;
      if (
        req.headers.host !== `127.0.0.1:${port}` ||
        req.headers.origin ||
        req.headers["sec-fetch-site"] ||
        req.headers["x-openmuse-client"] !== "cli"
      )
        return json(403, { error: "로컬 CLI/API 호출만 허용됩니다" });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/status") {
        const config = await configuration();
        return json(200, {
          installed: true,
          connectorId: config.connectorId,
          server: config.enrollmentOrigin,
          queued: records.filter((r) => r.status === "queued").length,
          failed: records.filter((r) => r.status === "failed").length,
        });
      }
      if (req.method === "POST" && url.pathname === "/events") {
        const config = await configuration();
        const input = hostEventInputSchema.parse(await readBody(req)),
          id = digest(input.key);
        const receipt = await serial(async () => {
          const old = records.find((r) => r.id === id);
          if (old) {
            if (
              old.binding !== endpoint(config) ||
              JSON.stringify(old.input) !== JSON.stringify(input)
            )
              throw Object.assign(Error("같은 중복 방지 키에 다른 보고가 있습니다"), {
                status: 409,
              });
            return old;
          }
          if (records.filter((r) => r.status === "queued").length >= 100)
            throw Object.assign(Error("전송 대기함이 가득 찼습니다"), { status: 429 });
          const row: Receipt = {
            id,
            input,
            binding: endpoint(config),
            status: "queued",
            createdAt: new Date().toISOString(),
            attempts: 0,
            retryAt: 0,
          };
          records.push(row);
          try {
            await save();
          } catch (e) {
            records = records.filter((r) => r.id !== id);
            throw e;
          }
          return row;
        });
        await Promise.race([
          flush(),
          new Promise((r) => {
            const t = setTimeout(r, 1000);
            t.unref();
          }),
        ]);
        return json(receipt.status === "failed" ? 409 : 202, receipt);
      }
      if (req.method === "GET" && url.pathname.startsWith("/events/")) {
        const key = decodeURIComponent(url.pathname.slice(8));
        const receipt = records.find((r) => r.id === digest(key));
        if (!receipt) return json(404, { error: "전송 기록이 없습니다" });
        if (receipt.event) {
          const config = await configuration();
          if (receipt.binding !== endpoint(config))
            return json(409, { error: "이전 서버 연결의 보고입니다" });
          const response = await request(endpoint(config) + "/" + receipt.event.id, {
            headers: { Authorization: `Bearer ${config.token}` },
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          if (response.ok)
            return json(200, {
              ...receipt,
              event: ((await response.json()) as { event: HostEvent }).event,
            });
          return json(response.status, { error: "서버의 전송 기록을 확인하지 못했습니다" });
        }
        return json(200, receipt);
      }
      json(404, { error: "지원하지 않는 호출입니다" });
    } catch (e) {
      const status = e instanceof z.ZodError ? 422 : ((e as { status?: number }).status ?? 503);
      json(status, {
        error:
          status === 409 || status === 429
            ? (e as Error).message
            : "보고 설정·입력 또는 서버 연결을 확인하세요",
      });
    }
  });
  schedule();
  return {
    server,
    flush,
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await flushing;
      await lock;
    },
  };
}
