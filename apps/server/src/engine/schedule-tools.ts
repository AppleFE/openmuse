import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { scheduleInputSchema } from "../../../../packages/domain/src/schedules.ts";
import type { ScheduleService } from "./schedules.ts";
export const scheduleInstructions =
  "For explicit reminders or recurring work, first list_schedules and reuse an existing registration for the same purpose; use update_schedule for changes, never create another on a retry or status report. Only create_schedule for a new explicit user scheduling request. Convert natural-language timing to a five-field minute/hour/day/month/weekday cron and an IANA timezone (default Asia/Seoul), or a future ISO datetime with offset for one-time work. Ask for an exact time if essential timing is ambiguous. Tell the user the returned nextRunAt/timezone and job prompt; do not claim a schedule exists before the tool succeeds. Scheduled jobs run while the server is online; downtime is coalesced into one catch-up job. They use normal connected tools and native external-write review. list_schedules and schedule_runs show registrations and task receipts. Pause/resume via update_schedule; delete_schedule stops future launches, existing tasks remain in Activity.";
export const scheduledOccurrenceInstructions =
  "This task is ONE occurrence of an ALREADY REGISTERED schedule. Perform the requested check/work once and finish_task with its actual outcome. The scheduler handles future occurrences. Do not create, update, delete or re-register schedules, even if timing is mentioned in the prompt or earlier context. Do not ask another agent or host shell to create a replacement schedule.";
export function scheduleTools(
  service: ScheduleService,
  owner: string,
  key: (name: string, value: unknown) => string,
  options: { readOnly?: boolean; sourceThreadId?: string } = {},
) {
  return [
    defineTool({
      name: "create_schedule",
      description:
        "Register future or recurring AI work that invokes configured tools at the scheduled time.",
      parameters: scheduleInputSchema,
      execute: async (input) => {
        try {
          return await service.create(owner, input, key("schedule", input), options.sourceThreadId);
        } catch (e) {
          return { error: e instanceof Error ? e.message : "스케줄 등록 실패" };
        }
      },
    }),
    defineTool({
      name: "list_schedules",
      description: "Read the owner's saved schedules and next run times.",
      parameters: z.object({}),
      execute: async () => service.list(owner),
    }),
    defineTool({
      name: "schedule_runs",
      description: "Read recent scheduled task receipts and actual task status.",
      parameters: z.object({ id: z.string().min(1).max(200) }),
      execute: async ({ id }) => service.runs(owner, id),
    }),
    defineTool({
      name: "update_schedule",
      description:
        "Replace schedule settings, pause with enabled=false or resume with enabled=true.",
      parameters: z.object({ id: z.string().min(1).max(200), schedule: scheduleInputSchema }),
      execute: async ({ id, schedule }) => service.update(owner, id, schedule),
    }),
    defineTool({
      name: "delete_schedule",
      description: "Remove a requested schedule; already launched tasks are retained.",
      parameters: z.object({ id: z.string().min(1).max(200) }),
      execute: async ({ id }) => service.remove(owner, id),
    }),
  ].filter((tool) => !options.readOnly || ["list_schedules", "schedule_runs"].includes(tool.name));
}
