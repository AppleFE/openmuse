import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseAvailableModel,
  compactSettings,
  executionDependencies,
} from "../src/settings-core.ts";

const models = [
  { id: "fast", enabled: true },
  { id: "disabled", enabled: false },
  { id: "deep", enabled: true },
];

test("conversation selection keeps an available local choice", () => {
  assert.equal(chooseAvailableModel("deep", "fast", models), "deep");
});

test("conversation selection falls back through server default and availability", () => {
  assert.equal(chooseAvailableModel("disabled", "fast", models), "fast");
  assert.equal(chooseAvailableModel(undefined, "missing", models), "fast");
  assert.equal(chooseAvailableModel(undefined, null, []), undefined);
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
