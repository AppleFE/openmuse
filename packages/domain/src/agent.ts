import { z } from "zod";
import type { SkillActivation } from "./skills.ts";
import type { ThreadKnowledge } from "./thread-knowledge.ts";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "scheduled"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";
export interface Evidence {
  id: string;
  kind: "mail" | "file" | "web" | "user";
  title: string;
  excerpt: string;
  url?: string;
}
export interface TaskStep {
  id: string;
  title: string;
  status: "pending" | "running" | "succeeded" | "failed" | "waiting";
  detail?: string;
}
export const modelProviderSchema = z.enum(["openai", "anthropic", "google", "opencodex", "ollama"]);
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export const modelCapabilitySchema = z.enum(["chat", "tools", "vision", "coding"]);
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export type VisionSupport = "supported" | "unsupported" | "unknown";
/** Missing gateway metadata is not evidence that image input is unsupported. */
export function acceptsImageInput(model: {
  capabilities: readonly ModelCapability[];
  visionSupport?: VisionSupport;
}): boolean {
  if (model.visionSupport) return model.visionSupport !== "unsupported";
  return model.capabilities.includes("vision");
}
/** Public, secret-free model metadata returned to clients. */
export interface ModelProfile {
  id: string;
  label: string;
  provider: ModelProvider;
  model: string;
  capabilities: ModelCapability[];
  /** Unknown models may receive images; only positive metadata earns the vision badge. */
  visionSupport?: VisionSupport;
  enabled: boolean;
  /** Enabled with a credential; discovered models must still appear in the provider catalog. */
  available: boolean;
  unavailableReason?: "disabled" | "missing_credentials" | "provider_removed";
}
export interface ModelCatalogStatus {
  enabled: boolean;
  state: "disabled" | "pending" | "ready" | "error";
  refreshIntervalSeconds: number;
  modelCount: number;
  lastAttemptAt?: string;
  lastSyncedAt?: string;
  error?: string;
}
export type ModelSnapshot = Pick<
  ModelProfile,
  "id" | "label" | "provider" | "model" | "capabilities" | "visionSupport"
>;
export interface ModelSelection {
  id: "default";
  modelId: string | null;
  updatedAt: string;
}
export const jevFailModeSchema = z.enum(["closed", "local-budget"]);
export type JevFailMode = z.infer<typeof jevFailModeSchema>;
export const runtimeSettingsPatchSchema = z
  .object({
    jev: z
      .object({
        enabled: z.boolean().optional(),
        apiKey: z.union([z.string().trim().min(8).max(4096), z.null()]).optional(),
        model: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .regex(/^jev[-a-zA-Z0-9._]*$/)
          .optional(),
        failMode: jevFailModeSchema.optional(),
        timeoutMs: z.number().int().min(1000).max(30000).optional(),
      })
      .strict()
      .optional(),
    pi: z
      .object({
        enabled: z.boolean().optional(),
        maxIterations: z.number().int().min(1).max(8).optional(),
        timeoutMs: z
          .number()
          .int()
          .min(5000)
          .max(15 * 60 * 1000)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RuntimeSettingsPatch = z.infer<typeof runtimeSettingsPatchSchema>;
export interface RuntimeSettingsView {
  id: "runtime";
  jev: {
    enabled: boolean;
    configured: boolean;
    model: string;
    failMode: JevFailMode;
    timeoutMs: number;
  };
  pi: { enabled: boolean; maxIterations: number; timeoutMs: number };
  updatedAt: string;
}
export const agentRoleKindSchema = z.enum(["planner", "coder", "reviewer", "custom"]);
export type AgentRoleKind = z.infer<typeof agentRoleKindSchema>;
export interface AgentTeamRole {
  id: string;
  label: string;
  kind: AgentRoleKind;
  modelId: string;
  systemPrompt: string;
  dependsOn: string[];
  /** Immutable, secret-free profile captured when a task is created. */
  modelSnapshot?: ModelSnapshot;
}
export interface AgentTeam {
  id: string;
  name: string;
  description?: string;
  execution: "sequential" | "parallel";
  roles: AgentTeamRole[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}
export type AgentRoleRunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export interface AgentRoleRun {
  roleId: string;
  roleLabel: string;
  modelId: string;
  status: AgentRoleRunStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  output?: string;
  error?: string;
}
export interface AgentTeamTaskContext {
  teamId: string;
  teamRevision: number;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  roles: AgentTeamRole[];
  roleRuns: AgentRoleRun[];
  /** Deterministic dependency-ordered results available to subsequent roles. */
  sharedContext: Record<string, string>;
}
export interface TaskThreadMessage {
  id: string;
  taskId: string;
  role: "assistant";
  roleId: string;
  roleLabel: string;
  modelId: string;
  content: string;
  createdAt: string;
}
export interface AgentTask {
  id: string;
  /** Server-bound origin; model tool arguments cannot set this approval scope. */
  sourceThreadId?: string;
  threadKnowledge?: ThreadKnowledge;
  skill?: SkillActivation;
  title: string;
  prompt: string;
  kind: "agent" | "document" | "monitor" | "finance" | "plan";
  status: TaskStatus;
  goalId?: string;
  /** Snapshotted when the task is created; later default changes do not alter this run. */
  modelId?: string | null;
  /** Immutable, secret-free profile captured when a task is created. */
  modelSnapshot?: ModelSnapshot;
  teamId?: string;
  teamContext?: AgentTeamTaskContext;
  plan: TaskStep[];
  evidence: Evidence[];
  input: Record<string, unknown>;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  leaseId?: string | null;
  leaseUntil?: string | null;
  attempts: number;
  actionId?: string | null;
  result?: string;
  error?: string | null;
  question?: string;
  artifactIds: string[];
}
export interface RunEvent {
  id: string;
  taskId: string;
  date: string;
  kind: "plan" | "step" | "observation" | "approval" | "result" | "error" | "status";
  title: string;
  detail: string;
  roleId?: string;
  roleLabel?: string;
  modelId?: string;
}
export interface Goal {
  id: string;
  title: string;
  description: string;
  category: string;
  status: "active" | "paused" | "completed";
  milestones: { id: string; title: string; done: boolean }[];
  createdAt: string;
}
export interface Monitor {
  id: string;
  taskId: string;
  title: string;
  url: string;
  condition: "change" | "contains" | "price_below";
  value: string;
  intervalMinutes: number;
  status: "active" | "paused" | "stopped";
  nextCheckAt: string;
  lastCheckedAt?: string;
  lastValue?: string;
  lastHash?: string;
  error?: string;
  checks: number;
}
export interface Idea {
  id: string;
  title: string;
  reason: string;
  evidence: Evidence[];
  prompt: string;
  kind: AgentTask["kind"];
  input: Record<string, unknown>;
  status: "new" | "dismissed" | "accepted";
  taskId?: string;
  createdAt: string;
}
export interface AgentMemory {
  id: string;
  text: string;
  source: string;
  createdAt: string;
}
export interface AgentArtifact {
  id: string;
  taskId: string;
  kind: "plan" | "comparison" | "finance" | "report";
  title: string;
  summary: string;
  data: Record<string, unknown>;
  createdAt: string;
}
export interface AgentNotification {
  id: string;
  taskId?: string;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
}
export interface AgentIdentity {
  name: string;
  tone: "warm" | "concise" | "thoughtful";
  avatar?: "sky" | "sand" | "lilac";
  showChatUpdates?: boolean;
}
export interface AgentWorkspace {
  tasks: AgentTask[];
  goals: Goal[];
  monitors: Monitor[];
  ideas: Idea[];
  memories: AgentMemory[];
  artifacts: AgentArtifact[];
  notifications: AgentNotification[];
  identity: AgentIdentity;
  worker: { running: boolean; lastTickAt?: string };
  models?: ModelProfile[];
  modelCatalog?: ModelCatalogStatus;
  modelSelection?: ModelSelection;
  teams?: AgentTeam[];
}
export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  prompt: z.string().trim().min(1).max(12000),
  kind: z.enum(["agent", "document", "monitor", "finance", "plan"]).default("agent"),
  goalId: z.string().optional(),
  modelId: z.string().trim().min(1).max(120).optional(),
  teamId: z.string().trim().min(1).max(120).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export const modelSelectionInputSchema = z.object({
  modelId: z.string().trim().min(1).max(120).nullable(),
});
const teamRoleInputSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().trim().min(1).max(80),
  kind: agentRoleKindSchema,
  modelId: z.string().trim().min(1).max(120),
  systemPrompt: z.string().trim().min(1).max(12000),
  dependsOn: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
});
export const teamInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  execution: z.enum(["sequential", "parallel"]).default("parallel"),
  roles: z.array(teamRoleInputSchema).min(1).max(20),
});
export type TeamInput = z.infer<typeof teamInputSchema>;
export const monitorInputSchema = z
  .object({
    title: z.string().min(1).max(160),
    url: z.url().max(4096),
    condition: z.enum(["change", "contains", "price_below"]).default("change"),
    value: z.string().max(300).default(""),
    intervalMinutes: z.number().int().min(1).max(10080).default(15),
  })
  .superRefine((v, c) => {
    if (v.condition !== "change" && !v.value.trim())
      c.addIssue({ code: "custom", message: "Enter a condition value" });
    if (
      v.condition === "price_below" &&
      (!Number.isFinite(Number(v.value)) || Number(v.value) <= 0)
    )
      c.addIssue({ code: "custom", message: "Enter a positive price" });
  });
export const goalInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(4000).default(""),
  category: z.string().max(80).default("Personal"),
  milestones: z.array(z.string().min(1).max(200)).max(20).default([]),
});
