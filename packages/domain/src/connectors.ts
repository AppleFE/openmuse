import { z } from "zod";

/**
 * Connector contract for third-party infrastructure providers (GitHub,
 * Tailscale, Headscale, WireGuard, Proxmox). Shared by the server management
 * API, provider adapters, and agent tools. Secret material is accepted on
 * write but is never returned in any view type.
 */
export const connectorProviderSchema = z.enum([
  "github",
  "tailscale",
  "headscale",
  "wireguard",
  "proxmox",
]);
export type ConnectorProvider = z.infer<typeof connectorProviderSchema>;

const nameSchema = z.string().trim().min(1).max(120);
const httpUrl = z
  .url()
  .max(2048)
  .refine((value) => /^https?:/i.test(value), "Use an http or https URL");
const interfaceName = z
  .string()
  .regex(/^[a-zA-Z0-9_.:-]{1,32}$/, "Use a WireGuard interface name such as wg0");

/** Public, secret-free per-provider configuration stored on the connection. */
export const githubConfigSchema = z.object({
  baseUrl: httpUrl.optional(),
});
export const tailscaleConfigSchema = z.object({
  tailnet: z.string().trim().min(1).max(160),
  baseUrl: httpUrl.optional(),
});
export const headscaleConfigSchema = z.object({
  baseUrl: httpUrl,
});
export const wireguardConfigSchema = z.object({
  wgPath: z.string().trim().min(1).max(1024).optional(),
  interface: interfaceName.optional(),
});
export const proxmoxConfigSchema = z.object({
  baseUrl: httpUrl,
  verifyTls: z.boolean().default(true),
  ca: z.string().max(16384).optional(),
});
export type GithubConfig = z.infer<typeof githubConfigSchema>;
export type TailscaleConfig = z.infer<typeof tailscaleConfigSchema>;
export type HeadscaleConfig = z.infer<typeof headscaleConfigSchema>;
export type WireguardConfig = z.infer<typeof wireguardConfigSchema>;
export type ProxmoxConfig = z.infer<typeof proxmoxConfigSchema>;

/** Secret material accepted on create/update; stored encrypted, never returned. */
export const githubSecretsSchema = z.object({ token: z.string().min(1).max(512) });
export const tailscaleSecretsSchema = z.object({ apiKey: z.string().min(1).max(512) });
export const headscaleSecretsSchema = z.object({ apiKey: z.string().min(1).max(512) });
export const wireguardSecretsSchema = z.record(z.string(), z.never()).optional();
export const proxmoxSecretsSchema = z.object({
  tokenId: z.string().regex(/^[^\s!@]+@[^\s!@]+![^\s!@]+$/, "Use a token id like user@pam!name"),
  tokenSecret: z.string().min(1).max(512),
});
export type GithubSecrets = z.infer<typeof githubSecretsSchema>;
export type TailscaleSecrets = z.infer<typeof tailscaleSecretsSchema>;
export type HeadscaleSecrets = z.infer<typeof headscaleSecretsSchema>;
export type ProxmoxSecrets = z.infer<typeof proxmoxSecretsSchema>;

/** Create payloads are discriminated on provider so config and secrets validate together. */
export const connectorCreateSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("github"),
    name: nameSchema,
    config: githubConfigSchema.default({}),
    secrets: githubSecretsSchema,
  }),
  z.object({
    provider: z.literal("tailscale"),
    name: nameSchema,
    config: tailscaleConfigSchema,
    secrets: tailscaleSecretsSchema,
  }),
  z.object({
    provider: z.literal("headscale"),
    name: nameSchema,
    config: headscaleConfigSchema,
    secrets: headscaleSecretsSchema,
  }),
  z.object({
    provider: z.literal("wireguard"),
    name: nameSchema,
    config: wireguardConfigSchema.default({}),
    secrets: wireguardSecretsSchema,
  }),
  z.object({
    provider: z.literal("proxmox"),
    name: nameSchema,
    config: proxmoxConfigSchema,
    secrets: proxmoxSecretsSchema,
  }),
]);
export type ConnectorCreateInput = z.infer<typeof connectorCreateSchema>;

/** Updates replace whole config/secret groups; secrets: null clears stored secrets. */
export const connectorUpdateSchema = z.object({
  name: nameSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.unknown()).nullish(),
});
export type ConnectorUpdateInput = z.infer<typeof connectorUpdateSchema>;

/** Read-only operations each provider supports. */
export const connectorOperations = {
  github: ["repos", "issues", "pulls"],
  tailscale: ["devices"],
  headscale: ["devices"],
  wireguard: ["status"],
  proxmox: ["nodes", "vms", "containers", "resources"],
} as const satisfies Record<ConnectorProvider, readonly string[]>;

export const connectorQuerySchema = z.object({
  operation: z.string().trim().min(1).max(60),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type ConnectorQuery = z.infer<typeof connectorQuerySchema>;

export interface ConnectorCheck {
  ok: boolean;
  detail: string;
  checkedAt: string;
}

/** Persisted record. `secret` holds the encrypted secret envelope, never plaintext. */
export interface StoredConnector {
  id: string;
  provider: ConnectorProvider;
  name: string;
  config: Record<string, unknown>;
  secret: string | null;
  check?: ConnectorCheck;
  createdAt: string;
  updatedAt: string;
}

/** API-facing connection view: redacted, secret-free. */
export interface ConnectorView {
  id: string;
  provider: ConnectorProvider;
  name: string;
  config: Record<string, unknown>;
  hasSecret: boolean;
  check?: ConnectorCheck;
  createdAt: string;
  updatedAt: string;
}

/** Provider metadata describing the JSON management contract to clients. */
export interface ConnectorFieldInfo {
  name: string;
  label: string;
  required: boolean;
  description?: string;
}
export interface ConnectorOperationParam {
  name: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  description: string;
}
export interface ConnectorOperationInfo {
  name: string;
  description: string;
  params: ConnectorOperationParam[];
}
export interface ConnectorProviderInfo {
  provider: ConnectorProvider;
  label: string;
  description: string;
  configFields: ConnectorFieldInfo[];
  secretFields: ConnectorFieldInfo[];
  operations: ConnectorOperationInfo[];
}
