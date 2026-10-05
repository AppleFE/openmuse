import { z } from "zod";

const number = z.number().finite().nonnegative();
const nullable = number.nullable();
const text = z.string().max(512);
const ticks = z.object({ total: number, idle: number });
export const hostMetricsSchema = z.object({
  version: z.literal(1),
  collectedAt: z.string().datetime(),
  hostname: text,
  platform: text,
  arch: text,
  os: text,
  agentVersion: text.optional(),
  uptime: nullable,
  cpu: z.object({
    model: text,
    cores: number.max(4096),
    percent: nullable,
    ticks: ticks.optional(),
    perCore: z.array(ticks).max(4096).optional(),
  }),
  memory: z.object({
    total: nullable,
    available: nullable,
    used: nullable,
    swapTotal: nullable,
    swapUsed: nullable,
  }),
  disks: z
    .array(
      z.object({
        device: text,
        mount: text,
        type: text,
        total: number,
        used: number,
        available: number,
      }),
    )
    .max(128),
  diskIO: z.object({
    readBytes: nullable,
    writeBytes: nullable,
    readBps: nullable,
    writeBps: nullable,
  }),
  network: z
    .array(
      z.object({
        name: text,
        state: text,
        speedMbps: nullable,
        rxBytes: nullable,
        txBytes: nullable,
        rxBps: nullable,
        txBps: nullable,
      }),
    )
    .max(128),
  energy: z.object({
    hasBattery: z.boolean().nullable(),
    percent: nullable,
    charging: z.boolean().nullable(),
    acConnected: z.boolean().nullable(),
    watts: nullable,
    source: text,
    detail: text,
  }),
  warnings: z.array(text).max(16),
});
export type HostMetrics = z.infer<typeof hostMetricsSchema>;
export interface HostMetricPoint {
  at: string;
  cpu: number | null;
  memory: number | null;
  diskRead: number | null;
  diskWrite: number | null;
  networkRx: number | null;
  networkTx: number | null;
  watts: number | null;
}
export interface HostMetricsView {
  id: string;
  status: "online" | "offline" | "unsupported";
  checkedAt: string;
  error?: string;
  sample: HostMetrics | null;
  history: HostMetricPoint[];
}
export const finiteMetric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export function emptyMetrics(platform: string): HostMetrics {
  return {
    version: 1,
    collectedAt: new Date().toISOString(),
    hostname: "",
    platform,
    arch: "",
    os: "",
    uptime: null,
    cpu: { model: "", cores: 0, percent: null },
    memory: { total: null, used: null, available: null, swapTotal: null, swapUsed: null },
    disks: [],
    diskIO: { readBytes: null, writeBytes: null, readBps: null, writeBps: null },
    network: [],
    energy: {
      hasBattery: null,
      percent: null,
      charging: null,
      acConnected: null,
      watts: null,
      source: "unavailable",
      detail: "이 환경에서 실소비전력을 제공하지 않습니다.",
    },
    warnings: [],
  };
}
