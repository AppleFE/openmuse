import { z } from "zod";
import {
  type ConnectorProviderInfo,
  proxmoxConfigSchema,
  proxmoxSecretsSchema,
} from "../../../domain/src/connectors.ts";
import {
  type ConnectorWriteInput,
  proxmoxOperationLabels,
  proxmoxReadParams,
  proxmoxWriteParams,
  proxmoxWriteSchema,
} from "../../../domain/src/proxmox.ts";
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
  const request = (
    path: string,
    method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
    form?: Record<string, string | number | boolean | undefined>,
  ) =>
    httpJson(`${base}${path}`, {
      method,
      form,
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      secrets: [secrets.tokenId, secrets.tokenSecret],
      tls: {
        ca: config.ca,
        rejectUnauthorized: config.verifyTls === false ? false : undefined,
      },
      headers: {
        Authorization: `PVEAPIToken=${secrets.tokenId}=${secrets.tokenSecret}`,
      },
    });
  return { get: (path: string) => request(path), request };
}

const segment = encodeURIComponent;
function query(path: string, params: Record<string, unknown>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined)
      search.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  return `${path}${search.size ? `?${search}` : ""}`;
}
function safeData(value: unknown, ctx: ConnectorContext): unknown {
  if (typeof value === "string") {
    let clean = value;
    // Token IDs are public identifiers embedded in usable provider UPIDs.
    for (const [key, secret] of Object.entries(ctx.secrets))
      if (key !== "tokenId" && typeof secret === "string" && secret)
        clean = clean
          .split(secret)
          .join("[redacted]")
          .split(encodeURIComponent(secret))
          .join("[redacted]");
    return clean;
  }
  if (Array.isArray(value)) return value.map((v) => safeData(v, ctx));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        /^(password|cipassword|token|secret|private[-_]?key|keyring|encryption-key)$/i.test(key)
          ? "[redacted]"
          : safeData(v, ctx),
      ]),
    );
  return value;
}
const record = z.record(z.string(), z.unknown());
const operationDescriptions: Record<string, string> = {
  permissions:
    "Read the current token's effective ACL privileges. Optional path filters the result. Empty permissions explain filtered empty storage/guest lists; the query cannot grant privileges.",
  storages:
    "List node storage capacity, availability, backend and content types. Omit node to aggregate online cluster nodes; failures are reported per node.",
  storage_config:
    "Read storage configuration, excluding credentials. Omit storage to list all configured backends.",
  storage_content:
    "List ISO images, container templates, VM volumes and backups on a node storage.",
  guest_config:
    "Read VM/LXC configuration including CPU, memory, disks, network and digest; passwords are redacted.",
  tasks: "List provider tasks with UPID, status and timestamps. Supports start/limit pagination.",
  task_status:
    "Read a provider UPID status. Only status=stopped and exitstatus=OK confirms successful completion.",
  task_log: "Read provider task log lines with start/limit pagination.",
  guest_config_update:
    "Update selected VM/LXC settings. The reviewed digest fences concurrent changes. Settings accept CPU/memory/onboot/tags/description and indexed disks/network; passwords, hooks and arbitrary QEMU args are not accepted.",
  guest_create:
    "Create a VM or LXC. LXC settings require ostemplate and support rootfs/storage/ssh-public-keys; VM settings support scsi0/net0/boot/bios. No passwords or host hooks.",
  guest_power:
    "Start, gracefully shut down, reboot, stop, suspend or resume a VM/LXC. timeout is optional only for shutdown/reboot.",
  guest_delete: "Delete the selected VM/LXC. purge and deleteUnreferencedDisks are opt-in.",
  snapshot_rollback: "Restore the saved snapshot of the selected VM/LXC.",
  backup:
    "Submit a single-guest vzdump backup to a selected storage. Existing backups are never removed by this operation.",
  restore:
    "Restore a backup volume as the selected VM/LXC. force is opt-in when replacing an existing guest.",
  storage_config_update:
    "Change content/nodes/disable/shared/prune-backups with a reviewed configuration digest.",
  storage_delete:
    "Remove a storage configuration; does not erase the underlying filesystem or disks.",
  storage_download:
    "Download an ISO or LXC template URL to storage. Remote HTTPS certificate verification stays enabled; optional SHA-256 checksum.",
};

function operations() {
  return [
    ...Object.entries(proxmoxReadParams).map(([name, schema]) => ({
      name,
      schema,
      kind: "read" as const,
    })),
    ...Object.entries(proxmoxWriteParams).map(([name, schema]) => ({
      name,
      schema,
      kind: "write" as const,
    })),
  ].map(({ name, schema, kind }) => {
    const paramsSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    const properties = paramsSchema.properties as
      | Record<string, { type?: string; enum?: string[] }>
      | undefined;
    const required = paramsSchema.required as string[] | undefined;
    return {
      name,
      kind,
      label: proxmoxOperationLabels[name],
      description: operationDescriptions[name] ?? proxmoxOperationLabels[name],
      paramsSchema,
      params: Object.entries(properties ?? {}).map(([key, spec]) => ({
        name: key,
        type:
          spec.type === "boolean"
            ? ("boolean" as const)
            : spec.type === "integer" || spec.type === "number"
              ? ("number" as const)
              : spec.type === "string"
                ? ("string" as const)
                : ("json" as const),
        required: required?.includes(key),
        enum: spec.enum,
        description: key,
      })),
    };
  });
}

function storageView(value: Record<string, unknown>, node?: string) {
  return {
    ...value,
    ...(node ? { node } : {}),
    totalBytes: value.total ?? null,
    usedBytes: value.used ?? null,
    availableBytes: value.avail ?? null,
    contentTypes: typeof value.content === "string" ? value.content.split(",") : [],
    active: value.active === 1 || value.active === true,
    enabled: value.enabled === 1 || value.enabled === true,
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
    storage: resource.storage ?? null,
    content: resource.content ?? null,
    shared: resource.shared === 1,
    pluginType: resource.plugintype ?? null,
  };
}

export function proxmoxAdapter(): ConnectorAdapter {
  const info: ConnectorProviderInfo = {
    provider: "proxmox",
    label: "Proxmox VE",
    description:
      "Manage nodes, storage, VMs, containers, snapshots, backups and provider tasks with a Proxmox VE API token.",
    configFields: [
      {
        name: "baseUrl",
        label: "API URL",
        required: true,
        type: "url",
        description: "For example https://pve.example.com:8006.",
      },
      {
        name: "verifyTls",
        label: "Verify TLS",
        required: false,
        type: "boolean",
        description: "Disable only for self-signed lab deployments.",
      },
      {
        name: "ca",
        label: "CA certificate (PEM)",
        required: false,
        type: "text",
        description:
          "For the default Proxmox certificate, paste /etc/pve/pve-root-ca.pem from the Proxmox host, including BEGIN/END CERTIFICATE lines.",
      },
    ],
    secretFields: [
      {
        name: "tokenId",
        label: "API token id",
        required: true,
        type: "password",
        description: "user@realm!tokenname, for example monitoring@pve!openmuse.",
      },
      {
        name: "tokenSecret",
        label: "API token secret",
        required: true,
        type: "password",
        description: "UUID shown once when the token is created.",
      },
    ],
    operations: operations(),
  };
  return {
    info,
    async test(ctx) {
      try {
        const api = client(ctx);
        const version = data(
          z.object({ version: z.string(), release: z.string().optional() }),
        ).parse(await api.get("/version"));
        // /version can be public; an authenticated request must also succeed.
        data(z.array(nodeSchema)).parse(await api.get("/nodes"));
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
      const schema = proxmoxReadParams[operation as keyof typeof proxmoxReadParams];
      if (!schema)
        throw new ConnectorError(
          `Unsupported Proxmox read operation: ${operation}`,
          undefined,
          "malformed",
        );
      params = schema.parse(params);
      const nodePath = `/nodes/${segment(String(params.node))}`;
      const guestPath = `${nodePath}/${params.kind}/${params.vmid}`;
      const storagePath = `${nodePath}/storage/${segment(String(params.storage))}`;
      const readObject = async (path: string) => safeData(data(record).parse(await get(path)), ctx);
      const readList = async (path: string) =>
        safeData(data(z.array(record)).parse(await get(path)), ctx);
      switch (operation) {
        case "permissions":
          return {
            permissions: await readObject(query("/access/permissions", { path: params.path })),
          };
        case "node_status":
          return { node: params.node, status: await readObject(`${nodePath}/status`) };
        case "node_network":
          return { node: params.node, interfaces: await readList(`${nodePath}/network`) };
        case "node_disks":
          return { node: params.node, disks: await readList(`${nodePath}/disks/list`) };
        case "storages": {
          const read = async (node: string) =>
            data(z.array(record))
              .parse(
                await get(query(`/nodes/${segment(node)}/storage`, { content: params.content })),
              )
              .map((s) => storageView(s, node));
          if (params.node) return { storages: safeData(await read(String(params.node)), ctx) };
          const nodes = data(z.array(nodeSchema).max(128)).parse(await get("/nodes"));
          const results = await Promise.all(
            nodes
              .filter((n) => n.status !== "offline")
              .map(async (n) => {
                try {
                  return { node: n.node, storages: await read(n.node) };
                } catch (error) {
                  ctx.signal?.throwIfAborted();
                  return {
                    node: n.node,
                    storages: [],
                    error: error instanceof Error ? error.message : "Storage query failed",
                  };
                }
              }),
          );
          return safeData(
            {
              storages: results.flatMap((r) => r.storages),
              errors: results.filter((r) => r.error).map((r) => ({ node: r.node, error: r.error })),
              offlineNodes: nodes.filter((n) => n.status === "offline").map((n) => n.node),
            },
            ctx,
          );
        }
        case "storage_config":
          return {
            storages: params.storage
              ? [await readObject(`/storage/${segment(String(params.storage))}`)]
              : await readList("/storage"),
          };
        case "storage_status":
          return safeData(
            {
              node: params.node,
              storage: params.storage,
              status: storageView(
                data(record).parse(await get(`${storagePath}/status`)),
                String(params.node),
              ),
            },
            ctx,
          );
        case "storage_content":
          return {
            node: params.node,
            storage: params.storage,
            volumes: await readList(query(`${storagePath}/content`, { content: params.content })),
          };
        case "guest_status":
          return {
            node: params.node,
            vmid: params.vmid,
            kind: params.kind,
            status: await readObject(`${guestPath}/status/current`),
          };
        case "guest_config":
          return {
            node: params.node,
            vmid: params.vmid,
            kind: params.kind,
            config: await readObject(`${guestPath}/config`),
          };
        case "snapshots":
          return { snapshots: await readList(`${guestPath}/snapshot`) };
        case "tasks":
          return {
            tasks: await readList(
              query(`${nodePath}/tasks`, {
                start: params.start,
                limit: params.limit ?? 100,
                source: params.source,
                vmid: params.vmid,
              }),
            ),
          };
        case "task_status":
          return {
            task: await readObject(`${nodePath}/tasks/${segment(String(params.upid))}/status`),
          };
        case "task_log":
          return {
            lines: await readList(
              query(`${nodePath}/tasks/${segment(String(params.upid))}/log`, {
                start: params.start,
                limit: params.limit ?? 100,
              }),
            ),
          };
        case "next_id":
          return {
            vmid: data(z.union([z.number(), z.string()]).transform(Number)).parse(
              await get("/cluster/nextid"),
            ),
          };
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
    async write(ctx, raw: ConnectorWriteInput) {
      const input = proxmoxWriteSchema.parse({ operation: raw.operation, params: raw.params });
      const p = input.params;
      const node = "node" in p ? p.node : undefined;
      const nodePath = `/nodes/${segment(node ?? "")}`;
      const guestPath = "kind" in p ? `${nodePath}/${p.kind}/${p.vmid}` : "";
      const api = client(ctx);
      let path: string;
      let method: "POST" | "PUT" | "DELETE" = "POST";
      let form: Record<string, string | number | boolean | undefined> = {};
      switch (input.operation) {
        case "guest_power":
          path = `${guestPath}/status/${input.params.action}`;
          form = { timeout: input.params.timeout };
          break;
        case "guest_config_update":
          path = `${guestPath}/config`;
          method = "PUT";
          form = { ...input.params.settings, digest: input.params.digest };
          break;
        case "guest_create":
          path = `${nodePath}/${input.params.kind}`;
          form = {
            vmid: input.params.vmid,
            ...(input.params.kind === "lxc" ? { unprivileged: true } : {}),
            ...input.params.settings,
          };
          break;
        case "guest_clone":
          path = `${guestPath}/clone`;
          form = {
            newid: input.params.newid,
            [input.params.kind === "qemu" ? "name" : "hostname"]: input.params.name,
            full: input.params.full,
            target: input.params.target,
            storage: input.params.storage,
          };
          break;
        case "guest_migrate":
          path = `${guestPath}/migrate`;
          form = {
            target: input.params.target,
            [input.params.kind === "qemu" ? "online" : "restart"]: input.params.online,
            "target-storage": input.params.targetStorage,
          };
          break;
        case "guest_delete":
          path = guestPath;
          method = "DELETE";
          form = {
            purge: input.params.purge,
            "destroy-unreferenced-disks": input.params.deleteUnreferencedDisks,
          };
          break;
        case "snapshot_create":
          path = `${guestPath}/snapshot`;
          form = {
            snapname: input.params.snapshot,
            description: input.params.description,
            vmstate: input.params.vmstate,
          };
          break;
        case "snapshot_delete":
          path = `${guestPath}/snapshot/${segment(input.params.snapshot)}`;
          method = "DELETE";
          break;
        case "snapshot_rollback":
          path = `${guestPath}/snapshot/${segment(input.params.snapshot)}/rollback`;
          break;
        case "backup":
          path = `${nodePath}/vzdump`;
          form = {
            vmid: input.params.vmid,
            storage: input.params.storage,
            mode: input.params.mode ?? "snapshot",
            compress: input.params.compress ?? "zstd",
            remove: false,
          };
          break;
        case "restore":
          path = `${nodePath}/${input.params.kind}`;
          form = {
            vmid: input.params.vmid,
            [input.params.kind === "qemu" ? "archive" : "ostemplate"]: input.params.archive,
            ...(input.params.kind === "lxc" ? { restore: true } : {}),
            storage: input.params.storage,
            force: input.params.force,
          };
          break;
        case "storage_config_update":
          path = `/storage/${segment(input.params.storage)}`;
          method = "PUT";
          form = { ...input.params.settings, digest: input.params.digest };
          break;
        case "storage_content_delete":
          path = `${nodePath}/storage/${segment(input.params.storage)}/content/${segment(input.params.volume)}`;
          method = "DELETE";
          break;
        case "storage_download":
          path = `${nodePath}/storage/${segment(input.params.storage)}/download-url`;
          form = {
            url: input.params.url,
            filename: input.params.filename,
            content: input.params.content,
            checksum: input.params.checksum,
            ...(input.params.checksum ? { "checksum-algorithm": "sha256" } : {}),
            "verify-certificates": true,
          };
          break;
        case "storage_create":
          path = "/storage";
          form = { ...input.params };
          break;
        case "storage_delete":
          path = `/storage/${segment(input.params.storage)}`;
          method = "DELETE";
          break;
      }
      const response = await api.request(
        method === "DELETE" ? query(path, form) : path,
        method,
        method === "DELETE" ? undefined : form,
      );
      const receipt = data(z.union([z.string(), z.null()])).safeParse(response);
      if (!receipt.success || (receipt.data !== null && !receipt.data.startsWith("UPID:")))
        throw new ConnectorError(
          "Provider accepted a write but returned an unrecognized receipt; inspect provider tasks before retrying",
          undefined,
          "outcome_unknown",
        );
      return {
        operation: input.operation,
        node,
        status: receipt.data ? "submitted" : "completed",
        upid: receipt.data,
        completion: receipt.data
          ? "Query task_status; only stopped with exitstatus OK confirms completion."
          : "The synchronous API operation completed.",
      };
    },
  };
}
