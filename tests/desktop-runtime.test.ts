import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { listenDesktop } from "../apps/server/src/desktop-listener.ts";
import { GoogleAuth } from "../apps/server/src/google-auth.ts";

test("desktop origin survives restart and refuses to silently change an occupied port", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-desktop-origin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = createServer();
  const origin = await listenDesktop(first, directory);
  const close = (server: ReturnType<typeof createServer>) =>
    new Promise<void>((r) => server.close(() => r()));
  await close(first);
  const next = createServer();
  assert.equal(await listenDesktop(next, directory), origin);
  t.after(() => close(next));
  const conflict = createServer();
  await assert.rejects(listenDesktop(conflict, directory), { code: "EADDRINUSE" });
  assert.equal(
    JSON.parse(await readFile(join(directory, "endpoint.json"), "utf8")).port,
    Number(new URL(origin).port),
  );
});

test("desktop Google import is encrypted, durable, owner scoped and used for PKCE/exchange/refresh", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config: Config = {
    desktop: true,
    mode: "live",
    host: "127.0.0.1",
    port: 43210,
    publicUrl: "http://127.0.0.1:43210",
    dataDir: "unused",
    agentBackend: "model",
    allowedOrigins: [],
    googleRedirectUri: "http://127.0.0.1:43210/api/google/callback",
    encryptionKey: randomBytes(32).toString("base64"),
  };
  const client = {
    installed: {
      client_id: "fixture.apps.googleusercontent.com",
      client_secret: "fixture-client-secret",
    },
  };
  const auth = new GoogleAuth(db, config);
  await assert.rejects(auth.connect("owner", false), /OAuth JSON/);
  await assert.rejects(auth.importClient("owner", { web: client.installed }), /데스크톱/);
  await assert.rejects(
    auth.importClient("owner", {
      installed: { ...client.installed, token_uri: "https://attacker.invalid" },
    }),
    /데스크톱/,
  );
  await auth.importClient("owner", client);
  const stored = await db.get("owner", "credentials", "google-client");
  assert.ok(!JSON.stringify(stored).includes(client.installed.client_secret));
  assert.deepEqual(await new GoogleAuth(db, config).clientStatus("owner"), { configured: true });
  assert.deepEqual(await auth.clientStatus("other"), { configured: false });
  const url = new URL((await auth.connect("owner", false)).url);
  assert.equal(url.searchParams.get("client_id"), client.installed.client_id);
  assert.equal(url.searchParams.get("redirect_uri"), config.googleRedirectUri);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const exchanges: URLSearchParams[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/token")) {
      const body = new URLSearchParams(String(init?.body));
      exchanges.push(body);
      assert.equal(body.get("client_id"), client.installed.client_id);
      assert.equal(body.get("client_secret"), client.installed.client_secret);
      return Response.json({
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        expires_in: 1,
      });
    }
    return Response.json({ emailAddress: "fixture@example.com" });
  });
  await auth.callback(url.searchParams.get("state") as string, "fixture-code");
  assert.equal(await new GoogleAuth(db, config).accessToken("owner"), "fixture-access");
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[1].get("grant_type"), "refresh_token");
  await assert.rejects(auth.importClient("owner", client), /해제/);
  await assert.rejects(
    new GoogleAuth(db, { ...config, desktop: false }).importClient("owner", client),
    /설치 앱/,
  );
});

test("replacing desktop OAuth settings invalidates pending authorization", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config: Config = {
    desktop: true,
    mode: "live",
    host: "127.0.0.1",
    port: 43210,
    publicUrl: "http://127.0.0.1:43210",
    dataDir: "unused",
    agentBackend: "model",
    allowedOrigins: [],
    googleRedirectUri: "http://127.0.0.1:43210/api/google/callback",
    encryptionKey: randomBytes(32).toString("base64"),
  };
  const auth = new GoogleAuth(db, config);
  await auth.importClient("owner", {
    installed: { client_id: "a.apps.googleusercontent.com", client_secret: "a" },
  });
  const old = new URL((await auth.connect("owner", false)).url).searchParams.get("state") as string;
  await auth.importClient("owner", {
    installed: { client_id: "b.apps.googleusercontent.com", client_secret: "b" },
  });
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Should not exchange an old client code");
  });
  await assert.rejects(auth.callback(old, "old-code"), /changed|disconnected/);
});
