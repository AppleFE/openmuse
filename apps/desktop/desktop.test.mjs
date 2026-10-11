import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateKeyPair, jwtVerify, SignJWT } from "jose";
import { modelCatalog, planRequest, startGateway } from "./gateway.mjs";
import { ChatGPTAccounts } from "./oauth.mjs";

const { publicKey, privateKey } = await generateKeyPair("RS256");
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-desktop-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = randomBytes(32);
  const encryption = {
    encrypt(text) {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      const content = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), content]);
    },
    decrypt(bytes) {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    },
  };
  let authUrl,
    exchanges = 0,
    refreshes = 0;
  const token = async () => ({
    access_token: "private-access-token",
    refresh_token: `private-refresh-${refreshes}`,
    id_token: await new SignJWT({
      nonce: authUrl.searchParams.get("nonce"),
      email: "test@example.invalid",
    })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("subject-1")
      .setAudience("oaiapp_test")
      .setIssuer("https://auth.openai.com")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey),
    token_type: "Bearer",
    scope: "openid chatgpt.tokens.use.direct",
    expires_in: 3600,
  });
  const settings = {
    file: join(dir, "accounts.bin"),
    encryption,
    verify: (jwt, _jwks, options) => jwtVerify(jwt, publicKey, options),
    openBrowser: async (raw) => {
      authUrl = new URL(raw);
      const callback = new URL(authUrl.searchParams.get("redirect_uri"));
      assert.equal(callback.hostname, "127.0.0.1");
      callback.search = new URLSearchParams({
        state: "wrong",
        code: "ignored",
        client_id: "oaiapp_test",
      });
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set("state", authUrl.searchParams.get("state"));
      callback.searchParams.set("code", "one-use-code");
      await fetch(callback);
    },
    fetcher: async (url, init) => {
      if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
      exchanges++;
      assert.equal(init.body.get("client_id"), "oaiapp_test");
      assert.equal(init.body.get("resource"), "https://api.openai.com/v1");
      if (init.body.get("grant_type") === "refresh_token") refreshes++;
      else {
        assert.equal(init.body.get("redirect_uri"), authUrl.searchParams.get("redirect_uri"));
        assert.equal(init.body.get("code"), "one-use-code");
        assert.ok(init.body.get("code_verifier"));
      }
      return Response.json(await token());
    },
    ...overrides,
  };
  const accounts = new ChatGPTAccounts(settings);
  await accounts.load();
  return {
    accounts,
    settings,
    token,
    url: () => authUrl,
    exchanges: () => exchanges,
    refreshes: () => refreshes,
  };
}

test("PKCE callback, signed identity, encrypted persistence and returning registration", async (t) => {
  const f = await fixture(t);
  await f.accounts.signIn();
  assert.equal(f.accounts.status().sharing, true);
  assert.equal(f.url().searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(f.url().searchParams.get("agent_name_hint"), "OpenMuse");
  assert.equal(f.url().searchParams.get("code_challenge_method"), "S256");
  const saved = await readFile(f.settings.file);
  assert.equal(saved.includes(Buffer.from("private-access-token")), false);
  assert.equal(JSON.stringify(f.accounts.status()).includes("private-"), false);
  const loaded = new ChatGPTAccounts(f.settings);
  await loaded.load();
  assert.deepEqual(loaded.status(), f.accounts.status());
  const host = loaded.state.hostId;
  await loaded.signIn(loaded.status().activeId);
  assert.equal(f.url().searchParams.get("client_id"), "oaiapp_test");
  assert.equal(f.url().searchParams.has("agent_name_hint"), false);
  assert.equal(f.url().searchParams.get("ext_agent_host_id"), host);
  await loaded.disconnect();
  assert.equal(loaded.status().sharing, false);
  assert.equal(loaded.selected().clientId, "oaiapp_test");
  assert.equal(loaded.selected().tokens, undefined);
});

test("nonce and returning subject mismatch cannot activate credentials", async (t) => {
  const f = await fixture(t);
  const actual = f.accounts.verify;
  f.accounts.verify = async (...args) => {
    const verified = await actual(...args);
    verified.payload.nonce = "different";
    return verified;
  };
  await assert.rejects(f.accounts.signIn(), /검증/);
  assert.equal(f.accounts.status().sharing, false);
  assert.equal(f.accounts.state.accounts[0].clientId, "oaiapp_test");
  f.accounts.verify = actual;
  await f.accounts.signIn(f.accounts.state.accounts[0].id);
  f.accounts.selected().subject = "someone-else";
  await assert.rejects(f.accounts.signIn(f.accounts.status().activeId), /검증/);
});

test("concurrent expiry performs one refresh and durably saves replacement", async (t) => {
  const f = await fixture(t);
  await f.accounts.signIn();
  f.accounts.selected().tokens.expiresAt = Date.now() - 1;
  const results = await Promise.all(Array.from({ length: 8 }, () => f.accounts.credential()));
  assert.ok(results.every((value) => value === "private-access-token"));
  assert.equal(f.refreshes(), 1);
  const loaded = new ChatGPTAccounts(f.settings);
  await loaded.load();
  assert.equal(loaded.selected().tokens.refresh_token, "private-refresh-1");
});

test("failed JWKS refresh persists rotation but cannot issue unverified token", async (t) => {
  const f = await fixture(t);
  await f.accounts.signIn();
  f.accounts.selected().tokens.expiresAt = Date.now() - 1;
  const verify = f.accounts.verify;
  f.accounts.verify = async () => {
    throw new Error("network verification failure");
  };
  await assert.rejects(f.accounts.credential());
  assert.equal(f.accounts.status().sharing, false);
  assert.equal(f.accounts.selected().pendingTokens.refresh_token, "private-refresh-1");
  f.accounts.verify = verify;
  assert.equal(await f.accounts.credential(), "private-access-token");
  assert.equal(f.refreshes(), 1);
});

test("Responses adapter retains images, tool history and namespace while dropping rejected fields", () => {
  const image = { type: "input_image", image_url: "data:image/png;base64,abc" };
  const result = planRequest({
    model: "account-model",
    input: [
      { type: "message", role: "system", content: "instruction" },
      { role: "user", content: [image] },
      { type: "function_call", name: "read_file", call_id: "call-1", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: "done" },
    ],
    tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
    max_output_tokens: 100,
    temperature: 1,
    previous_response_id: "old",
    store: true,
  });
  assert.equal(result.store, false);
  assert.equal(result.stream, true);
  assert.equal(result.input[0].role, "developer");
  assert.deepEqual(result.input[1].content[0], image);
  assert.equal(result.input[2].namespace, "openmuse");
  assert.equal(result.tools[0].type, "namespace");
  for (const field of ["max_output_tokens", "temperature", "previous_response_id"])
    assert.equal(field in result, false);
});

test("gateway requires private credential, filters catalog, preserves streaming tools and usage", async (t) => {
  const f = await fixture(t);
  await f.accounts.signIn();
  const events = [
    {
      type: "response.output_item.added",
      item: { type: "function_call", namespace: "openmuse", name: "read_file", arguments: "{}" },
    },
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } },
  ];
  const stream = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const gateway = await startGateway(f.accounts, "local-key", async (url, init) => {
    assert.equal(init.headers.Authorization, "Bearer private-access-token");
    if (url.endsWith("models"))
      return Response.json({
        models: [
          { slug: "account-model", display_name: "My model", visibility: "list" },
          { slug: "hidden", visibility: "hidden" },
        ],
      });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });
  t.after(() => gateway.close());
  assert.equal((await fetch(`${gateway.url}/models`)).status, 401);
  const headers = { Authorization: "Bearer local-key" };
  assert.equal(
    (
      await fetch(`${gateway.url}/models`, {
        headers: { ...headers, Origin: "https://evil.invalid" },
      })
    ).status,
    401,
  );
  const models = await (await fetch(`${gateway.url}/models`, { headers })).json();
  assert.equal(models.data.length, 1);
  assert.equal(models.data[0].display_name, "My model");
  const response = await fetch(`${gateway.url}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "account-model", input: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(await response.text(), stream);
  await f.accounts.disconnect();
  assert.deepEqual(await (await fetch(`${gateway.url}/models`, { headers })).json(), { data: [] });
});

test("catalog rejects non-account catalog formats", () => {
  assert.throws(() => modelCatalog({ data: [{ id: "old-model" }] }));
});

test("identity-only grant blocks inference and explicit consent reuses the registration", async (t) => {
  const f = await fixture(t);
  const exchange = f.accounts.exchange.bind(f.accounts);
  f.accounts.exchange = async (...args) => ({ ...(await exchange(...args)), scope: "openid" });
  await f.accounts.signIn();
  assert.equal(f.accounts.status().sharing, false);
  assert.equal(f.accounts.status().accounts[0].connected, false);
  await assert.rejects(f.accounts.credential(), /허용/);
  f.accounts.exchange = exchange;
  await f.accounts.signIn(f.accounts.status().activeId, true);
  assert.equal(f.url().searchParams.get("client_id"), "oaiapp_test");
  assert.equal(f.url().searchParams.get("prompt"), "consent");
  assert.equal(f.accounts.status().sharing, true);
});

test("confirmed invalid refresh clears tokens but retains account registration", async (t) => {
  const f = await fixture(t);
  await f.accounts.signIn();
  f.accounts.selected().tokens.expiresAt = Date.now() - 1;
  f.accounts.fetcher = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
  await assert.rejects(f.accounts.credential(), /invalid_grant/);
  assert.equal(f.accounts.status().sharing, false);
  assert.equal(f.accounts.selected().clientId, "oaiapp_test");
  assert.equal(f.accounts.selected().tokens, undefined);
});

test("account switch cancels an in-flight response before the next account can use it", async (t) => {
  const f = await fixture(t);
  await f.accounts.signIn();
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const request = f.accounts.authorized(
    (_token, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        started();
      }),
  );
  const rejected = assert.rejects(request, /cancelled/);
  await ready;
  await f.accounts.select(f.accounts.status().activeId);
  await rejected;
});
