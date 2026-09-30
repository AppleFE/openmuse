import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ConnectorCheck,
  type ConnectorCreateInput,
  type ConnectorView,
  connectorCreateSchema,
  connectorOperations,
  connectorUpdateSchema,
  githubConfigSchema,
  githubSecretsSchema,
  headscaleConfigSchema,
  headscaleSecretsSchema,
  proxmoxConfigSchema,
  proxmoxSecretsSchema,
  type StoredConnector,
  tailscaleConfigSchema,
  tailscaleSecretsSchema,
  wireguardConfigSchema,
} from "../../../packages/domain/src/connectors.ts";
import type { Connection } from "../../../packages/domain/src/index.ts";
import {
  type ConnectorDeps,
  ConnectorError,
  connectorAdapter,
  connectorProviderInfo,
} from "../../../packages/integrations/src/connectors/index.ts";
import {
  decryptSecret,
  encryptSecret,
  validateEncryptionKey,
} from "../../../packages/integrations/src/vault.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

const providerSchemas = {
  github: { config: githubConfigSchema, secrets: githubSecretsSchema },
  tailscale: { config: tailscaleConfigSchema, secrets: tailscaleSecretsSchema },
  headscale: { config: headscaleConfigSchema, secrets: headscaleSecretsSchema },
  wireguard: { config: wireguardConfigSchema, secrets: null },
  proxmox: { config: proxmoxConfigSchema, secrets: proxmoxSecretsSchema },
} as const;

const now = () => new Date().toISOString();

/**
 * Strip URL userinfo from `*Url` config fields returned in views. Writes are
 * rejected at the schema boundary; this covers records written before that
 * invariant existed.
 */
function sanitizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string" && /url$/i.test(key)) {
      try {
        const url = new URL(value);
        if (url.username || url.password) {
          url.username = "";
          url.password = "";
          cleaned[key] = url.toString();
          continue;
        }
      } catch {
        // Not a parseable URL; schema validation decides whether it is allowed.
      }
    }
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Durable, owner-scoped connector management. Secrets are encrypted with
 * TOKEN_ENCRYPTION_KEY (or a generated per-installation key in sample mode)
 * and are never returned in views, logs or error messages.
 */
export class ConnectorService {
  private keyPromise?: Promise<string>;
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly deps: ConnectorDeps = {},
  ) {}

  providers() {
    return connectorProviderInfo();
  }

  private view(record: StoredConnector): ConnectorView {
    return {
      id: record.id,
      provider: record.provider,
      name: record.name,
      config: sanitizeConfig(record.config),
      hasSecret: Boolean(record.secret),
      ...(record.check ? { check: record.check } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private async secretKey(): Promise<string> {
    this.keyPromise ??= (async () => {
      if (this.config.encryptionKey) {
        try {
          validateEncryptionKey(this.config.encryptionKey);
        } catch {
          throw new AppError(
            "Credential storage is not configured. TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes as base64.",
            503,
          );
        }
        return this.config.encryptionKey;
      }
      // Sample mode has no configured key; persist a random one beside the data
      // directory exactly like the session signing key.
      await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
      const path = join(this.config.dataDir, "connector-secret-key");
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

  private async secrets(record: StoredConnector): Promise<Record<string, unknown>> {
    if (!record.secret) return {};
    try {
      return JSON.parse(decryptSecret(record.secret, await this.secretKey())) as Record<
        string,
        unknown
      >;
    } catch {
      throw new AppError("Stored credentials could not be decrypted. Reconnect the provider.", 503);
    }
  }

  private async encrypt(secrets: Record<string, unknown>): Promise<string> {
    return encryptSecret(JSON.stringify(secrets), await this.secretKey());
  }

  private async record(owner: string, id: string): Promise<StoredConnector> {
    const record = await this.db.get<StoredConnector>(owner, "connectors", id);
    if (!record) throw new AppError("Connector not found", 404);
    return record;
  }

  async list(owner: string): Promise<ConnectorView[]> {
    return (await this.db.list<StoredConnector>(owner, "connectors")).map((record) =>
      this.view(record),
    );
  }

  async get(owner: string, id: string): Promise<ConnectorView> {
    return this.view(await this.record(owner, id));
  }

  async create(owner: string, raw: unknown): Promise<ConnectorView> {
    const input = connectorCreateSchema.parse(raw);
    const record: StoredConnector = {
      id: randomUUID(),
      provider: input.provider,
      name: input.name,
      config: input.config,
      secret: await this.secretPayload(input),
      createdAt: now(),
      updatedAt: now(),
    };
    await this.db.put(owner, "connectors", record);
    return this.view(record);
  }

  private async secretPayload(input: ConnectorCreateInput): Promise<string | null> {
    const secrets = "secrets" in input ? input.secrets : undefined;
    if (!secrets || Object.keys(secrets).length === 0) return null;
    return this.encrypt(secrets);
  }

  async update(owner: string, id: string, raw: unknown): Promise<ConnectorView> {
    const patch = connectorUpdateSchema.parse(raw);
    const stored = await this.record(owner, id);
    const schemas = providerSchemas[stored.provider];
    const config = patch.config === undefined ? stored.config : schemas.config.parse(patch.config);
    let secret = stored.secret;
    if (patch.secrets === null) secret = null;
    else if (patch.secrets !== undefined) {
      if (!schemas.secrets)
        throw new AppError(`${stored.provider} connectors do not take secrets`, 422);
      const parsed = schemas.secrets.parse(patch.secrets);
      secret = Object.keys(parsed).length === 0 ? null : await this.encrypt(parsed);
    }
    const credentialsChanged =
      patch.secrets !== undefined ||
      (patch.config !== undefined && JSON.stringify(config) !== JSON.stringify(stored.config));
    const updated = await this.db.compareAndSwap<StoredConnector>(
      owner,
      "connectors",
      id,
      { ...stored },
      {
        name: patch.name ?? stored.name,
        config,
        secret,
        // A check describes the previous credentials; clear it when they change.
        ...(credentialsChanged ? { check: null } : {}),
        updatedAt: now(),
      },
    );
    if (!updated) throw new AppError("Connector changed; refresh and try again", 409);
    return this.view(updated);
  }

  async remove(owner: string, id: string): Promise<void> {
    if (!(await this.db.take<StoredConnector>(owner, "connectors", id)))
      throw new AppError("Connector not found", 404);
  }

  async test(owner: string, id: string, signal?: AbortSignal): Promise<ConnectorCheck> {
    const stored = await this.record(owner, id);
    let check: ConnectorCheck;
    try {
      const result = await connectorAdapter(stored.provider, this.deps).test({
        config: stored.config,
        secrets: await this.secrets(stored),
        timeoutMs: this.deps.timeoutMs,
        signal,
      });
      check = { ...result, checkedAt: now() };
    } catch (error) {
      check = {
        ok: false,
        detail: error instanceof Error ? error.message : "Connector check failed",
        checkedAt: now(),
      };
    }
    // Persist only while the credentials and config that produced this result are
    // still stored; a concurrent edit invalidates it and must not be overwritten.
    await this.db.compareAndSwap(
      owner,
      "connectors",
      id,
      { config: stored.config, secret: stored.secret },
      { check },
    );
    return check;
  }

  async run(
    owner: string,
    id: string,
    operation: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const stored = await this.record(owner, id);
    if (!(connectorOperations[stored.provider] as readonly string[]).includes(operation))
      throw new AppError(
        `Unsupported ${stored.provider} operation "${operation}". Available: ${connectorOperations[stored.provider].join(", ")}`,
        422,
      );
    try {
      return await connectorAdapter(stored.provider, this.deps).run(
        {
          config: stored.config,
          secrets: await this.secrets(stored),
          timeoutMs: this.deps.timeoutMs,
          signal,
        },
        operation,
        params,
      );
    } catch (error) {
      if (error instanceof ConnectorError) throw new AppError(error.message, 502);
      throw error;
    }
  }

  /** Summary for the workspace connection list; secrets never appear here. */
  async connections(owner: string): Promise<Connection[]> {
    return (await this.db.list<StoredConnector>(owner, "connectors")).map((record) => ({
      id: `connector:${record.id}`,
      name: record.name,
      status: record.check ? (record.check.ok ? "connected" : "unavailable") : "unconfigured",
      capabilities: [...connectorOperations[record.provider]],
    }));
  }
}
