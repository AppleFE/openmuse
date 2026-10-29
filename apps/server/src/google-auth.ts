import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../../../packages/integrations/src/vault.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
  scope: z.string().optional(),
});
interface Tokens {
  connectionId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
  account: string;
}
interface OAuthState {
  id: string;
  owner: string;
  expiresAt: number;
  verifier: string;
  scopes: string[];
  generation: string;
  clientId?: string;
}
interface Credential {
  id: string;
  generation?: string;
  connectionId: string | null;
  secret: string | null;
}
export class GoogleAuth {
  private readonly refreshing = new Map<string, Promise<string>>();
  constructor(
    private readonly db: Store,
    private readonly config: Config,
  ) {}
  configured() {
    return Boolean(
      this.config.googleClientId && this.config.googleClientSecret && this.config.encryptionKey,
    );
  }
  private async client(owner: string) {
    const stored = this.config.desktop
      ? await this.db.get<{ id: string; secret: string }>(owner, "credentials", "google-client")
      : null;
    if (stored && this.config.encryptionKey)
      return JSON.parse(decryptSecret(stored.secret, this.config.encryptionKey)) as {
        clientId: string;
        clientSecret: string;
      };
    return { clientId: this.config.googleClientId, clientSecret: this.config.googleClientSecret };
  }
  async clientStatus(owner: string) {
    const client = await this.client(owner);
    return {
      configured: Boolean(client.clientId && client.clientSecret && this.config.encryptionKey),
    };
  }
  async importClient(owner: string, input: unknown) {
    if (!this.config.desktop)
      throw new AppError("설치 앱에서만 OAuth 파일을 등록할 수 있습니다", 403);
    if (!this.config.encryptionKey) throw new AppError("암호화 저장소를 사용할 수 없습니다", 503);
    const value = z
      .object({
        installed: z.object({
          client_id: z
            .string()
            .max(512)
            .regex(/^[\w.-]+\.apps\.googleusercontent\.com$/),
          client_secret: z.string().min(1).max(512),
          auth_uri: z.literal("https://accounts.google.com/o/oauth2/auth").optional(),
          token_uri: z.literal("https://oauth2.googleapis.com/token").optional(),
        }),
      })
      .safeParse(input);
    if (!value.success)
      throw new AppError(
        "Google Cloud에서 다운로드한 데스크톱 앱용 OAuth JSON 파일을 선택하세요",
        400,
      );
    if (await this.tokens(owner))
      throw new AppError("Google 연결을 해제한 뒤 OAuth 설정을 변경하세요", 409);
    await this.rotateGeneration(owner, true);
    await this.db.put(owner, "credentials", {
      id: "google-client",
      secret: encryptSecret(
        JSON.stringify({
          clientId: value.data.installed.client_id,
          clientSecret: value.data.installed.client_secret,
        }),
        this.config.encryptionKey,
      ),
    });
    return { configured: true };
  }
  async tokens(owner: string): Promise<Tokens | null> {
    return this.decodeTokens(await this.db.get<Credential>(owner, "credentials", "google"));
  }
  private decodeTokens(stored: Credential | null): Tokens | null {
    if (!stored?.secret) return null;
    if (!this.config.encryptionKey)
      throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
    return JSON.parse(decryptSecret(stored.secret, this.config.encryptionKey));
  }
  private async save(owner: string, tokens: Tokens, generation: string) {
    if (!this.config.encryptionKey)
      throw new AppError("TOKEN_ENCRYPTION_KEY is not configured", 503);
    const saved = await this.db.compareAndSwap<Credential>(
      owner,
      "credentials",
      "google",
      { generation },
      {
        generation: randomUUID(),
        connectionId: tokens.connectionId,
        secret: encryptSecret(JSON.stringify(tokens), this.config.encryptionKey),
      },
    );
    if (!saved)
      throw new AppError("Google sign-in changed or was disconnected. Connect again.", 409);
  }
  private async rotateGeneration(owner: string, disconnect = false) {
    const generation = randomUUID();
    for (;;) {
      const previous = await this.db.get<Credential>(owner, "credentials", "google");
      if (!previous) {
        const inserted = await this.db.insertIfAbsent(owner, "credentials", {
          id: "google",
          generation,
          connectionId: null,
          secret: null,
        });
        if (inserted) return { generation, previous: null };
      } else {
        const updated = await this.db.compareAndSwap<Credential>(
          owner,
          "credentials",
          "google",
          { ...previous },
          {
            generation,
            ...(disconnect ? { connectionId: null, secret: null } : {}),
          },
        );
        if (updated) return { generation, previous };
      }
    }
  }
  async connect(owner: string, write: boolean) {
    const client = await this.client(owner);
    if (!client.clientId || !client.clientSecret || !this.config.encryptionKey)
      throw new AppError(
        this.config.desktop
          ? "Google OAuth 설정이 필요합니다. 데스크톱 앱용 OAuth JSON 파일을 등록한 뒤 연결하세요."
          : "Google OAuth 클라이언트와 토큰 암호화 키를 서버에 설정하세요.",
        503,
      );
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(48).toString("base64url");
    const { generation, previous } = await this.rotateGeneration(owner);
    const existing = this.decodeTokens(previous);
    const scopes = Array.from(
      new Set([
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.events.readonly",
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        ...(existing?.scopes ?? []),
        ...(write
          ? [
              "https://www.googleapis.com/auth/gmail.send",
              "https://www.googleapis.com/auth/calendar.events",
            ]
          : []),
      ]),
    );
    await this.db.put("system", "oauth", {
      id: state,
      owner,
      expiresAt: Date.now() + 10 * 60 * 1000,
      verifier,
      scopes,
      generation,
      clientId: client.clientId,
    });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: this.config.googleRedirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    return { url: url.toString() };
  }
  async callback(stateId: string, code: string) {
    const state = await this.db.take<OAuthState>("system", "oauth", stateId);
    if (!state || state.expiresAt < Date.now())
      throw new AppError("Google sign-in expired. Connect again.", 400);
    const credential = await this.db.get<Credential>(state.owner, "credentials", "google");
    if (!state.generation || credential?.generation !== state.generation)
      throw new AppError("Google sign-in changed or was disconnected. Connect again.", 409);
    const client = await this.client(state.owner);
    if (state.clientId && state.clientId !== client.clientId)
      throw new AppError("Google OAuth 설정이 변경됐습니다. 다시 연결하세요", 409);
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId ?? "",
        client_secret: client.clientSecret ?? "",
        redirect_uri: this.config.googleRedirectUri,
        grant_type: "authorization_code",
        code,
        code_verifier: state.verifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new AppError("Google could not complete sign-in. Connect again.", 502);
    const token = tokenSchema.parse(await response.json());
    const profile = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!profile.ok)
      throw new AppError("Google did not grant Gmail read access. Connect again.", 403);
    const { emailAddress } = z.object({ emailAddress: z.email() }).parse(await profile.json());
    const previous = await this.tokens(state.owner);
    await this.save(
      state.owner,
      {
        connectionId: randomUUID(),
        accessToken: token.access_token,
        refreshToken:
          token.refresh_token ??
          (previous?.account === emailAddress ? previous.refreshToken : undefined),
        expiresAt: Date.now() + token.expires_in * 1000,
        scopes: token.scope?.split(" ") ?? state.scopes,
        account: emailAddress,
      },
      state.generation,
    );
  }
  async accessToken(owner: string, expectedConnectionId?: string): Promise<string> {
    const tokens = await this.tokens(owner);
    if (!tokens) throw new AppError("Google is disconnected", 409);
    if (expectedConnectionId && tokens.connectionId !== expectedConnectionId)
      throw new AppError("Google account or connection changed. Prepare a new action.", 409);
    if (tokens.expiresAt > Date.now() + 60000) return tokens.accessToken;
    const refreshKey = `${owner}:${tokens.connectionId}`;
    const pending = this.refreshing.get(refreshKey);
    if (pending) return pending;
    const task = this.refresh(owner, tokens).finally(() => this.refreshing.delete(refreshKey));
    this.refreshing.set(refreshKey, task);
    return task;
  }
  private async refresh(owner: string, tokens: Tokens) {
    if (!tokens.refreshToken) throw new AppError("Google session expired. Connect again.", 401);
    const client = await this.client(owner);
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId ?? "",
        client_secret: client.clientSecret ?? "",
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      }),
      signal: AbortSignal.timeout(15000),
    });
    // Google answers 400 invalid_grant for revoked or expired refresh tokens; 5xx is temporary.
    if (response.status >= 500 || response.status === 429)
      throw new AppError("Google is unavailable right now. Refresh to try again.", 502);
    if (!response.ok) throw new AppError("Google session expired. Connect again.", 401);
    const token = tokenSchema.parse(await response.json());
    const refreshed = {
      ...tokens,
      accessToken: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    };
    if (!this.config.encryptionKey) throw new AppError("Token encryption is not configured", 503);
    const updated = await this.db.updateCredential(
      owner,
      tokens.connectionId,
      encryptSecret(JSON.stringify(refreshed), this.config.encryptionKey),
    );
    if (!updated)
      throw new AppError("Google account changed or was disconnected during refresh", 409);
    return token.access_token;
  }
  async disconnect(owner: string) {
    const { previous } = await this.rotateGeneration(owner, true);
    const tokens = this.decodeTokens(previous);
    if (tokens) {
      const response = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.refreshToken ?? tokens.accessToken }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok && response.status !== 400)
        throw new AppError(
          "Disconnected locally. Google revocation failed; remove access in your Google account settings.",
          502,
        );
    }
  }
}
