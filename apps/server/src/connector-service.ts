import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  remoteHostConfigSchema,
  remoteHostSecretsSchema,
  type StoredConnector,
  tailscaleConfigSchema,
  tailscaleSecretsSchema,
  wireguardConfigSchema,
} from "../../../packages/domain/src/connectors.ts";
import type { Connection } from "../../../packages/domain/src/index.ts";
import {
  type ConnectorWriteInput,
  connectorWriteSchema,
  proxmoxWriteSchema,
} from "../../../packages/domain/src/proxmox.ts";
import { parseRemoteOperation } from "../../../packages/domain/src/remote-host.ts";
import { parseGithubWrite } from "../../../packages/domain/src/github.ts";
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
  remote_host: { config: remoteHostConfigSchema, secrets: remoteHostSecretsSchema },
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

  async operations(owner: string, id: string) {
    const stored = await this.record(owner, id);
    return {
      provider: stored.provider,
      operations: connectorAdapter(stored.provider, this.deps).info.operations,
    };
  }

  async actionConnection(owner: string, input: ConnectorWriteInput) {
    const stored = await this.record(owner, input.connectorId);
    if (!["proxmox", "remote_host", "github"].includes(stored.provider) || !stored.secret)
      throw new AppError("인증 정보가 있는 GitHub·Proxmox·원격 호스트를 연결하세요", 409);
    return {
      id: stored.id,
      account: `${stored.provider} · ${stored.name} · ${stored.config.baseUrl ?? stored.config.host ?? "https://api.github.com"}`,
    };
  }

  private connectionVersion(stored: StoredConnector) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          id: stored.id,
          provider: stored.provider,
          config: stored.config,
          secret: stored.secret,
        }),
      )
      .digest("hex");
  }

  async prepareWrite(owner: string, raw: unknown) {
    const parsed = connectorWriteSchema.parse(raw);
    await this.actionConnection(owner, parsed);
    const stored = await this.record(owner, parsed.connectorId);
    const adapter = connectorAdapter(stored.provider, this.deps);
    if (stored.provider === "github") {
      const params = parseGithubWrite(parsed.operation, parsed.params);
      return {
        input: {
          kind: "connector.write" as const,
          data: connectorWriteSchema.parse({ ...parsed, params }),
        },
        targetVersion: JSON.stringify({ connection: this.connectionVersion(stored) }),
      };
    }
    if (stored.provider === "remote_host") {
      const params = parseRemoteOperation(parsed.operation, parsed.params, true);
      if (parsed.operation === "host_command") params.jobId ??= randomUUID();
      return {
        input: {
          kind: "connector.write" as const,
          data: connectorWriteSchema.parse({ ...parsed, params }),
        },
        targetVersion: JSON.stringify({ connection: this.connectionVersion(stored) }),
      };
    }
    const input = proxmoxWriteSchema.parse({ operation: parsed.operation, params: parsed.params });
    const params: Record<string, unknown> = { ...input.params };
    let target:
      | { operation: "guest_config" | "storage_config"; params: Record<string, unknown> }
      | undefined;
    if ("kind" in params && !["guest_create", "restore"].includes(input.operation))
      target = {
        operation: "guest_config",
        params: { node: params.node, kind: params.kind, vmid: params.vmid },
      };
    else if (["storage_config_update", "storage_delete"].includes(input.operation))
      target = { operation: "storage_config", params: { storage: params.storage } };
    let targetDigest: string | undefined;
    if (target) {
      const response = (await adapter.run(
        {
          config: stored.config,
          secrets: await this.secrets(stored),
          timeoutMs: this.deps.timeoutMs,
        },
        target.operation,
        target.params,
      )) as { config?: Record<string, unknown>; storages?: Record<string, unknown>[] };
      const config = response.config ?? response.storages?.[0];
      if (typeof config?.digest !== "string" || !/^[a-fA-F0-9]{40,64}$/.test(config.digest))
        throw new AppError("Provider did not return a target configuration version", 502);
      targetDigest = config.digest;
      if (["guest_config_update", "storage_config_update"].includes(input.operation))
        params.digest = targetDigest;
    }
    const data = connectorWriteSchema.parse({
      connectorId: stored.id,
      operation: input.operation,
      params,
    });
    return {
      input: { kind: "connector.write" as const, data },
      targetVersion: JSON.stringify({
        connection: this.connectionVersion(stored),
        target,
        targetDigest,
      }),
    };
  }

  async executeWrite(owner: string, raw: unknown, targetVersion?: string) {
    const input = connectorWriteSchema.parse(raw);
    const stored = await this.record(owner, input.connectorId);
    if (!["proxmox", "remote_host", "github"].includes(stored.provider) || !targetVersion)
      throw new AppError("Prepare a fresh connector action before execution", 409);
    const expected = JSON.parse(targetVersion) as {
      connection: string;
      target?: { operation: string; params: Record<string, unknown> };
      targetDigest?: string;
    };
    if (expected.connection !== this.connectionVersion(stored))
      throw new AppError(
        "Connector configuration or credentials changed. Prepare a fresh action.",
        409,
      );
    const adapter = connectorAdapter(stored.provider, this.deps),
      ctx = {
        config: stored.config,
        secrets: await this.secrets(stored),
        timeoutMs: this.deps.timeoutMs,
        stateDir: this.stateDirectory(owner, stored.id),
      };
    if (expected.target) {
      const response = (await adapter.run(
        ctx,
        expected.target.operation,
        expected.target.params,
      )) as { config?: Record<string, unknown>; storages?: Record<string, unknown>[] };
      if ((response.config ?? response.storages?.[0])?.digest !== expected.targetDigest)
        throw new AppError("Proxmox target configuration changed. Prepare a fresh action.", 409);
    }
    if (!adapter.write) throw new AppError("This connector does not support writes", 422);
    return JSON.stringify(await adapter.write(ctx, input));
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
          stateDir: this.stateDirectory(owner, stored.id),
        },
        operation,
        params,
      );
    } catch (error) {
      if (error instanceof ConnectorError) throw new AppError(error.message, 502);
      throw error;
    }
  }

  private stateDirectory(owner: string, id: string) {
    return join(
      this.config.dataDir,
      "remote-host-jobs",
      createHash("sha256").update(`${owner}:${id}`).digest("hex"),
    );
  }

  /** Owner-enabled host permission persists across turns; no new approval loop is imposed. */
  async executeHostCommand(owner: string, id: string, raw: unknown, operationId: string) {
    const stored = await this.record(owner, id);
    if (
      stored.provider !== "remote_host" ||
      !remoteHostConfigSchema.parse(stored.config).allowAgentShell
    )
      throw new AppError(
        "이 호스트의 에이전트 셸 실행이 허용되지 않았습니다. 연결 설정에서 허용하거나 기존 명령 검토를 사용하세요",
        409,
      );
    const params = parseRemoteOperation("host_command", raw, true);
    delete params.jobId;
    const recordId = createHash("sha256").update(`${id}:${operationId}`).digest("hex");
    const version = this.connectionVersion(stored);
    type Dispatch = {
      id: string;
      params: Record<string, unknown>;
      version: string;
      jobId: string;
      dispatched?: boolean;
    };
    const proposed: Dispatch = { id: recordId, params, version, jobId: randomUUID() };
    const reserved = await this.db.insertIfAbsent(owner, "remote-host-dispatches", proposed);
    const dispatch =
      reserved ?? (await this.db.get<Dispatch>(owner, "remote-host-dispatches", recordId));
    const sameParams = (value: Record<string, unknown>) =>
      JSON.stringify(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    if (
      !dispatch ||
      dispatch.version !== version ||
      sameParams(dispatch.params) !== sameParams(params)
    )
      throw new AppError("작업 ID의 대상이나 명령이 변경되었습니다. 새 작업 ID를 사용하세요", 409);
    if (dispatch.dispatched) return this.run(owner, id, "host_job", { jobId: dispatch.jobId });
    const adapter = connectorAdapter(stored.provider, this.deps);
    if (!adapter.write) throw new AppError("호스트 명령 실행을 사용할 수 없습니다", 503);
    const result = await adapter.write(
      {
        config: stored.config,
        secrets: await this.secrets(stored),
        stateDir: this.stateDirectory(owner, id),
        timeoutMs: this.deps.timeoutMs,
      },
      { connectorId: id, operation: "host_command", params: { ...params, jobId: dispatch.jobId } },
    );
    await this.db.compareAndSwap(
      owner,
      "remote-host-dispatches",
      recordId,
      { version },
      { dispatched: true },
    );
    return result;
  }

  /** Internal server use only; neither this target nor its token is sent to the app. */
  async browserTarget(owner: string, id: string) {
    const stored = await this.record(owner, id);
    if (stored.provider !== "remote_host") throw new AppError("원격 호스트 연결을 선택하세요", 422);
    const config = remoteHostConfigSchema.parse(stored.config);
    const secrets = remoteHostSecretsSchema.parse(await this.secrets(stored));
    if (config.mode !== "agent" || !config.baseUrl || !secrets.token)
      throw new AppError(
        "공유 브라우저를 사용하려면 대상에 Host Agent를 설치하고 agent 방식으로 연결하세요",
        409,
      );
    return {
      url: config.baseUrl.replace(/\/$/, ""),
      token: secrets.token,
      revision: this.connectionVersion(stored),
    };
  }

  /** Summary for the workspace connection list; secrets never appear here. */
  async connections(owner: string): Promise<Connection[]> {
    return (await this.db.list<StoredConnector>(owner, "connectors")).map((record) => ({
      id: `connector:${record.id}`,
      name: record.name,
      status: record.check ? (record.check.ok ? "connected" : "unavailable") : "unconfigured",
      capabilities: connectorAdapter(record.provider, this.deps).info.operations.map(
        (operation) => operation.name,
      ),
    }));
  }
}
