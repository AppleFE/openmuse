import { z } from "zod";
export const scheduleTimingSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("once"), at: z.iso.datetime({ offset: true }) }),
  z.strictObject({
    type: z.literal("cron"),
    expression: z
      .string()
      .trim()
      .min(9)
      .max(100)
      .refine((v) => v.split(/\s+/).length === 5, "분·시·일·월·요일의 5개 필드를 사용하세요"),
    timeZone: z.string().min(1).max(100).default("Asia/Seoul"),
  }),
]);
export const scheduleInputSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1).max(16000),
    timing: scheduleTimingSchema,
    modelId: z.string().min(1).max(200).optional(),
    teamId: z.string().min(1).max(200).optional(),
    enabled: z.boolean().default(true),
  })
  .refine((v) => !(v.modelId && v.teamId), "모델과 팀 중 하나를 선택하세요");
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;
export interface AgentSchedule extends ScheduleInput {
  sourceThreadId?: string;
  id: string;
  version: number;
  nextRunAt: string | null;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ScheduleRun {
  sourceThreadId?: string;
  id: string;
  scheduleId: string;
  scheduleVersion?: number;
  scheduledFor: string;
  title: string;
  prompt: string;
  modelId?: string;
  teamId?: string;
  status: "pending" | "dispatching" | "dispatched" | "failed" | "skipped";
  attempts: number;
  leaseUntil: string | null;
  taskId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
