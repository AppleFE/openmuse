import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentConfigured } from "../apps/server/src/agent.ts";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { ModelRegistry, parseModelCatalog } from "../apps/server/src/engine/models.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-model-discovery-"));
  let body: unknown = {
    data: [{ id: "existing" }, { id: "vendor/new", capabilities: { supports_vision: true } }],
  };
  let status = 200;
  const requests: { url?: string; auth?: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(status, {
      "Content-Type": "application/json",
      ...(status === 302 ? { Location: "/leaked" } : {}),
    });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "model",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    openCodexBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`,
    openCodexApiKey: "private-test-catalog-key",
    models: parseModelCatalog(
      JSON.stringify([
        {
          id: "saved-id",
          label: "My selected model",
          model: "opencodex/existing",
          capabilities: ["chat", "tools", "coding"],
        },
        { id: "disabled", label: "Disabled", model: "opencodex/disabled", enabled: false },
        { id: "local", label: "Local", model: "ollama/local", capabilities: ["chat"] },
      ]),
    ),
    ollamaBaseUrl: "http://127.0.0.1:11434",
  };
  let now = Date.now();
  return {
    db,
    config,
    requests,
    clock: () => now,
    advance: () => {
      now += 60_001;
    },
    response: (value: unknown, code = 200) => {
      body = value;
      status = code;
    },
    close: async () => {
      await db.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("discovery merges more than 100 models, preserves configured IDs/defaults, and tracks removed models", async () => {
  const f = await fixture();
  const registry = new ModelRegistry(f.db, f.config, f.clock);
  try {
    const data = [
      { id: "existing" },
      { id: "disabled" },
      ...Array.from({ length: 130 }, (_, i) => ({ id: `vendor/model-${i}` })),
    ];
    f.response({ data });
    await registry.select("owner", "saved-id");
    const selected = await registry.selection("owner");
    assert.equal(registry.list().length, 133);
    assert.equal(registry.require("saved-id").label, "My selected model");
    assert.equal(registry.list().find((m) => m.id === "disabled")?.available, false);
    assert.ok(registry.list().some((m) => m.id === "local" && m.available));
    const newModel = registry.list().find((m) => m.model === "opencodex/vendor/model-1");
    assert.ok(newModel);
    assert.match(newModel.id, /^[a-zA-Z0-9._-]{1,120}$/);
    assert.equal(f.requests.length, 1);
    f.response({
      data: [
        ...data.reverse(),
        { id: "a/b" },
        { id: "a-b" },
        { id: "vision", capabilities: { supports_tool_use: false, supports_vision: true } },
      ],
    });
    f.advance();
    await registry.discovery.refresh();
    assert.deepEqual(await registry.selection("owner"), selected);
    assert.equal(registry.list().find((m) => m.model === newModel.model)?.id, newModel.id);
    assert.notEqual(
      registry.list().find((m) => m.label === "a/b")?.id,
      registry.list().find((m) => m.label === "a-b")?.id,
    );
    assert.deepEqual(registry.list().find((m) => m.label === "vision")?.capabilities, [
      "chat",
      "vision",
    ]);
    f.response({ data: [{ id: "vendor/model-1" }] });
    await registry.discovery.refresh(true);
    assert.equal(
      registry.list().find((m) => m.id === "saved-id")?.unavailableReason,
      "provider_removed",
    );
    assert.throws(() => registry.require("saved-id"), /OpenCodex/);
    assert.equal(
      registry.list().some((m) => m.label === "a/b"),
      false,
    );
    assert.equal(registry.fromSnapshot(newModel).model, newModel.model);
    assert.notEqual((await registry.selection("owner")).modelId, "saved-id");
    // A temporary disappearance must not rewrite the user's saved preference.
    f.response({ data: [{ id: "existing" }] });
    await registry.discovery.refresh(true);
    assert.deepEqual(await registry.selection("owner"), selected);
  } finally {
    await registry.discovery.stop();
    await f.close();
  }
});

test("discovery deduplicates concurrent fetches and refreshes after the 60 second cache expires", async () => {
  const f = await fixture();
  const registry = new ModelRegistry(f.db, f.config, f.clock);
  try {
    await Promise.all(Array.from({ length: 12 }, () => registry.resolve("owner")));
    assert.deepEqual(f.requests, [{ url: "/v1/models", auth: "Bearer private-test-catalog-key" }]);
    await registry.discovery.refresh();
    assert.equal(f.requests.length, 1);
    f.advance();
    await registry.selection("owner");
    assert.equal(f.requests.length, 2);
    assert.equal(registry.discovery.status().state, "ready");
    assert.ok(
      !JSON.stringify([registry.list(), registry.discovery.status()]).includes(
        "private-test-catalog-key",
      ),
    );
  } finally {
    await registry.discovery.stop();
    await f.close();
  }
});

test("background sync still runs on its minute boundary after a manual refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await fixture();
  const registry = new ModelRegistry(f.db, f.config, f.clock);
  try {
    registry.discovery.start();
    await registry.discovery.refresh();
    assert.equal(f.requests.length, 1);
    await registry.discovery.refresh(true);
    assert.equal(f.requests.length, 2);
    f.response({ data: [{ id: "added-in-background" }] });
    t.mock.timers.tick(60_000);
    await registry.discovery.refresh();
    assert.equal(f.requests.length, 3);
    assert.ok(registry.list().some((m) => m.label === "added-in-background"));
  } finally {
    await registry.discovery.stop();
    await f.close();
  }
});

test("provider failures retain durable last-good catalog without leaking errors, while credential changes invalidate it", async () => {
  const f = await fixture();
  const first = new ModelRegistry(f.db, f.config);
  const next = new ModelRegistry(f.db, f.config);
  const rotated = new ModelRegistry(f.db, { ...f.config, openCodexApiKey: "rotated-key" });
  try {
    await first.discovery.refresh();
    const good = first.list();
    f.response({ error: "secret upstream text private-test-catalog-key" }, 503);
    await next.discovery.refresh();
    assert.deepEqual(next.list(), good);
    assert.equal(next.discovery.status().state, "error");
    assert.ok(next.discovery.status().lastSyncedAt);
    assert.ok(!JSON.stringify(next.discovery.status()).includes("secret"));
    await rotated.discovery.refresh();
    assert.equal(
      rotated.list().some((m) => m.label === "vendor/new"),
      false,
    );
    f.response({ data: [{ id: "malformed\nmodel" }] });
    await next.discovery.refresh(true);
    assert.deepEqual(next.list(), good);
    assert.equal(next.discovery.status().state, "error");
    f.response({ data: [] });
    await next.discovery.refresh(true);
    assert.equal(next.discovery.status().state, "ready");
    assert.equal(
      next.list().some((m) => m.label === "vendor/new"),
      false,
    );
    assert.equal(next.list().find((m) => m.id === "saved-id")?.available, false);
  } finally {
    await Promise.all([first.discovery.stop(), next.discovery.stop(), rotated.discovery.stop()]);
    await f.close();
  }
});

test("disabled discovery makes no request and enabled discovery refuses redirects and oversized catalogs", async () => {
  const f = await fixture();
  const disabled = new ModelRegistry(f.db, { ...f.config, openCodexModelDiscovery: false });
  const registry = new ModelRegistry(f.db, f.config);
  try {
    await disabled.resolve("owner");
    assert.equal(f.requests.length, 0);
    assert.equal(disabled.discovery.status().state, "disabled");
    f.response({}, 302);
    await registry.discovery.refresh();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]?.url, "/v1/models");
    assert.equal(registry.discovery.status().state, "error");
    f.response({ padding: "x".repeat(2 * 1024 * 1024), data: [] });
    await registry.discovery.refresh(true);
    assert.equal(registry.discovery.status().state, "error");
    assert.equal(registry.discovery.status().lastSyncedAt, undefined);
  } finally {
    await disabled.discovery.stop();
    await registry.discovery.stop();
    await f.close();
  }
});

test("authenticated API discovers models without an env catalog and supports manual refresh plus default/team selection", async () => {
  const f = await fixture();
  const config = { ...f.config, models: [], authMode: "none" as const };
  assert.equal(agentConfigured(config), true);
  const server = await createApp(f.db, config);
  try {
    assert.equal(
      (await server.app.request("/api/agent/models/refresh", { method: "POST" })).status,
      401,
    );
    const login = await server.app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const { token } = await login.json();
    const api = (path: string, body?: unknown) =>
      server.app.request(`/api/agent${path}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    const models = await (await api("/models")).json();
    assert.equal(models.length, 2);
    const id = models.find((m: { label: string }) => m.label === "vendor/new").id;
    assert.equal((await api("/model-settings", { modelId: id })).status, 200);
    const team = await api("/teams", {
      name: "Discovered model team",
      execution: "sequential",
      roles: [
        {
          id: "coder",
          label: "Coder",
          kind: "coder",
          modelId: id,
          systemPrompt: "Code",
          dependsOn: [],
        },
      ],
    });
    assert.equal(team.status, 201);
    f.response({ data: [{ id: "existing" }, { id: "vendor/new" }, { id: "fresh" }] });
    const updated = await (await api("/models/refresh", {})).json();
    assert.equal(updated.models.length, 3);
    assert.equal(updated.modelCatalog.state, "ready");
    const snapshot = await (await api("")).json();
    assert.equal(snapshot.modelSelection.modelId, id);
    assert.equal(snapshot.modelCatalog.modelCount, 3);
    assert.equal(JSON.stringify(snapshot).includes("private-test-catalog-key"), false);
  } finally {
    server.hostEvents.close();
    await server.agent.stop();
    await f.close();
  }
});
