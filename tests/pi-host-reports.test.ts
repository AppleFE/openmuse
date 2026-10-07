import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  conversationHostReports,
  syncPiHostReports,
} from "../apps/server/src/engine/pi-host-reports.ts";

test("host context excludes the current report, ordinary users and tool output", () => {
  assert.deepEqual(
    conversationHostReports(
      [
        { id: "user-1", role: "user", content: "human" },
        { id: "host-report-1", role: "user", content: "earlier" },
        { id: "host-report-2", role: "user", content: "current" },
        { id: "host-report-fake", role: "assistant", content: "not a report" },
      ],
      "host-report-2",
    ),
    [{ id: "host-report-1", content: "earlier" }],
  );
});

test("reports already answered by Pi are not duplicated and no-reply corrections retain order", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "already answered", timestamp: Date.now() });
  const reports = [
    { id: "old", content: "already answered" },
    { id: "report-1", content: "first diagnosis" },
    { id: "report-2", content: "corrected diagnosis" },
  ];
  syncPiHostReports(manager, reports);
  syncPiHostReports(manager, reports);
  const imported = manager.getEntries().filter((entry) => entry.type === "custom_message");
  assert.equal(imported.length, 2);
  assert.match(String(imported[0].content), /first diagnosis/);
  assert.match(String(imported[1].content), /corrected diagnosis/);
});

test("legacy report backlog is bounded with newest corrections retained", () => {
  const manager = SessionManager.inMemory();
  const reports = Array.from({ length: 20 }, (_, n) => ({
    id: String(n),
    content: String(n) + "x".repeat(32_000),
  }));
  syncPiHostReports(manager, reports);
  const imported = manager.getEntries().filter((entry) => entry.type === "custom_message");
  assert.equal(imported.length, 2);
  assert.match(String(imported[0].content), /Report truncated/);
  assert.match(String(imported[1].content), /19x/);
  syncPiHostReports(manager, reports);
  assert.equal(manager.getEntries().filter((entry) => entry.type === "custom_message").length, 2);
});
