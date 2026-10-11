import assert from "node:assert/strict";
import test from "node:test";
import { validatePublicWebSocket } from "../src/network.ts";

test("public secure WebSockets use the HTTPS proxy policy and preserve authority", async () => {
  const seen: string[] = [];
  const target = await validatePublicWebSocket("wss://gateway.example.test/?v=2", async (host) => {
    seen.push(host);
    return [{ address: "93.184.215.14", family: 4 }];
  });
  assert.deepEqual(seen, ["gateway.example.test"]);
  assert.equal(target.url.href, "https://gateway.example.test/?v=2");
  assert.equal(target.address, "93.184.215.14");
});

test("WebSocket routing refuses insecure, private, credentialed and nonstandard-port targets", async () => {
  for (const url of [
    "ws://public.example.test",
    "https://public.example.test",
    "wss://127.0.0.1",
    "wss://[::1]",
    "wss://169.254.169.254",
    "wss://100.80.94.16",
    "wss://192.168.0.1",
    "wss://localhost",
    "wss://user:password@public.example.test",
    "wss://public.example.test:8790",
    "wss://public.example.test:80",
  ])
    await assert.rejects(
      async () =>
        validatePublicWebSocket(url, async () => [{ address: "93.184.215.14", family: 4 }]),
      { code: "BLOCKED_URL" },
    );
  await assert.rejects(
    validatePublicWebSocket("wss://gateway.example.test", async () => [
      { address: "93.184.215.14", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]),
    { code: "BLOCKED_URL" },
  );
});
