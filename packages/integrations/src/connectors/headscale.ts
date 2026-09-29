import { z } from "zod";
import {
  type ConnectorProviderInfo,
  headscaleConfigSchema,
  headscaleSecretsSchema,
} from "../../../domain/src/connectors.ts";
import { ConnectorError, httpJson } from "./http.ts";
import type { ConnectorAdapter, ConnectorContext } from "./types.ts";

const nodeSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
  givenName: z.string().optional(),
  user: z
    .union([
      z.string(),
      z.object({ name: z.string().optional(), id: z.union([z.string(), z.number()]).optional() }),
    ])
    .optional(),
  ipAddresses: z.array(z.string()).default([]),
  lastSeen: z.string().optional(),
  online: z.boolean().optional(),
  expiry: z.string().optional(),
  createdAt: z.string().optional(),
  forcedTags: z.array(z.string()).optional(),
  invalidTags: z.array(z.string()).optional(),
  validTags: z.array(z.string()).optional(),
  approvedRoutes: z.array(z.string()).optional(),
  availableRoutes: z.array(z.string()).optional(),
  subnetRoutes: z.array(z.string()).optional(),
});

function nodeView(node: z.infer<typeof nodeSchema>) {
  const user = typeof node.user === "string" ? node.user : (node.user?.name ?? null);
  return {
    id: node.id === undefined ? null : String(node.id),
    name: node.name ?? null,
    givenName: node.givenName ?? null,
    user,
    ipAddresses: node.ipAddresses,
    lastSeen: node.lastSeen ?? null,
    online: node.online ?? false,
    expiry: node.expiry ?? null,
    createdAt: node.createdAt ?? null,
    tags: [...(node.forcedTags ?? []), ...(node.validTags ?? [])],
    approvedRoutes: node.approvedRoutes ?? node.subnetRoutes ?? [],
    availableRoutes: node.availableRoutes ?? [],
  };
}

async function fetchNodes(ctx: ConnectorContext) {
  const config = headscaleConfigSchema.parse(ctx.config);
  const secrets = headscaleSecretsSchema.parse(ctx.secrets);
  const base = config.baseUrl.replace(/\/+$/, "");
  const options = {
    timeoutMs: ctx.timeoutMs,
    secrets: [secrets.apiKey],
    headers: { Authorization: `Bearer ${secrets.apiKey}` },
  };
  try {
    const parsed = z
      .object({ nodes: z.array(nodeSchema) })
      .parse(await httpJson(`${base}/api/v1/node`, options));
    return parsed.nodes;
  } catch (error) {
    // Headscale <= 0.22 exposed /api/v1/machine instead of /api/v1/node.
    if (!(error instanceof ConnectorError && error.status === 404)) throw error;
    const parsed = z
      .object({ machines: z.array(nodeSchema) })
      .parse(await httpJson(`${base}/api/v1/machine`, options));
    return parsed.machines;
  }
}

export function headscaleAdapter(): ConnectorAdapter {
  const info: ConnectorProviderInfo = {
    provider: "headscale",
    label: "Headscale",
    description: "List nodes on a self-hosted Headscale coordination server.",
    configFields: [
      {
        name: "baseUrl",
        label: "Server URL",
        required: true,
        description: "Headscale base URL, for example https://headscale.example.com.",
      },
    ],
    secretFields: [
      {
        name: "apiKey",
        label: "API key",
        required: true,
        description: "Created with `headscale apikeys create`.",
      },
    ],
    operations: [
      { name: "devices", description: "List every node registered in Headscale.", params: [] },
    ],
  };
  return {
    info,
    async test(ctx) {
      try {
        const nodes = await fetchNodes(ctx);
        return {
          ok: true,
          detail: `Headscale reachable: ${nodes.length} node${nodes.length === 1 ? "" : "s"}`,
        };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : "Headscale check failed",
        };
      }
    },
    async run(ctx, operation) {
      if (operation !== "devices")
        throw new ConnectorError(
          `Unsupported Headscale operation: ${operation}`,
          undefined,
          "malformed",
        );
      return { devices: (await fetchNodes(ctx)).map(nodeView) };
    },
  };
}
