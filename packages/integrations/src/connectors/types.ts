import type { ConnectorCheck, ConnectorProviderInfo } from "../../../domain/src/connectors.ts";

/** Validated provider config and decrypted secrets for one connection. */
export interface ConnectorContext {
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * Read-only provider adapter. `test` verifies credentials reach the provider;
 * `run` executes one of the operations named in `info.operations`.
 */
export interface ConnectorAdapter {
  readonly info: ConnectorProviderInfo;
  test(context: ConnectorContext): Promise<Omit<ConnectorCheck, "checkedAt">>;
  run(
    context: ConnectorContext,
    operation: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
}

/** Runs a local binary with a fixed argv and no shell. Used only by WireGuard. */
export type ConnectorExec = (
  file: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface ConnectorDeps {
  exec?: ConnectorExec;
}
