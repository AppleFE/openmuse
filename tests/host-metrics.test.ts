import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHostAgent } from "../apps/host-agent/src/server.ts";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import type { ConnectorService } from "../apps/server/src/connector-service.ts";
import { createStore } from "../apps/server/src/db.ts";
import { deriveMetrics, HostMetricsService } from "../apps/server/src/host-metrics.ts";
import {
  emptyMetrics,
  type HostMetrics,
  hostMetricsSchema,
} from "../packages/domain/src/host-metrics.ts";
import { parseRemoteOperation } from "../packages/domain/src/remote-host.ts";
import { remoteHostAdapter } from "../packages/integrations/src/connectors/remote-host.ts";
import {
  hostMetricsScript,
  parseSshMetrics,
} from "../packages/integrations/src/host-metrics-ssh.ts";

function sample(at: number, tick: number): HostMetrics {
  const data = emptyMetrics("linux");
  return {
    ...data,
    hostname: "fixture-host",
    collectedAt: new Date(at).toISOString(),
    uptime: tick / 10,
    cpu: { model: "fixture-cpu", cores: 8, percent: null, ticks: { total: tick, idle: tick / 4 } },
    memory: { total: 1000, available: 400, used: 600, swapTotal: 100, swapUsed: 0 },
    diskIO: { readBytes: tick * 2, writeBytes: tick, readBps: null, writeBps: null },
    network: [
      {
        name: "eth0",
        state: "up",
        speedMbps: 1000,
        rxBytes: tick * 3,
        txBytes: tick * 2,
        rxBps: null,
        txBps: null,
      },
    ],
  };
}
test("rates use actual elapsed time, counter resets and reboot gaps never fabricate traffic", () => {
  const now = Date.now(),
    first = sample(now, 1000),
    next = sample(now + 5000, 2000);
  assert.equal(deriveMetrics(first).cpu.percent, null);
  const derived = deriveMetrics(next, first);
  assert.equal(derived.cpu.percent, 75);
  assert.equal(derived.diskIO.readBps, 400);
  assert.equal(derived.network[0].rxBps, 600);
  assert.equal(next.cpu.percent, null, "does not mutate source sample");
  assert.equal(deriveMetrics(sample(now + 5000, 100), first).diskIO.readBps, null);
  assert.equal(deriveMetrics(sample(now + 60000, 2000), first).cpu.percent, null);
  assert.equal(deriveMetrics({ ...next, hostname: "replacement" }, first).network[0].rxBps, null);
  const reset = structuredClone(next);
  reset.network[0].rxBytes = 10;
  assert.equal(deriveMetrics(reset, first).network[0].rxBps, null);
});

test("SSH parsers read Linux and macOS counters, spaces in mounts, unavailable energy and CIM JSON", () => {
  const linux = parseSshMetrics(
    "linux",
    "HOST\tfixture\taarch64\nOS\tDebian 12\nUP\t120\nMODEL\tCPU\nCPU\tcpu\t1000\t300\nCPU\tcpu0\t1000\t300\nMEM\tMemTotal\t100000\nMEM\tMemAvailable\t25000\nDISK\t/dev/sda\t1000000\t250000\t750000\t/media/My Disk\nIO\t2000\t3000\nNET\teth0\t4000\t5000\nBAT\t75\tDischarging\nEND\n",
  );
  assert.equal(linux.cpu.cores, 1);
  assert.equal(linux.memory.used, 75000);
  assert.equal(linux.disks[0].mount, "/media/My Disk");
  assert.equal(linux.network[0].txBytes, 5000);
  assert.equal(linux.energy.percent, 75);
  assert.equal(linux.energy.watts, null);
  const mac = parseSshMetrics(
    "macos",
    "HOST\tMac\tarm64\nCORES\t10\nLOAD\t32.5\nMODEL\tApple M4\nMEM\tMemTotal\t16000000\nMEM\tMemAvailable\t8000000\nEND\n",
  );
  assert.equal(mac.cpu.percent, 32.5);
  assert.equal(mac.platform, "darwin");
  const windows = sample(Date.now(), 1000);
  windows.platform = "win32";
  windows.cpu.percent = 10;
  assert.equal(parseSshMetrics("windows", JSON.stringify(windows)).cpu.percent, 10);
  assert.throws(() => parseSshMetrics("linux", "HOST\tx"));
  assert.throws(() => parseRemoteOperation("host_metrics", { command: "touch /tmp/anything" }));
  for (const platform of ["linux", "macos", "windows"] as const)
    assert.ok(!/\bsudo\b|Invoke-Expression|curl |wget /.test(hostMetricsScript(platform)));
});

test("server deduplicates collectors, bounds history, retains failure gaps and rejects other owners", async () => {
  const db = await createStore();
  let at = Date.now(),
    calls = 0,
    unavailable = false,
    version = "v1";
  const connector = {
    id: "host",
    provider: "remote_host",
    updatedAt: version,
    config: { mode: "ssh", host: "fixture" },
  };
  const service = {
    get: async (owner: string) => {
      if (owner !== "owner") throw Object.assign(Error("not found"), { status: 404 });
      return { ...connector, updatedAt: version };
    },
    run: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 2));
      if (unavailable) throw Error("connection refused");
      return sample(Date.now(), calls * 1000);
    },
  } as unknown as ConnectorService;
  const metrics = new HostMetricsService(db, service, () => at);
  try {
    const [a, b] = await Promise.all([
      metrics.read("owner", "host"),
      metrics.read("owner", "host"),
    ]);
    assert.equal(calls, 1);
    assert.equal(a.checkedAt, b.checkedAt);
    await metrics.read("owner", "host");
    assert.equal(calls, 1);
    await assert.rejects(metrics.read("other", "host"), { status: 404 });
    at += 5000;
    unavailable = true;
    const offline = await metrics.read("owner", "host");
    assert.equal(offline.status, "offline");
    assert.equal(offline.sample?.hostname, "fixture-host");
    assert.equal(offline.history.at(-1)?.cpu, null);
    at += 5000;
    version = "v2";
    unavailable = false;
    const changed = await metrics.read("owner", "host");
    assert.equal(changed.history.length, 1);
    // Seed a large old record to verify age and count pruning, without hundreds of OS calls.
    const stored = await db.get<Record<string, unknown>>("owner", "host-metrics", "host");
    assert.ok(stored);
    stored.history = Array.from({ length: 500 }, (_, i) => ({
      ...changed.history[0],
      at: new Date(at - i * 5000).toISOString(),
    })).reverse();
    await db.put("owner", "host-metrics", { ...stored, id: "host" });
    at += 5000;
    const pruned = await new HostMetricsService(db, service, () => at).read("owner", "host");
    assert.ok(pruned.history.length <= 360);
    assert.ok(pruned.history.every((p) => Date.parse(p.at) >= at - 1800000));
  } finally {
    await db.close();
  }
});

test("Host Agent metrics endpoint authenticates, reports native data and connector API is read-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-metrics-")),
    token = "host-metrics-test-token-0123456789abcd";
  const agent = await createHostAgent({ dataDir: directory, token });
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    googleRedirectUri: "http://localhost/callback",
    allowedOrigins: [],
  };
  const server = await createApp(db, config);
  try {
    agent.server.listen(0, "127.0.0.1");
    await once(agent.server, "listening");
    const addr = agent.server.address();
    assert.ok(addr && typeof addr !== "string");
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    assert.equal((await fetch(baseUrl + "/host/metrics")).status, 401);
    const adapter = remoteHostAdapter();
    const data = hostMetricsSchema.parse(
      await adapter.run({ config: { baseUrl }, secrets: { token } }, "host_metrics", {}),
    );
    assert.equal(data.platform, process.platform);
    assert.ok(data.cpu.cores > 0);
    assert.ok(data.memory.total && data.memory.total > 0);
    assert.equal(data.agentVersion, "0.10.0");
    assert.ok(!JSON.stringify(data).includes(token));
    const session = await (
      await server.app.request("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).json();
    const headers = {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
    };
    assert.equal((await server.app.request("/api/hosts")).status, 401);
    const response = await server.app.request("/api/connectors", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "metrics",
        provider: "remote_host",
        config: { baseUrl },
        secrets: { token },
      }),
    });
    assert.equal(response.status, 201);
    const host = await response.json();
    const reading = await server.app.request(`/api/hosts/${host.id}/metrics`, { headers });
    assert.equal(reading.status, 200);
    const body = await reading.json();
    assert.equal(body.status, "online");
    assert.ok(!JSON.stringify(body).includes(token));
    assert.equal((await server.app.request("/api/hosts/missing/metrics", { headers })).status, 404);
    assert.equal(
      (await server.app.request(`/api/connectors/${host.id}`, { headers, method: "DELETE" }))
        .status,
      200,
    );
    assert.equal(
      (await server.app.request(`/api/hosts/${host.id}/metrics`, { headers })).status,
      404,
    );
  } finally {
    await agent.close();
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
