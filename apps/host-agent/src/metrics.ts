import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { arch, cpus, hostname, release, totalmem, uptime } from "node:os";
import { promisify } from "node:util";
import si from "systeminformation";
import {
  emptyMetrics,
  type HostMetrics,
  finiteMetric as metric,
} from "../../../packages/domain/src/host-metrics.ts";

const exec = promisify(execFile);
/** All probes are fixed, read-only OS queries. There is no sudo or user-supplied command. */
export class HostMetricsCollector {
  private pending?: Promise<HostMetrics>;
  private cached?: HostMetrics;
  private probes = new Map<string, Promise<unknown>>();
  private energy?: { at: number; values: Map<string, number> };
  async read(): Promise<HostMetrics> {
    if (this.cached && Date.now() - Date.parse(this.cached.collectedAt) < 4000) return this.cached;
    this.pending ??= this.collect()
      .then((data) => (this.cached = data))
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async probe<T>(key: string, read: () => Promise<T>): Promise<T | null> {
    let operation = this.probes.get(key) as Promise<T> | undefined;
    if (!operation) {
      operation = read().finally(() => this.probes.delete(key));
      this.probes.set(key, operation);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 4000);
        }),
      ]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async power(): Promise<{ watts: number | null; source: string; detail: string }> {
    if (process.platform === "darwin") {
      if (process.getuid?.() !== 0)
        return {
          watts: null,
          source: "unavailable",
          detail: "실소비전력은 관리자 Host Agent가 필요합니다. 현재 계정은 일반 사용자입니다.",
        };
      const { stdout } = await exec(
        "/usr/bin/powermetrics",
        ["--samplers", "cpu_power", "-i", "1000", "-n", "1"],
        { timeout: 2500, maxBuffer: 128 * 1024 },
      );
      const combined = /Combined Power[^\n]*?:\s*([\d.]+)\s*mW/i.exec(stdout);
      const cpu = /CPU Power:\s*([\d.]+)\s*mW/i.exec(stdout);
      const match = combined ?? cpu;
      return {
        watts: match ? Number(match[1]) / 1000 : null,
        source: combined ? "CPU + GPU + ANE" : "CPU",
        detail: "powermetrics 칩 전력 · PC 전체 소비전력과 다릅니다.",
      };
    }
    if (process.platform === "linux") {
      const root = "/sys/class/powercap",
        values = new Map<string, number>(),
        at = Date.now();
      for (const name of (await readdir(root))
        .filter((n) => /^(intel|amd)-rapl:\d+$/.test(n))
        .slice(0, 16)) {
        const raw = Number(await readFile(`${root}/${name}/energy_uj`, "utf8"));
        if (Number.isFinite(raw)) values.set(name, raw);
      }
      const old = this.energy;
      this.energy = { at, values };
      let watts: number | null = null;
      if (old && values.size && old.values.size === values.size && at > old.at) {
        const deltas = [...values].map(([k, v]) =>
          old.values.has(k) && v >= (old.values.get(k) ?? Infinity)
            ? v - (old.values.get(k) ?? 0)
            : NaN,
        );
        if (deltas.every(Number.isFinite))
          watts = deltas.reduce((a, b) => a + b, 0) / (at - old.at) / 1000;
      }
      return {
        watts,
        source: "CPU package",
        detail: values.size
          ? "RAPL CPU 패키지 전력 · PC 전체 소비전력과 다릅니다."
          : "읽을 수 있는 RAPL 전력 센서가 없습니다.",
      };
    }
    return {
      watts: null,
      source: "unavailable",
      detail: "Windows는 표준 OS 조회로 실소비전력(W)을 제공하지 않습니다.",
    };
  }
  private async collect() {
    const data = emptyMetrics(process.platform),
      cores = cpus();
    data.hostname = hostname();
    data.arch = arch();
    data.os = `${process.platform} ${release()}`;
    data.uptime = uptime();
    data.agentVersion = "0.10.1";
    data.memory.total = totalmem();
    const perCore = cores.map(({ times }) => ({
      total: Object.values(times).reduce((a, b) => a + b, 0),
      idle: times.idle,
    }));
    data.cpu = {
      model: cores[0]?.model ?? "",
      cores: cores.length,
      percent: null,
      perCore,
      ticks: perCore.reduce((a, b) => ({ total: a.total + b.total, idle: a.idle + b.idle }), {
        total: 0,
        idle: 0,
      }),
    };
    const [mem, disks, io, net, interfaces, battery, power] = await Promise.all([
      this.probe("memory", () => si.mem()),
      this.probe("disks", () => si.fsSize()),
      this.probe("io", () => si.fsStats()),
      this.probe("network", () => si.networkStats("*")),
      this.probe("interfaces", () => si.networkInterfaces()),
      this.probe("battery", () => si.battery()),
      this.probe("power", () => this.power()),
    ]);
    if (mem)
      data.memory = {
        total: metric(mem.total),
        available: metric(mem.available),
        used: metric(mem.active),
        swapTotal: metric(mem.swaptotal),
        swapUsed: metric(mem.swapused),
      };
    else data.warnings.push("메모리 정보를 수집하지 못했습니다.");
    if (disks)
      data.disks = disks
        .filter((d) => d.size > 0)
        .slice(0, 128)
        .map((d) => ({
          device: d.fs.slice(0, 512),
          mount: d.mount.slice(0, 512),
          type: d.type.slice(0, 512),
          total: d.size,
          used: Math.max(0, d.used),
          available: Math.max(0, d.available),
        }));
    else data.warnings.push("디스크 용량 정보를 수집하지 못했습니다.");
    if (io)
      data.diskIO = {
        readBytes: metric(io.rx),
        writeBytes: metric(io.wx),
        readBps: null,
        writeBps: null,
      };
    else data.warnings.push("이 OS에서 디스크 전송량을 수집하지 못했습니다.");
    if (net)
      data.network = net
        .filter((n) => !["lo", "lo0", "Loopback Pseudo-Interface 1"].includes(n.iface))
        .slice(0, 128)
        .map((n) => {
          const detail = Array.isArray(interfaces)
            ? interfaces.find((i) => i.iface === n.iface)
            : undefined;
          return {
            name: n.iface.slice(0, 512),
            state: n.operstate,
            speedMbps: metric(detail?.speed),
            rxBytes: metric(n.rx_bytes),
            txBytes: metric(n.tx_bytes),
            rxBps: null,
            txBps: null,
          };
        });
    else data.warnings.push("네트워크 전송량을 수집하지 못했습니다.");
    if (battery)
      Object.assign(data.energy, {
        hasBattery: battery.hasBattery,
        percent: battery.hasBattery ? metric(battery.percent) : null,
        charging: battery.hasBattery ? battery.isCharging : null,
        acConnected: battery.acConnected,
      });
    if (power) Object.assign(data.energy, power);
    else data.energy.detail = "전력 센서가 없거나 현재 계정에 센서 읽기 권한이 없습니다.";
    data.collectedAt = new Date().toISOString();
    return data;
  }
}
