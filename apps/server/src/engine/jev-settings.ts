import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  JevFailMode,
  RuntimeSettingsPatch,
  RuntimeSettingsView,
} from "../../../../packages/domain/src/agent.ts";
import { decryptSecret, encryptSecret } from "../../../../packages/integrations/src/vault.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";

interface StoredRuntimeSettings {
  id: "runtime";
  jev: { enabled: boolean; model: string; failMode: JevFailMode; timeoutMs: number };
  pi: { enabled: boolean; maxIterations: number; timeoutMs: number };
  updatedAt: string;
}
interface StoredJevCredential {
  id: "jev";
  secret: string;
}
export interface ResolvedRuntimeSettings extends RuntimeSettingsView {
  jev: RuntimeSettingsView["jev"] & { apiKey?: string; baseURL?: string };
}

const defaults = (config: Config): StoredRuntimeSettings => ({
  id: "runtime",
  jev: {
    enabled: false,
    model: config.typesafeModel?.trim() || "jev-latest",
    failMode: "closed",
    timeoutMs: 10000,
  },
  pi: { enabled: false, maxIterations: 3, timeoutMs: 5 * 60 * 1000 },
  updatedAt: new Date(0).toISOString(),
});

/** Durable owner settings plus an encrypted optional Jev API-key override. */
export class RuntimeSettingsService {
  private keyPromise?: Promise<string>;
  constructor(
    private readonly db: Store,
    private readonly config: Config,
  ) {}

  private async secretKey(): Promise<string> {
    if (this.config.encryptionKey) return this.config.encryptionKey;
    this.keyPromise ??= (async () => {
      await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
      const path = join(this.config.dataDir, "runtime-secret-key");
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        const key = randomBytes(32).toString("base64");
        try {
          await writeFile(path, key, { mode: 0o600, flag: "wx" });
          return key;
        } catch (writeError) {
          if (
            !(writeError instanceof Error && "code" in writeError && writeError.code === "EEXIST")
          )
            throw writeError;
          return readFile(path, "utf8");
        }
      }
    })();
    return this.keyPromise;
  }

  private async credential(owner: string): Promise<string | undefined> {
    const envKey = this.config.typesafeApiKey?.trim();
    if (envKey) return envKey;
    const stored = await this.db.get<StoredJevCredential>(owner, "runtime-credentials", "jev");
    if (!stored) return undefined;
    try {
      return decryptSecret(stored.secret, await this.secretKey());
    } catch {
      throw new AppError("The stored Jev credential cannot be decrypted. Save it again.", 503);
    }
  }

  async resolve(owner: string): Promise<ResolvedRuntimeSettings> {
    const saved = await this.db.get<StoredRuntimeSettings>(owner, "runtime-settings", "runtime");
    const value = saved ?? defaults(this.config);
    const apiKey = await this.credential(owner);
    return {
      ...value,
      jev: {
        ...value.jev,
        configured: Boolean(apiKey),
        ...(apiKey ? { apiKey } : {}),
        ...(this.config.typesafeBaseUrl ? { baseURL: this.config.typesafeBaseUrl } : {}),
      },
    };
  }

  async view(owner: string): Promise<RuntimeSettingsView> {
    const value = await this.resolve(owner);
    const { apiKey: _apiKey, baseURL: _baseURL, ...jev } = value.jev;
    return { ...value, jev };
  }

  async update(owner: string, patch: RuntimeSettingsPatch): Promise<RuntimeSettingsView> {
    const hasApiKeyPatch = Boolean(patch.jev && Object.hasOwn(patch.jev, "apiKey"));
    const currentlyConfigured = Boolean(await this.credential(owner));
    const current = await this.db.get<StoredRuntimeSettings>(owner, "runtime-settings", "runtime");
    const base = current ?? defaults(this.config);
    const next: StoredRuntimeSettings = {
      id: "runtime",
      jev: {
        ...base.jev,
        ...Object.fromEntries(Object.entries(patch.jev ?? {}).filter(([key]) => key !== "apiKey")),
      },
      pi: { ...base.pi, ...(patch.pi ?? {}) },
      updatedAt: new Date().toISOString(),
    };
    const configured = this.config.typesafeApiKey?.trim()
      ? true
      : hasApiKeyPatch
        ? Boolean(patch.jev?.apiKey)
        : currentlyConfigured;
    if (next.jev.enabled && !configured)
      throw new AppError(
        "Save a Jev API key or configure TYPESAFE_API_KEY before enabling Jev",
        422,
      );
    if (hasApiKeyPatch) {
      if (patch.jev?.apiKey === null) await this.db.remove(owner, "runtime-credentials", "jev");
      else if (patch.jev?.apiKey)
        await this.db.put(owner, "runtime-credentials", {
          id: "jev",
          secret: encryptSecret(patch.jev.apiKey, await this.secretKey()),
        });
    }
    await this.db.put(owner, "runtime-settings", next);
    return this.view(owner);
  }
}
