// Implements the documented public-client SIWC protocol. No DevKit code is bundled.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const sharingScope = "chatgpt.tokens.use.direct";
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
const random = () => randomBytes(32).toString("base64url");

export class ChatGPTAccounts {
  constructor({ file, encryption, openBrowser, fetcher = fetch, verify = jwtVerify }) {
    Object.assign(this, { file, encryption, openBrowser, fetcher, verify });
    this.state = { version: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: [] };
    this.requests = new Set();
    this.epoch = 0;
  }
  async load() {
    try {
      this.state = JSON.parse(await this.encryption.decrypt(await readFile(this.file)));
      if (this.state.version !== 1 || !Array.isArray(this.state.accounts) || !this.state.hostId)
        throw new Error("ChatGPT 계정 저장 파일 형식을 확인할 수 없습니다.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.save();
    }
  }
  async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, await this.encryption.encrypt(JSON.stringify(this.state)), {
      mode: 0o600,
    });
    await rename(temp, this.file);
  }
  selected() {
    return this.state.accounts.find((account) => account.id === this.state.activeId);
  }
  status() {
    const active = this.selected();
    return {
      busy: Boolean(this.pending || this.changing),
      activeId: active?.id,
      sharing: Boolean(
        active?.tokens &&
          (!active.pendingTokens || this.refreshing) &&
          active.scopes?.includes(sharingScope),
      ),
      accounts: this.state.accounts.map(({ id, label, email, tokens, pendingTokens, scopes }) => ({
        id,
        label,
        email,
        connected: Boolean(tokens && !pendingTokens && scopes?.includes(sharingScope)),
      })),
      error: this.error,
    };
  }
  cancelRequests() {
    this.epoch++;
    for (const controller of this.requests) controller.abort();
  }
  cancelSignIn() {
    this.pending?.abort();
  }
  async select(id) {
    if (this.pending || this.refreshing || this.changing)
      throw new Error("진행 중인 계정 작업이 끝난 후 다시 시도하세요.");
    if (!this.state.accounts.some((entry) => entry.id === id))
      throw new Error("계정을 찾을 수 없습니다.");
    this.cancelRequests();
    this.state.activeId = id;
    this.error = undefined;
    this.changing = true;
    try {
      await this.save();
    } finally {
      this.changing = false;
    }
    return this.status();
  }
  async exchange(form) {
    const response = await this.fetcher(`${issuer}/api/accounts/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ ...form, resource }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const code = /^[a-z_]{1,80}$/.test(data.error) ? data.error : `HTTP ${response.status}`;
      throw Object.assign(new Error(`ChatGPT 인증 실패 (${code}). 다시 로그인해 주세요.`), {
        code,
      });
    }
    const data = await response.json();
    if (
      typeof data.access_token !== "string" ||
      typeof data.id_token !== "string" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      data.token_type?.toLowerCase() !== "bearer" ||
      typeof data.scope !== "string"
    )
      throw new Error("ChatGPT 인증 응답이 올바르지 않습니다.");
    return { ...data, receivedAt: Date.now(), expiresAt: Date.now() + data.expires_in * 1000 };
  }
  async validate(account, tokens, nonce) {
    const { payload } = await this.verify(tokens.id_token, jwks, {
      issuer,
      audience: account.clientId,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub"],
      currentDate: new Date(tokens.receivedAt),
    });
    if (
      !payload.sub ||
      (nonce !== undefined && payload.nonce !== nonce) ||
      (account.subject && account.subject !== payload.sub)
    )
      throw new Error("ChatGPT 로그인 계정 검증에 실패했습니다. 다시 로그인해 주세요.");
    account.subject = payload.sub;
    account.email = typeof payload.email === "string" ? payload.email : undefined;
    account.scopes = tokens.scope.split(/\s+/);
    account.tokens = tokens;
    delete account.pendingTokens;
  }
  async signIn(id, reconsent = false) {
    if (this.pending || this.refreshing || this.changing)
      throw new Error("이미 로그인 작업이 진행 중입니다.");
    const account = id
      ? this.state.accounts.find((entry) => entry.id === id)
      : {
          id: randomUUID(),
          label: `ChatGPT ${this.state.accounts.length + 1}`,
        };
    if (!account) throw new Error("계정을 찾을 수 없습니다.");
    this.cancelRequests();
    this.error = undefined;
    const controller = new AbortController();
    this.pending = controller;
    const state = random(),
      nonce = random(),
      verifier = random();
    let accept, reject;
    const callback = new Promise((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    // Attach a handler before opening the browser to avoid an early unhandled rejection.
    void callback.catch(() => {});
    const listener = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (req.method !== "GET" || url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      if (
        url.searchParams.get("state") !== state ||
        url.searchParams.getAll("state").length !== 1
      ) {
        res.writeHead(400).end("로그인 요청이 일치하지 않습니다.");
        return;
      }
      if (url.searchParams.has("error")) {
        res.end("로그인이 취소되었습니다. OpenMuse로 돌아가세요.");
        reject(new Error("ChatGPT 로그인이 취소되었거나 허용되지 않았습니다."));
        return;
      }
      res.end("OpenMuse에서 로그인 결과를 확인하세요. 이 창은 닫아도 됩니다.");
      accept(url.searchParams);
    });
    const timer = setTimeout(() => controller.abort(), 10 * 60_000);
    const abort = () => reject(new Error("ChatGPT 로그인이 취소되었거나 시간이 초과되었습니다."));
    controller.signal.addEventListener("abort", abort, { once: true });
    try {
      await new Promise((resolve, fail) => {
        listener.once("error", fail);
        listener.listen(0, "127.0.0.1", resolve);
      });
      const redirect = `http://127.0.0.1:${listener.address().port}/auth/callback`;
      const url = new URL(`${issuer}/api/accounts/authorize`);
      url.search = new URLSearchParams({
        client_id: account.clientId || "dynamic_agent_client",
        ...(!account.clientId ? { agent_name_hint: "OpenMuse" } : {}),
        ext_agent_host_id: this.state.hostId,
        ...(reconsent ? { prompt: "consent" } : {}),
        ...(account.tokens?.id_token ? { id_token_hint: account.tokens.id_token } : {}),
        ...(account.email ? { login_hint: account.email } : {}),
        response_type: "code",
        redirect_uri: redirect,
        scope: `openid profile email offline_access resource.invoke ${sharingScope}`,
        resource,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      }).toString();
      await this.openBrowser(url.href);
      const result = await callback;
      controller.signal.throwIfAborted();
      const issued = result.get("client_id") || account.clientId;
      if (
        !issued ||
        issued === "dynamic_agent_client" ||
        !/^[a-zA-Z0-9_-]{1,200}$/.test(issued) ||
        (account.clientId && account.clientId !== issued) ||
        !result.get("code")
      )
        throw new Error("ChatGPT 로그인 등록 정보가 일치하지 않습니다.");
      account.clientId = issued;
      if (!this.state.accounts.includes(account)) this.state.accounts.push(account);
      // Retain the issued client even when code exchange or identity validation fails.
      await this.save();
      const tokens = await this.exchange({
        grant_type: "authorization_code",
        client_id: issued,
        code: result.get("code"),
        code_verifier: verifier,
        redirect_uri: redirect,
      });
      controller.signal.throwIfAborted();
      await this.validate(account, tokens, nonce);
      this.state.activeId = account.id;
      await this.save();
      if (!account.scopes.includes(sharingScope))
        this.error =
          "로그인은 완료됐지만 ChatGPT 요금제 사용 권한이 없습니다. ChatGPT 설정에서 앱 사용을 허용해 주세요.";
    } catch (error) {
      this.error =
        error.name === "Error"
          ? error.message
          : "ChatGPT 계정 검증에 실패했습니다. 다시 로그인해 주세요.";
      throw new Error(this.error);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      listener.close();
      listener.closeAllConnections();
      this.pending = undefined;
    }
    return this.status();
  }
  async credential() {
    if (this.pending || this.changing) throw new Error("ChatGPT 계정 작업을 완료해 주세요.");
    const account = this.selected();
    if (!account?.tokens || !account.scopes?.includes(sharingScope))
      throw new Error("ChatGPT에 로그인하고 요금제 사용을 허용해 주세요.");
    if (account.pendingTokens || account.tokens.expiresAt < Date.now() + 60_000) {
      if (!this.refreshing)
        this.refreshing = (async () => {
          if (!account.pendingTokens) {
            const earliest = account.tokens.earliest_refresh_at;
            const readyAt =
              typeof earliest === "number" ? earliest * 1000 : Date.parse(earliest || "");
            if (readyAt > Date.now()) {
              if (account.tokens.expiresAt > Date.now()) return;
              throw new Error("ChatGPT 인증 갱신 대기 중입니다. 잠시 후 다시 시도하세요.");
            }
            if (!account.tokens.refresh_token) throw new Error("ChatGPT에 다시 로그인해 주세요.");
            try {
              account.pendingTokens = await this.exchange({
                grant_type: "refresh_token",
                client_id: account.clientId,
                refresh_token: account.tokens.refresh_token,
              });
            } catch (error) {
              if (
                [
                  "invalid_grant",
                  "invalid_refresh_token",
                  "token_expired",
                  "refresh_token_expired",
                  "refresh_token_invalidated",
                  "refresh_token_reused",
                ].includes(error.code)
              ) {
                delete account.tokens;
                account.scopes = [];
                await this.save();
              }
              throw error;
            }
            // Persist rotated tokens before network-dependent JWKS verification.
            await this.save();
          }
          await this.validate(account, account.pendingTokens);
          await this.save();
        })().finally(() => {
          this.refreshing = undefined;
        });
      await this.refreshing;
    }
    if (
      account.pendingTokens ||
      account.tokens.expiresAt <= Date.now() ||
      !account.scopes.includes(sharingScope)
    )
      throw new Error("ChatGPT 인증을 갱신할 수 없습니다. 다시 로그인해 주세요.");
    return account.tokens.access_token;
  }
  async authorized(operation, callerSignal) {
    const controller = new AbortController();
    this.requests.add(controller);
    const epoch = this.epoch;
    const signal = callerSignal
      ? AbortSignal.any([controller.signal, callerSignal])
      : controller.signal;
    try {
      const token = await this.credential();
      signal.throwIfAborted();
      if (epoch !== this.epoch) throw new Error("계정이 변경되어 요청을 취소했습니다.");
      return await operation(token, signal);
    } finally {
      this.requests.delete(controller);
    }
  }
  async disconnect() {
    if (this.pending || this.refreshing || this.changing)
      throw new Error("진행 중인 계정 작업이 끝난 후 다시 시도하세요.");
    this.cancelRequests();
    const account = this.selected();
    this.error = undefined;
    if (!account) return this.status();
    this.changing = true;
    try {
      const token = (account.pendingTokens || account.tokens)?.refresh_token;
      if (token) {
        let revoked = false;
        for (let attempt = 0; attempt < 2 && !revoked; attempt++) {
          if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
          try {
            const response = await this.fetcher(`${issuer}/api/accounts/oauth/revoke`, {
              method: "POST",
              body: new URLSearchParams({
                token,
                token_type_hint: "refresh_token",
                client_id: account.clientId,
              }),
              redirect: "error",
              signal: AbortSignal.timeout(8_000),
            });
            revoked = response.status === 200;
            await response.body?.cancel();
          } catch {
            /* Always remove local credentials, even offline. */
          }
        }
        if (!revoked)
          this.error =
            "이 PC에서는 로그아웃했습니다. 서버 연결 해제는 확인하지 못했으니 ChatGPT 설정에서도 연결을 해제해 주세요.";
      }
      delete account.tokens;
      delete account.pendingTokens;
      account.scopes = [];
      await this.save();
    } finally {
      this.changing = false;
    }
    return this.status();
  }
}
