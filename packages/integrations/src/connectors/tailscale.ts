import { z } from "zod";
import {
  type ConnectorProviderInfo,
  tailscaleConfigSchema,
  tailscaleSecretsSchema,
} from "../../../domain/src/connectors.ts";
import { ConnectorError, httpJson } from "./http.ts";
import type { ConnectorAdapter, ConnectorContext } from "./types.ts";

const DEFAULT_BASE = "https://api.tailscale.com/api/v2";

const deviceSchema = z.object({
  id: z.string().optional(),
  nodeId: z.string().optional(),
  name: z.string().optional(),
  hostname: z.string().optional(),
  addresses: z.array(z.string()).default([]),
  os: z.string().optional(),
  user: z.string().optional(),
  lastSeen: z.string().optional(),
  authorized: z.boolean().optional(),
  isExternal: z.boolean().optional(),
  keyExpiryDisabled: z.boolean().optional(),
  expires: z.string().optional(),
  created: z.string().optional(),
  tags: z.array(z.string()).default([]),
  advertisedRoutes: z.array(z.string()).optional(),
  enabledRoutes: z.array(z.string()).optional(),
  clientVersion: z.string().optional(),
  updateAvailable: z.boolean().optional(),
});
const deviceListSchema = z.object({ devices: z.array(deviceSchema) });

function request(ctx: ConnectorContext, path: string) {
  const config = tailscaleConfigSchema.parse(ctx.config);
  const secrets = tailscaleSecretsSchema.parse(ctx.secrets);
  const base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  return httpJson(`${base}${path}`, {
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
    secrets: [secrets.apiKey],
    headers: {
      Authorization: `Bearer ${secrets.apiKey}`,
      "User-Agent": "OpenMuse-Connector",
    },
  });
}

function deviceView(device: z.infer<typeof deviceSchema>) {
  return {
    id: device.id ?? device.nodeId ?? null,
    name: device.name ?? null,
    hostname: device.hostname ?? null,
    addresses: device.addresses,
    os: device.os ?? null,
    user: device.user ?? null,
    lastSeen: device.lastSeen ?? null,
    authorized: device.authorized ?? null,
    isExternal: device.isExternal ?? false,
    keyExpiryDisabled: device.keyExpiryDisabled ?? false,
    expires: device.expires ?? null,
    created: device.created ?? null,
    tags: device.tags,
    advertisedRoutes: device.advertisedRoutes ?? [],
    enabledRoutes: device.enabledRoutes ?? [],
    clientVersion: device.clientVersion ?? null,
    updateAvailable: device.updateAvailable ?? false,
  };
}

export function tailscaleAdapter(): ConnectorAdapter {
  const info: ConnectorProviderInfo = {
    provider: "tailscale",
    label: "Tailscale",
    description: "List devices on a Tailscale tailnet.",
    configFields: [
      {
        name: "tailnet",
        label: "Tailnet",
        required: true,
        type: "text",
        description: 'Tailnet name, or "-" for the key\'s default tailnet.',
      },
      {
        name: "baseUrl",
        label: "API base URL",
        required: false,
        type: "url",
        description: "Defaults to https://api.tailscale.com/api/v2.",
      },
    ],
    secretFields: [
      {
        name: "apiKey",
        label: "API access token",
        required: true,
        type: "password",
        description: "tskey-api-… access token or OAuth access token.",
      },
    ],
    operations: [{ name: "devices", description: "List every device in the tailnet.", params: [] }],
  };
  const devicesPath = (ctx: ConnectorContext) =>
    `/tailnet/${encodeURIComponent(tailscaleConfigSchema.parse(ctx.config).tailnet)}/devices?fields=all`;
  return {
    info,
    async test(ctx) {
      try {
        const tailnet = tailscaleConfigSchema.parse(ctx.config).tailnet;
        const result = deviceListSchema.parse(await request(ctx, devicesPath(ctx)));
        return {
          ok: true,
          detail: `Tailnet ${tailnet}: ${result.devices.length} device${result.devices.length === 1 ? "" : "s"}`,
        };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : "Tailscale check failed",
        };
      }
    },
    async run(ctx, operation) {
      if (operation !== "devices")
        throw new ConnectorError(
          `Unsupported Tailscale operation: ${operation}`,
          undefined,
          "malformed",
        );
      const result = deviceListSchema.parse(await request(ctx, devicesPath(ctx)));
      return { devices: result.devices.map(deviceView) };
    },
  };
}
