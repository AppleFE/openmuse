import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeThreadPages,
  messageSpeakerLabel,
  parseStoredThreadSelections,
  storeThreadSelection,
} from "../src/thread-state.ts";

test("thread selection storage ignores malformed and secret-like non-string values", () => {
  assert.deepEqual(parseStoredThreadSelections("not-json"), {});
  assert.deepEqual(
    parseStoredThreadSelections(
      JSON.stringify({
        "http://localhost:8787": "thread-1",
        empty: "",
        token: { access: "must-not-be-read" },
      }),
    ),
    { "http://localhost:8787": "thread-1" },
  );
});

test("role-labelled assistant history keeps meaningful speaker names", () => {
  assert.equal(messageSpeakerLabel({ role: "assistant", speakerRole: "planner" }), "planner");
  assert.equal(messageSpeakerLabel({ role: "assistant", name: "Researcher" }), "Researcher");
  assert.equal(messageSpeakerLabel({ role: "assistant", name: "assistant" }), "");
  assert.equal(messageSpeakerLabel({ role: "user", name: "Owner" }), "");
});

test("thread selections stay scoped to the public runtime URL across reloads", () => {
  const first = storeThreadSelection({}, "http://localhost:8787", "thread-1");
  const second = storeThreadSelection(first, "https://muse.example", "thread-2");
  assert.deepEqual(second, {
    "http://localhost:8787": "thread-1",
    "https://muse.example": "thread-2",
  });
});

test("thread pagination replaces duplicate metadata without losing page order", () => {
  assert.deepEqual(
    mergeThreadPages(
      [
        { id: "a", name: "old" },
        { id: "b", name: "second" },
      ],
      [
        { id: "b", name: "updated" },
        { id: "c", name: "third" },
      ],
    ),
    [
      { id: "a", name: "old" },
      { id: "b", name: "updated" },
      { id: "c", name: "third" },
    ],
  );
});
