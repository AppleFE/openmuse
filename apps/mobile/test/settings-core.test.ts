import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRuntimeInteger,
  runtimeLimits,
  runtimeReadiness,
} from "../src/runtime-settings-core.ts";
import {
  chooseAvailableModel,
  compactSettings,
  executionDependencies,
  modelAvailabilityLabel,
} from "../src/settings-core.ts";

const models = [
  { id: "fast", enabled: true, available: true },
  { id: "disabled", enabled: false, available: false, unavailableReason: "disabled" as const },
  {
    id: "missing-key",
    enabled: true,
    available: false,
    unavailableReason: "missing_credentials" as const,
  },
  { id: "deep", enabled: true, available: true },
];

test("conversation selection keeps an available local choice", () => {
  assert.equal(chooseAvailableModel("deep", "fast", models), "deep");
});

test("conversation selection falls back through server default and availability", () => {
  assert.equal(chooseAvailableModel("disabled", "fast", models), "fast");
  assert.equal(chooseAvailableModel("missing-key", "missing-key", models), "fast");
  assert.equal(chooseAvailableModel(undefined, "missing", models), "fast");
  assert.equal(chooseAvailableModel(undefined, null, []), undefined);
});

test("model availability describes disabled and unconfigured server profiles", () => {
  assert.equal(modelAvailabilityLabel(models[0]), "Available");
  assert.equal(modelAvailabilityLabel(models[1]), "Disabled");
  assert.equal(modelAvailabilityLabel(models[2]), "Server key required");
});

test("connector payload compaction preserves booleans and removes blank fields", () => {
  assert.deepEqual(compactSettings({ baseUrl: "", verifyTls: false, tailnet: "example" }), {
    verifyTls: false,
    tailnet: "example",
  });
});

test("team execution derives a dependency chain only for sequential mode", () => {
  const ids = ["planner", "coder", "reviewer"];
  assert.deepEqual(executionDependencies(ids, "sequential"), [[], ["planner"], ["coder"]]);
  assert.deepEqual(executionDependencies(ids, "parallel"), [[], [], []]);
});

test("runtime numeric controls enforce the shared server bounds", () => {
  assert.equal(parseRuntimeInteger("8", "Pi iterations", runtimeLimits.piMaxIterations), 8);
  assert.throws(
    () => parseRuntimeInteger("9", "Pi iterations", runtimeLimits.piMaxIterations),
    /1 to 8/,
  );
  assert.throws(
    () => parseRuntimeInteger("1.5", "Pi iterations", runtimeLimits.piMaxIterations),
    /whole number/,
  );
});

test("runtime readiness distinguishes disabled, configured, and missing credentials", () => {
  const settings = {
    id: "runtime" as const,
    jev: {
      enabled: true,
      configured: false,
      model: "jev-latest",
      failMode: "closed" as const,
      timeoutMs: 10000,
    },
    pi: { enabled: true, maxIterations: 4, timeoutMs: 120000 },
    updatedAt: "2026-09-29T00:00:00.000Z",
  };
  assert.deepEqual(runtimeReadiness(settings), { jev: "API key required", pi: "Enabled" });
  assert.deepEqual(runtimeReadiness({ ...settings, jev: { ...settings.jev, enabled: false } }), {
    jev: "Off",
    pi: "Enabled",
  });
});
