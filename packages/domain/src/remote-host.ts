import { z } from "zod";

const cleanText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !v.includes("\0"));
export const remoteHostConfigSchema = z
  .strictObject({
    mode: z.enum(["agent", "ssh"]).default("agent"),
    platform: z.enum(["linux", "windows", "macos"]).default("linux"),
    allowAgentShell: z.boolean().default(false),
    baseUrl: z
      .url()
      .max(2048)
      .refine((v) => {
        const u = new URL(v);
        return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
      }, "인증 정보 없는 HTTP(S) 에이전트 주소를 입력하세요")
      .optional(),
    host: z
      .string()
      .regex(/^[a-zA-Z0-9.:[\]_-]{1,253}$/)
      .optional(),
    port: z.coerce.number().int().min(1).max(65535).default(22),
    username: z
      .string()
      .regex(/^[a-zA-Z0-9_.@\\-]{1,128}$/)
      .optional(),
    hostFingerprint: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/)
      .optional(),
  })
  .superRefine((v, c) => {
    if (v.mode === "agent" && !v.baseUrl)
      c.addIssue({ code: "custom", path: ["baseUrl"], message: "에이전트 주소가 필요합니다" });
    if (v.mode === "ssh")
      for (const key of ["host", "username", "hostFingerprint"] as const)
        if (!v[key])
          c.addIssue({ code: "custom", path: [key], message: `SSH ${key}가 필요합니다` });
  });
export const remoteHostSecretsSchema = z
  .strictObject({
    token: z.string().min(32).max(512).optional(),
    privateKey: z.string().min(32).max(32768).optional(),
    passphrase: z.string().min(1).max(1024).optional(),
  })
  .refine((v) => !!v.token || !!v.privateKey, "에이전트 토큰 또는 SSH 개인 키가 필요합니다");
export type RemoteHostConfig = z.infer<typeof remoteHostConfigSchema>;
export type RemoteHostSecrets = z.infer<typeof remoteHostSecretsSchema>;

export const remoteCommandSchema = z.strictObject({
  command: cleanText(16000),
  cwd: cleanText(2048).optional(),
  timeoutSeconds: z.number().int().min(1).max(86400).default(3600),
  pty: z.boolean().default(false),
});
const jobId = z.uuid();
export const remoteReadSchemas = {
  host_status: z.strictObject({}),
  host_jobs: z.strictObject({}),
  host_job: z.strictObject({ jobId }),
};
export const remoteWriteSchemas = {
  host_command: remoteCommandSchema.extend({ jobId: z.uuid().optional() }),
  host_input: z.strictObject({
    jobId,
    text: z
      .string()
      .max(10000)
      .refine((v) => !v.includes("\0")),
  }),
  host_stop: z.strictObject({ jobId }),
};
export const remoteReadOperations = Object.keys(
  remoteReadSchemas,
) as (keyof typeof remoteReadSchemas)[];
export const remoteWriteOperations = Object.keys(
  remoteWriteSchemas,
) as (keyof typeof remoteWriteSchemas)[];
export const remoteOperationLabels: Record<string, string> = {
  host_status: "호스트 상태",
  host_jobs: "셸 작업 목록",
  host_job: "셸 작업 출력",
  host_command: "원격 명령 실행",
  host_input: "실행 중인 작업에 입력",
  host_stop: "원격 작업 중지",
};
export function parseRemoteOperation(operation: string, params: unknown, write = false) {
  const schemas: Record<string, z.ZodType> = write ? remoteWriteSchemas : remoteReadSchemas;
  const schema = schemas[operation];
  if (!schema) throw new Error("지원하지 않는 원격 호스트 작업입니다");
  return schema.parse(params) as Record<string, unknown>;
}
export interface RemoteJob {
  id: string;
  command: string;
  cwd?: string;
  pty: boolean;
  status: "running" | "stopping" | "succeeded" | "failed" | "stopped" | "timed_out" | "interrupted";
  output: string;
  outputTruncated: boolean;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface RemoteHostStatus {
  hostname: string;
  platform: string;
  arch: string;
  shell: string;
  capabilities: { shell: boolean; browser: boolean; pty: boolean; desktop: boolean };
}
export const remoteHostStatusSchema = z.object({
  hostname: z.string().min(1).max(253),
  platform: z.string().min(1).max(64),
  arch: z.string().min(1).max(64),
  shell: z.string().min(1).max(2048),
  capabilities: z.object({
    shell: z.boolean(),
    browser: z.boolean(),
    pty: z.boolean(),
    desktop: z.boolean(),
  }),
});
export const browserInputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("click"),
    x: z.number().int().min(0).max(1279),
    y: z.number().int().min(0).max(799),
  }),
  z.strictObject({ type: z.literal("text"), text: z.string().max(10000) }),
  z.strictObject({
    type: z.literal("key"),
    key: z.enum([
      "Enter",
      "Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Control+a",
      "Meta+a",
      "Shift+Tab",
    ]),
  }),
  z.strictObject({ type: z.literal("scroll"), deltaY: z.number().int().min(-5000).max(5000) }),
]);
