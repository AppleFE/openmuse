import { z } from "zod";

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !v.includes("\0"));
export const hostEventInputSchema = z.strictObject({
  key: text(160),
  target: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
    .default("main"),
  type: z.enum(["completed", "question", "error", "progress"]).default("completed"),
  source: text(80).default("agent"),
  task: text(160).optional(),
  message: text(32000).refine(
    (v) => new TextEncoder().encode(v).length <= 32000,
    "메시지는 UTF-8 32,000바이트 이하여야 합니다",
  ),
  reply: z.boolean().default(true),
});
export type HostEventInput = z.infer<typeof hostEventInputSchema>;
export const hostEventLabels = {
  completed: "완료",
  question: "질문",
  error: "문제",
  progress: "진행 보고",
} as const;
export interface HostEvent extends HostEventInput {
  id: string;
  connectorId: string;
  hostName: string;
  threadId: string;
  messageId: string;
  runId: string;
  status: "queued" | "running" | "delivered" | "failed" | "interrupted";
  createdAt: string;
  updatedAt: string;
  error?: string;
}
export function hostEventMessage(event: HostEvent) {
  return `[원격 호스트 보고 · ${hostEventLabels[event.type]}]\n호스트: ${event.hostName}\n에이전트: ${event.source}${event.task ? `\n작업: ${event.task}` : ""}\n\n${event.message}`;
}
