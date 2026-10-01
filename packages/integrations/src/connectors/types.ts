import type { ConnectorCheck, ConnectorProviderInfo } from "../../../domain/src/connectors.ts";
import type { ConnectorWriteInput } from "../../../domain/src/proxmox.ts";

/** Validated provider config and decrypted secrets for one connection. */
export interface ConnectorContext {
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  timeoutMs?: number;
  /** Aborts in-flight provider I/O when the caller's request is cancelled. */
  signal?: AbortSignal;
}

/**
 * Provider adapter. `test` verifies credentials reach the provider;
 * `run` executes a read operation. Writes use the reviewed action executor.
 */
export interface ConnectorAdapter {
  readonly info: ConnectorProviderInfo;
  test(context: ConnectorContext): Promise<Omit<ConnectorCheck, "checkedAt">>;
  run(
    context: ConnectorContext,
    operation: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
  /** Called only by the reviewed action executor; never by the query route. */
  write?(context: ConnectorContext, input: ConnectorWriteInput): Promise<unknown>;
}

/** Runs a local binary with a fixed argv and no shell. Used only by WireGuard. */
export type ConnectorExec = (
  file: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

export interface ConnectorDeps {
  exec?: ConnectorExec;
  /** Provider request timeout override; defaults to 15s per call. */
  timeoutMs?: number;
}
