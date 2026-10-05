import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  type HostMetricPoint,
  type HostMetrics,
  type HostMetricsView,
  hostMetricsSchema,
} from "../../../packages/domain/src/host-metrics.ts";
import type { ConnectorService } from "./connector-service.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

const windowMs = 30 * 60 * 1000;
const rate = (now: number | null, before: number | null | undefined, seconds: number) =>
  now !== null && before != null && now >= before && seconds > 0 ? (now - before) / seconds : null;
export function deriveMetrics(sample: HostMetrics, before?: HostMetrics | null): HostMetrics {
  const data = structuredClone(sample),
    seconds = before ? (Date.parse(data.collectedAt) - Date.parse(before.collectedAt)) / 1000 : 0;
  const continuity =
    before &&
    seconds > 0 &&
    seconds <= 30 &&
    before.hostname === data.hostname &&
    before.cpu.model === data.cpu.model &&
    (before.uptime === null || data.uptime === null || data.uptime >= before.uptime);
  if (!continuity) {
    data.cpu.percent = data.cpu.percent === null ? null : Math.min(100, data.cpu.percent);
    return data;
  }
  if (data.cpu.ticks && before.cpu.ticks) {
    const total = data.cpu.ticks.total - before.cpu.ticks.total,
      idle = data.cpu.ticks.idle - before.cpu.ticks.idle;
    data.cpu.percent = total > 0 && idle >= 0 && idle <= total ? 100 * (1 - idle / total) : null;
  }
  data.diskIO.readBps =
    data.diskIO.readBps ?? rate(data.diskIO.readBytes, before.diskIO.readBytes, seconds);
  data.diskIO.writeBps =
    data.diskIO.writeBps ?? rate(data.diskIO.writeBytes, before.diskIO.writeBytes, seconds);
  for (const network of data.network) {
    const old = before.network.find((n) => n.name === network.name);
    network.rxBps = network.rxBps ?? rate(network.rxBytes, old?.rxBytes, seconds);
    network.txBps = network.txBps ?? rate(network.txBytes, old?.txBytes, seconds);
  }
  return data;
}
const sum = (values: (number | null)[]) =>
  values.some((n) => n !== null) ? values.reduce<number>((a, b) => a + (b ?? 0), 0) : null;
export function metricPoint(data: HostMetrics, at: string): HostMetricPoint {
  return {
    at,
    cpu: data.cpu.percent,
    memory:
      data.memory.total && data.memory.used !== null
        ? Math.min(100, (100 * data.memory.used) / data.memory.total)
        : null,
    diskRead: data.diskIO.readBps,
    diskWrite: data.diskIO.writeBps,
    networkRx: sum(data.network.map((n) => n.rxBps)),
    networkTx: sum(data.network.map((n) => n.txBps)),
    watts: data.energy.watts,
  };
}
type Record = HostMetricsView & { target: string };
export class HostMetricsService {
  private pending = new Map<string, Promise<HostMetricsView>>();
  constructor(
    private readonly db: Store,
    private readonly connectors: ConnectorService,
    private readonly clock = Date.now,
  ) {}
  async read(owner: string, id: string): Promise<HostMetricsView> {
    const connector = await this.connectors.get(owner, id);
    if (connector.provider !== "remote_host")
      throw new AppError("원격 호스트 연결이 아닙니다.", 422);
    const target = createHash("sha256")
      .update(JSON.stringify([connector.config, connector.updatedAt]))
      .digest("hex");
    const key = `${owner}:${id}:${target}`;
    const before = await this.db.get<Record>(owner, "host-metrics", id);
    if (before?.target === target && this.clock() - Date.parse(before.checkedAt) < 4500)
      return this.view(before);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.collect(owner, id, target, before?.target === target ? before : null).finally(
        () => this.pending.delete(key),
      );
      this.pending.set(key, pending);
    }
    return pending;
  }
  private view({ target: _, ...data }: Record): HostMetricsView {
    return data;
  }
  private async collect(owner: string, id: string, target: string, before: Record | null) {
    const now = this.clock(),
      checkedAt = new Date(now).toISOString();
    const result: Record = {
      id,
      target,
      checkedAt,
      status: "online",
      sample: before?.sample ?? null,
      history: (before?.history ?? []).filter((p) => Date.parse(p.at) >= now - windowMs),
    };
    try {
      const raw = hostMetricsSchema.parse(
        await this.connectors.run(owner, id, "host_metrics", {}, AbortSignal.timeout(18000)),
      );
      if (Math.abs(Date.now() - Date.parse(raw.collectedAt)) > 120000)
        throw new Error("호스트 시계 또는 수집 시간이 올바르지 않습니다. 시간을 동기화하세요.");
      result.sample = deriveMetrics(raw, before?.sample);
      result.history.push(metricPoint(result.sample, checkedAt));
    } catch (error) {
      result.error =
        error instanceof Error ? error.message : "호스트 사용량을 가져오지 못했습니다.";
      if (/404|NOT_FOUND|최신 버전/.test(result.error)) {
        result.status = "unsupported";
        result.error =
          "사용량 조회를 지원하지 않는 Host Agent입니다. 0.5.0 이상으로 업데이트하세요.";
      } else result.status = "offline";
      result.history.push({
        at: checkedAt,
        cpu: null,
        memory: null,
        diskRead: null,
        diskWrite: null,
        networkRx: null,
        networkTx: null,
        watts: null,
      });
    }
    // Recheck ownership and target after I/O: deletion/replacement must not revive old telemetry.
    const current = await this.connectors.get(owner, id);
    if (
      createHash("sha256")
        .update(JSON.stringify([current.config, current.updatedAt]))
        .digest("hex") !== target
    )
      throw new AppError("연결 설정이 변경되었습니다. 다시 조회하세요.", 409);
    result.history = result.history.slice(-360);
    await this.db.put(owner, "host-metrics", result);
    return this.view(result);
  }
}
export function hostMetricsRoutes(metrics: HostMetricsService, connectors: ConnectorService) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/", async (c) =>
    c.json({
      hosts: (await connectors.list(c.get("owner"))).filter((v) => v.provider === "remote_host"),
    }),
  );
  app.get("/:id/metrics", async (c) =>
    c.json(await metrics.read(c.get("owner"), c.req.param("id"))),
  );
  return app;
}
