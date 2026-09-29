import { z } from "zod";
import {
  type ConnectorProviderInfo,
  proxmoxConfigSchema,
  proxmoxSecretsSchema,
} from "../../../domain/src/connectors.ts";
import { ConnectorError, httpJson } from "./http.ts";
import type { ConnectorAdapter, ConnectorContext } from "./types.ts";

const nodeSchema = z.object({
  node: z.string(),
  status: z.string().optional(),
  id: z.string().optional(),
  level: z.string().optional(),
  cpu: z.number().optional(),
  maxcpu: z.number().optional(),
  mem: z.number().optional(),
  maxmem: z.number().optional(),
  disk: z.number().optional(),
  maxdisk: z.number().optional(),
  uptime: z.number().optional(),
  ssl_fingerprint: z.string().optional(),
});
const resourceSchema = z.object({
  id: z.string(),
  type: z.string(),
  node: z.string().optional(),
  vmid: z.number().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  cpu: z.number().optional(),
  maxcpu: z.number().optional(),
  mem: z.number().optional(),
  maxmem: z.number().optional(),
  disk: z.number().optional(),
  maxdisk: z.number().optional(),
  uptime: z.number().optional(),
  template: z.number().optional(),
  pool: z.string().optional(),
  tags: z.string().optional(),
  hastate: z.string().optional(),
  storage: z.string().optional(),
  content: z.string().optional(),
  shared: z.number().optional(),
  plugintype: z.string().optional(),
});
const listParams = z.object({
  node: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/, "Use a Proxmox node name")
    .optional(),
});
const resourcesParams = listParams.extend({
  type: z.enum(["vm", "node", "storage", "sdn", "pool"]).optional(),
});

function client(ctx: ConnectorContext) {
  const config = proxmoxConfigSchema.parse(ctx.config);
  const secrets = proxmoxSecretsSchema.parse(ctx.secrets);
  const base = `${config.baseUrl.replace(/\/+$/, "")}/api2/json`;
  return {
    get: (path: string) =>
      httpJson(`${base}${path}`, {
        timeoutMs: ctx.timeoutMs,
        secrets: [secrets.tokenId, secrets.tokenSecret],
        tls: {
          ca: config.ca,
          rejectUnauthorized: config.verifyTls === false ? false : undefined,
        },
        headers: {
          Authorization: `PVEAPIToken=${secrets.tokenId}=${secrets.tokenSecret}`,
        },
      }),
  };
}

function data<T>(schema: z.ZodType<T>): z.ZodType<T> {
  return z.object({ data: schema }).transform((envelope) => envelope.data);
}

function resourceView(resource: z.infer<typeof resourceSchema>) {
  return {
    id: resource.id,
    type: resource.type,
    node: resource.node ?? null,
    vmid: resource.vmid ?? null,
    name: resource.name ?? null,
    status: resource.status ?? null,
    cpu: resource.cpu ?? null,
    maxCpu: resource.maxcpu ?? null,
    mem: resource.mem ?? null,
    maxMem: resource.maxmem ?? null,
    disk: resource.disk ?? null,
    maxDisk: resource.maxdisk ?? null,
    uptime: resource.uptime ?? null,
    template: resource.template === 1,
    pool: resource.pool ?? null,
    tags: resource.tags ? resource.tags.split(/[;,]/).filter(Boolean) : [],
    haState: resource.hastate ?? null,
  };
}

export function proxmoxAdapter(): ConnectorAdapter {
  const info: ConnectorProviderInfo = {
    provider: "proxmox",
    label: "Proxmox VE",
    description: "Read nodes, VMs, containers and cluster resources from a Proxmox VE API token.",
    configFields: [
      {
        name: "baseUrl",
        label: "API URL",
        required: true,
        description: "For example https://pve.example.com:8006.",
      },
      {
        name: "verifyTls",
        label: "Verify TLS",
        required: false,
        description: "Disable only for self-signed lab deployments.",
      },
      {
        name: "ca",
        label: "CA certificate (PEM)",
        required: false,
        description: "Custom CA bundle for self-signed deployments.",
      },
    ],
    secretFields: [
      {
        name: "tokenId",
        label: "API token id",
        required: true,
        description: "user@realm!tokenname, for example monitoring@pve!openmuse.",
      },
      {
        name: "tokenSecret",
        label: "API token secret",
        required: true,
        description: "UUID shown once when the token is created.",
      },
    ],
    operations: [
      { name: "nodes", description: "List cluster nodes with CPU/memory/uptime.", params: [] },
      {
        name: "vms",
        description: "List QEMU virtual machines across all nodes.",
        params: [{ name: "node", type: "string", description: "Limit to one node" }],
      },
      {
        name: "containers",
        description: "List LXC containers across all nodes.",
        params: [{ name: "node", type: "string", description: "Limit to one node" }],
      },
      {
        name: "resources",
        description: "List cluster resources of a given type.",
        params: [
          { name: "type", type: "string", description: "vm, node, storage, sdn or pool" },
          { name: "node", type: "string", description: "Limit to one node" },
        ],
      },
    ],
  };
  return {
    info,
    async test(ctx) {
      try {
        const version = data(
          z.object({ version: z.string(), release: z.string().optional() }),
        ).parse(await client(ctx).get("/version"));
        return { ok: true, detail: `Proxmox VE ${version.version} reachable` };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : "Proxmox check failed",
        };
      }
    },
    async run(ctx, operation, params) {
      const { get } = client(ctx);
      switch (operation) {
        case "nodes": {
          const nodes = data(z.array(nodeSchema)).parse(await get("/nodes"));
          return {
            nodes: nodes.map((node) => ({
              node: node.node,
              status: node.status ?? null,
              id: node.id ?? null,
              cpu: node.cpu ?? null,
              maxCpu: node.maxcpu ?? null,
              mem: node.mem ?? null,
              maxMem: node.maxmem ?? null,
              disk: node.disk ?? null,
              maxDisk: node.maxdisk ?? null,
              uptime: node.uptime ?? null,
            })),
          };
        }
        case "vms":
        case "containers":
        case "resources": {
          const input = resourcesParams.parse(params);
          // PVE's type filter only knows `vm` (qemu+lxc combined); the per-kind
          // split happens locally on the returned resource.type.
          const queryType = operation === "resources" ? input.type : "vm";
          const wanted = operation === "vms" ? "qemu" : operation === "containers" ? "lxc" : null;
          const resources = data(z.array(resourceSchema)).parse(
            await get(`/cluster/resources${queryType ? `?type=${queryType}` : ""}`),
          );
          const filtered = resources.filter(
            (resource) =>
              (!input.node || resource.node === input.node) &&
              (!wanted || resource.type === wanted),
          );
          const key =
            operation === "vms" ? "vms" : operation === "containers" ? "containers" : "resources";
          return { [key]: filtered.map(resourceView) };
        }
        default:
          throw new ConnectorError(
            `Unsupported Proxmox operation: ${operation}`,
            undefined,
            "malformed",
          );
      }
    },
  };
}
