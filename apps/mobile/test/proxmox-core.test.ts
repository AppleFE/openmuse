import assert from "node:assert/strict";
import test from "node:test";
import { parseProxmoxForm, proxmoxToolValue } from "../src/proxmox-core.ts";

test("Proxmox inline review reads direct and persisted Pi tool envelopes", () => {
  const action = {
    id: "review",
    kind: "connector.write",
    title: "VM start",
    status: "awaiting_review",
  };
  assert.deepEqual(proxmoxToolValue(action), action);
  assert.deepEqual(proxmoxToolValue(JSON.stringify(action)), action);
  assert.deepEqual(
    proxmoxToolValue(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(action) }] })),
    action,
  );
  assert.deepEqual(
    proxmoxToolValue({
      content: [{ type: "text", text: JSON.stringify({ error: "Permission denied" }) }],
    }),
    { error: "Permission denied" },
  );
  assert.equal(proxmoxToolValue('{"content":'), undefined);
  assert.equal(proxmoxToolValue({ content: [{ type: "image" }] }), undefined);
});

test("Proxmox forms preserve explicit false and zero, parse settings and omit empty optional fields", () => {
  const fields = [
    { name: "onboot", type: "boolean" as const, description: "" },
    { name: "start", type: "number" as const, description: "" },
    { name: "settings", type: "json" as const, description: "", required: true },
    { name: "storage", type: "string" as const, description: "" },
  ];
  assert.deepEqual(
    parseProxmoxForm(fields, {
      onboot: false,
      start: "0",
      settings: '{"cores":4,"memory":4096}',
      storage: "",
    }),
    { onboot: false, start: 0, settings: { cores: 4, memory: 4096 } },
  );
  assert.throws(() => parseProxmoxForm(fields, { start: "not-a-number", settings: "{}" }), /숫자/);
  assert.throws(() => parseProxmoxForm(fields, { settings: "bad-json" }), /JSON/);
  assert.throws(() => parseProxmoxForm(fields, {}), /입력/);
});
