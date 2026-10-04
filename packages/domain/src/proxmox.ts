import { z } from "zod";
import { githubWriteOperations, parseGithubWrite } from "./github.ts";
import { parseRemoteOperation, remoteWriteOperations } from "./remote-host.ts";

const node = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/, "Use a Proxmox node name");
const storage = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, "Use a Proxmox storage ID");
const vmid = z.number().int().min(100).max(999999999);
const kind = z.enum(["qemu", "lxc"]);
const snapshot = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/)
  .refine((v) => v !== "current", "current is not a saved snapshot");
const volume = z
  .string()
  .min(3)
  .max(1024)
  .refine(
    (v) =>
      /^[a-zA-Z][a-zA-Z0-9_-]*:.+/.test(v) &&
      !v.includes("..") &&
      !v.includes("\0") &&
      !/[\r\n]/.test(v),
    "Use a Proxmox volume ID",
  );
const text = z.string().max(8192);
const value = z.union([text, z.number().finite(), z.boolean()]);
const settings = z
  .record(z.string(), value)
  .refine(
    (v) => Object.keys(v).length > 0 && Object.keys(v).length <= 64,
    "Supply between 1 and 64 settings",
  );
const guest = z.strictObject({ node, kind, vmid });
const digest = z
  .string()
  .regex(/^[a-fA-F0-9]{40,64}$/)
  .optional();
const page = {
  start: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
};

export const proxmoxReadParams = {
  nodes: z.strictObject({}),
  permissions: z.strictObject({
    path: z
      .string()
      .max(1024)
      .regex(/^\/[a-zA-Z0-9_./-]*$/)
      .refine((v) => !v.includes(".."), "Use an ACL path")
      .optional(),
  }),
  vms: z.strictObject({ node: node.optional() }),
  containers: z.strictObject({ node: node.optional() }),
  resources: z.strictObject({
    node: node.optional(),
    type: z.enum(["vm", "node", "storage", "sdn", "pool"]).optional(),
  }),
  node_status: z.strictObject({ node }),
  node_network: z.strictObject({ node }),
  node_disks: z.strictObject({ node }),
  storages: z.strictObject({
    node: node.optional(),
    content: z
      .enum(["images", "rootdir", "iso", "vztmpl", "backup", "snippets", "import"])
      .optional(),
  }),
  storage_config: z.strictObject({ storage: storage.optional() }),
  storage_status: z.strictObject({ node, storage }),
  storage_content: z.strictObject({
    node,
    storage,
    content: z
      .enum(["images", "rootdir", "iso", "vztmpl", "backup", "snippets", "import"])
      .optional(),
  }),
  guest_status: guest,
  guest_config: guest,
  snapshots: guest,
  tasks: z.strictObject({
    node,
    ...page,
    source: z.enum(["archive", "active", "all"]).optional(),
    vmid: vmid.optional(),
  }),
  task_status: z.strictObject({
    node,
    upid: z
      .string()
      .regex(/^UPID:[^/\r\n]+:$/)
      .refine((v) => !v.includes("\0"))
      .max(1024),
  }),
  task_log: z.strictObject({
    node,
    upid: z
      .string()
      .regex(/^UPID:[^/\r\n]+:$/)
      .refine((v) => !v.includes("\0"))
      .max(1024),
    ...page,
  }),
  next_id: z.strictObject({}),
};
export const proxmoxReadOperations = Object.keys(
  proxmoxReadParams,
) as (keyof typeof proxmoxReadParams)[];

const common = new Set([
  "description",
  "cores",
  "memory",
  "onboot",
  "protection",
  "tags",
  "startup",
  "cpuunits",
  "cpulimit",
  "nameserver",
  "searchdomain",
]);
const qemu = new Set([
  "name",
  "sockets",
  "cpu",
  "balloon",
  "boot",
  "bios",
  "machine",
  "ostype",
  "scsihw",
  "agent",
  "numa",
  "hotplug",
  "efidisk0",
  "tpmstate0",
  "ciuser",
  "ciupgrade",
  "serial0",
  "vga",
]);
const lxc = new Set([
  "hostname",
  "swap",
  "rootfs",
  "ostype",
  "unprivileged",
  "timezone",
  "console",
  "tty",
]);
export function validateGuestSettings(
  type: "qemu" | "lxc",
  values: Record<string, unknown>,
  create = false,
): string[] {
  return Object.keys(values).filter(
    (key) =>
      !(
        common.has(key) ||
        (type === "qemu"
          ? qemu.has(key) ||
            /^(net|scsi|sata|ide|virtio|ipconfig)\d+$/.test(key) ||
            key === "sshkeys"
          : lxc.has(key) ||
            /^(net|mp)\d+$/.test(key) ||
            (create && ["ostemplate", "storage", "ssh-public-keys"].includes(key)))
      ),
  );
}
const configUpdate = guest.extend({ settings, digest }).superRefine((v, ctx) => {
  for (const key of validateGuestSettings(v.kind, v.settings))
    ctx.addIssue({
      code: "custom",
      path: ["settings", key],
      message: `Unsupported ${v.kind} setting: ${key}`,
    });
});
const guestCreate = guest.extend({ settings }).superRefine((v, ctx) => {
  for (const key of validateGuestSettings(v.kind, v.settings, true))
    ctx.addIssue({
      code: "custom",
      path: ["settings", key],
      message: `Unsupported ${v.kind} setting: ${key}`,
    });
  if (v.kind === "lxc" && !v.settings.ostemplate)
    ctx.addIssue({
      code: "custom",
      path: ["settings", "ostemplate"],
      message: "LXC creation requires an ostemplate volume",
    });
});
const safeUrl = z
  .url()
  .max(2048)
  .refine((v) => {
    const u = new URL(v);
    return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password;
  }, "Use an http or https URL without credentials");
const storageSettings = z
  .strictObject({
    content: z
      .string()
      .regex(
        /^(images|rootdir|iso|vztmpl|backup|snippets|import)(,(images|rootdir|iso|vztmpl|backup|snippets|import))*$/,
      )
      .optional(),
    nodes: z
      .string()
      .regex(/^[a-zA-Z0-9-]+(,[a-zA-Z0-9-]+)*$/)
      .optional(),
    disable: z.boolean().optional(),
    shared: z.boolean().optional(),
    "prune-backups": z.string().max(500).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Supply at least one storage setting");

export const proxmoxWriteParams = {
  guest_power: guest
    .extend({
      action: z.enum(["start", "shutdown", "reboot", "stop", "suspend", "resume"]),
      timeout: z.number().int().min(1).max(300).optional(),
    })
    .superRefine((v, ctx) => {
      if (v.timeout !== undefined && !["shutdown", "reboot"].includes(v.action))
        ctx.addIssue({
          code: "custom",
          path: ["timeout"],
          message: "timeout is supported for shutdown and reboot",
        });
    }),
  guest_config_update: configUpdate,
  guest_create: guestCreate,
  guest_clone: guest
    .extend({
      newid: vmid,
      name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/),
      full: z.boolean().optional(),
      target: node.optional(),
      storage: storage.optional(),
    })
    .refine((v) => v.vmid !== v.newid, "The clone requires a different VM ID"),
  guest_migrate: guest
    .extend({ target: node, online: z.boolean().optional(), targetStorage: storage.optional() })
    .refine((v) => v.node !== v.target, "Choose a different target node"),
  guest_delete: guest.extend({
    purge: z.boolean().optional(),
    deleteUnreferencedDisks: z.boolean().optional(),
  }),
  snapshot_create: guest
    .extend({ snapshot, description: text.optional(), vmstate: z.boolean().optional() })
    .superRefine((v, ctx) => {
      if (v.kind === "lxc" && v.vmstate !== undefined)
        ctx.addIssue({
          code: "custom",
          path: ["vmstate"],
          message: "LXC snapshots do not accept vmstate",
        });
    }),
  snapshot_delete: guest.extend({ snapshot }),
  snapshot_rollback: guest.extend({ snapshot }),
  backup: z.strictObject({
    node,
    vmid,
    storage,
    mode: z.enum(["snapshot", "suspend", "stop"]).optional(),
    compress: z.enum(["zstd", "gzip", "lzo", "0"]).optional(),
  }),
  restore: guest.extend({
    archive: volume,
    storage: storage.optional(),
    force: z.boolean().optional(),
  }),
  storage_config_update: z.strictObject({ storage, settings: storageSettings, digest }),
  storage_content_delete: z
    .strictObject({ node, storage, volume })
    .refine(
      (v) => v.volume.startsWith(`${v.storage}:`),
      "The volume must belong to the selected storage",
    ),
  storage_download: z.strictObject({
    node,
    storage,
    url: safeUrl,
    filename: z
      .string()
      .regex(/^[^/\\\r\n]{1,255}$/)
      .refine((v) => !v.includes("\0"))
      .refine((v) => v !== "." && v !== ".."),
    content: z.enum(["iso", "vztmpl"]),
    checksum: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
  }),
  storage_create: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("dir"),
      storage,
      path: z.string().startsWith("/").max(1024),
      content: z.string().max(200),
      nodes: z.string().max(512).optional(),
    }),
    z.strictObject({
      type: z.literal("lvmthin"),
      storage,
      vgname: z.string().regex(/^[a-zA-Z0-9_+.-]{1,128}$/),
      thinpool: z.string().regex(/^[a-zA-Z0-9_+.-]{1,128}$/),
      nodes: z.string().max(512).optional(),
    }),
    z.strictObject({
      type: z.literal("zfspool"),
      storage,
      pool: z
        .string()
        .regex(/^[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)*$/)
        .max(512),
      nodes: z.string().max(512).optional(),
    }),
    z.strictObject({
      type: z.literal("nfs"),
      storage,
      server: z.string().regex(/^[a-zA-Z0-9_.:-]{1,253}$/),
      export: z.string().startsWith("/").max(1024),
      content: z.string().max(200),
      nodes: z.string().max(512).optional(),
    }),
  ]),
  storage_delete: z.strictObject({ storage }),
};
export type ProxmoxWriteOperation = keyof typeof proxmoxWriteParams;
export const proxmoxWriteOperations = Object.keys(proxmoxWriteParams) as ProxmoxWriteOperation[];

export const proxmoxWriteSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("guest_power"), params: proxmoxWriteParams.guest_power }),
  z.strictObject({
    operation: z.literal("guest_config_update"),
    params: proxmoxWriteParams.guest_config_update,
  }),
  z.strictObject({ operation: z.literal("guest_create"), params: proxmoxWriteParams.guest_create }),
  z.strictObject({ operation: z.literal("guest_clone"), params: proxmoxWriteParams.guest_clone }),
  z.strictObject({
    operation: z.literal("guest_migrate"),
    params: proxmoxWriteParams.guest_migrate,
  }),
  z.strictObject({ operation: z.literal("guest_delete"), params: proxmoxWriteParams.guest_delete }),
  z.strictObject({
    operation: z.literal("snapshot_create"),
    params: proxmoxWriteParams.snapshot_create,
  }),
  z.strictObject({
    operation: z.literal("snapshot_delete"),
    params: proxmoxWriteParams.snapshot_delete,
  }),
  z.strictObject({
    operation: z.literal("snapshot_rollback"),
    params: proxmoxWriteParams.snapshot_rollback,
  }),
  z.strictObject({ operation: z.literal("backup"), params: proxmoxWriteParams.backup }),
  z.strictObject({ operation: z.literal("restore"), params: proxmoxWriteParams.restore }),
  z.strictObject({
    operation: z.literal("storage_config_update"),
    params: proxmoxWriteParams.storage_config_update,
  }),
  z.strictObject({
    operation: z.literal("storage_content_delete"),
    params: proxmoxWriteParams.storage_content_delete,
  }),
  z.strictObject({
    operation: z.literal("storage_download"),
    params: proxmoxWriteParams.storage_download,
  }),
  z.strictObject({
    operation: z.literal("storage_create"),
    params: proxmoxWriteParams.storage_create,
  }),
  z.strictObject({
    operation: z.literal("storage_delete"),
    params: proxmoxWriteParams.storage_delete,
  }),
]);
export const connectorWriteSchema = z
  .strictObject({
    connectorId: z.string().min(1).max(120),
    operation: z.enum([
      ...proxmoxWriteOperations,
      ...remoteWriteOperations,
      ...githubWriteOperations,
    ] as [string, ...string[]]),
    params: z.record(z.string(), z.unknown()),
  })
  .superRefine((v, ctx) => {
    if (githubWriteOperations.includes(v.operation as (typeof githubWriteOperations)[number])) {
      try {
        parseGithubWrite(v.operation, v.params);
      } catch (error) {
        if (error instanceof z.ZodError)
          for (const issue of error.issues)
            ctx.addIssue({
              code: "custom",
              path: ["params", ...issue.path],
              message: issue.message,
            });
        else ctx.addIssue({ code: "custom", message: "Invalid GitHub operation" });
      }
      return;
    }
    if (remoteWriteOperations.includes(v.operation as (typeof remoteWriteOperations)[number])) {
      try {
        parseRemoteOperation(v.operation, v.params, true);
      } catch (error) {
        if (error instanceof z.ZodError)
          for (const issue of error.issues)
            ctx.addIssue({
              code: "custom",
              path: ["params", ...issue.path],
              message: issue.message,
            });
        else ctx.addIssue({ code: "custom", message: "Invalid remote host operation" });
      }
      return;
    }
    const parsed = proxmoxWriteSchema.safeParse({ operation: v.operation, params: v.params });
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });
export type ConnectorWriteInput = z.infer<typeof connectorWriteSchema>;

export const proxmoxOperationLabels: Record<string, string> = {
  permissions: "토큰 접근 권한",
  nodes: "노드 목록",
  vms: "가상 머신 목록",
  containers: "컨테이너 목록",
  resources: "클러스터 자원",
  node_status: "노드 상태",
  node_network: "네트워크 인터페이스",
  node_disks: "물리 디스크",
  storages: "노드별 스토리지",
  storage_config: "스토리지 설정",
  storage_status: "스토리지 용량",
  storage_content: "스토리지 내용물",
  guest_status: "VM/LXC 상태",
  guest_config: "VM/LXC 설정",
  snapshots: "스냅샷 목록",
  tasks: "작업 목록",
  task_status: "작업 상태",
  task_log: "작업 로그",
  next_id: "다음 VM ID",
  guest_power: "VM/LXC 전원 제어",
  guest_config_update: "VM/LXC 설정 변경",
  guest_create: "VM/LXC 생성",
  guest_clone: "VM/LXC 복제",
  guest_migrate: "VM/LXC 마이그레이션",
  guest_delete: "VM/LXC 삭제",
  snapshot_create: "스냅샷 생성",
  snapshot_delete: "스냅샷 삭제",
  snapshot_rollback: "스냅샷 복원",
  backup: "백업 생성",
  restore: "백업 복원",
  storage_config_update: "스토리지 설정 변경",
  storage_content_delete: "스토리지 볼륨 삭제",
  storage_download: "ISO·템플릿 다운로드",
  storage_create: "스토리지 등록",
  storage_delete: "스토리지 등록 해제",
};
