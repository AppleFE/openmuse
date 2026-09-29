import {
  type ConnectorProvider,
  type ConnectorProviderInfo,
  connectorProviderSchema,
} from "../../../domain/src/connectors.ts";
import { githubAdapter } from "./github.ts";
import { headscaleAdapter } from "./headscale.ts";
import { proxmoxAdapter } from "./proxmox.ts";
import { tailscaleAdapter } from "./tailscale.ts";
import type { ConnectorAdapter, ConnectorDeps } from "./types.ts";
import { wireguardAdapter } from "./wireguard.ts";

const factories: Record<ConnectorProvider, (deps: ConnectorDeps) => ConnectorAdapter> = {
  github: () => githubAdapter(),
  tailscale: () => tailscaleAdapter(),
  headscale: () => headscaleAdapter(),
  wireguard: (deps) => wireguardAdapter(deps.exec),
  proxmox: () => proxmoxAdapter(),
};

/** Build the adapter for one provider; `deps.exec` overrides the local binary runner (tests). */
export function connectorAdapter(
  provider: ConnectorProvider,
  deps: ConnectorDeps = {},
): ConnectorAdapter {
  return factories[provider](deps);
}

/** Static provider metadata describing the management contract to clients. */
export function connectorProviderInfo(): ConnectorProviderInfo[] {
  return connectorProviderSchema.options.map((provider) => factories[provider]({}).info);
}

export { ConnectorError, httpJson, redact } from "./http.ts";
export type { ConnectorAdapter, ConnectorContext, ConnectorDeps, ConnectorExec } from "./types.ts";
export { parseWgDump } from "./wireguard.ts";
