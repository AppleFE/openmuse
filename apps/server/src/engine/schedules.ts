import { createHash, randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type { AgentTask } from "../../../../packages/domain/src/agent.ts";
import {
  type AgentSchedule,
  type ScheduleInput,
  type ScheduleRun,
  scheduleInputSchema,
} from "../../../../packages/domain/src/schedules.ts";
import type { Store } from "../db.ts";
import { AppError } from "../errors.ts";
import { backgroundFailure } from "../log.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function nextScheduleDate(input: ScheduleInput, after: number): string | null {
  if (input.timing.type === "once")
    return Date.parse(input.timing.at) > after ? new Date(input.timing.at).toISOString() : null;
  new Intl.DateTimeFormat("en", { timeZone: input.timing.timeZone }).format();
  return CronExpressionParser.parse(input.timing.expression, {
    currentDate: new Date(after),
    tz: input.timing.timeZone,
  })
    .next()
    .toISOString();
}
export class ScheduleService {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    private db: Store,
    private createTask: (
      owner: string,
      input: unknown,
      key: string,
      sourceThreadId?: string,
    ) => Promise<AgentTask>,
    private validate: (owner: string, input: ScheduleInput) => Promise<void> = async () => {},
    private now: () => number = Date.now,
  ) {}
  start() {
    if (this.timer) return;
    void this.tick().catch((e) => backgroundFailure("schedule tick", e));
    this.timer = setInterval(
      () => void this.tick().catch((e) => backgroundFailure("schedule tick", e)),
      5000,
    );
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) await new Promise((r) => setTimeout(r, 10));
  }
  async list(owner: string) {
    return this.db.list<AgentSchedule>(owner, "schedules");
  }
  async get(owner: string, id: string) {
    const value = await this.db.get<AgentSchedule>(owner, "schedules", id);
    if (!value) throw new AppError("스케줄을 찾을 수 없습니다", 404);
    return value;
  }
  async runs(owner: string, id: string) {
    await this.get(owner, id);
    const runs = (await this.db.list<ScheduleRun>(owner, "schedule-runs"))
      .filter((r) => r.scheduleId === id)
      .sort((a, b) => b.scheduledFor.localeCompare(a.scheduledFor));
    const receipts = await Promise.all(
      runs.map(async (r) => ({
        ...r,
        task: r.taskId ? await this.db.get<AgentTask>(owner, "tasks", r.taskId) : null,
      })),
    );
    // Repeated skips must not hide the older task which still blocks this schedule.
    return receipts.filter(
      (r, index) =>
        index < 30 || (r.task && !["succeeded", "failed", "cancelled"].includes(r.task.status)),
    );
  }
  async create(owner: string, raw: unknown, key?: string, sourceThreadId?: string) {
    const input = scheduleInputSchema.parse(raw),
      id = key ? hash(`schedule:${key}`) : randomUUID();
    const existing = await this.db.get<AgentSchedule>(owner, "schedules", id);
    if (existing) return existing;
    if ((await this.list(owner)).length >= 50)
      throw new AppError("스케줄은 최대 50개까지 등록할 수 있습니다", 409);
    await this.validate(owner, input);
    let nextRunAt: string | null;
    try {
      nextRunAt = nextScheduleDate(input, this.now());
    } catch {
      throw new AppError("반복식 또는 시간대가 올바르지 않습니다", 422);
    }
    if (input.enabled && !nextRunAt) throw new AppError("미래의 실행 시각을 입력하세요", 422);
    const now = new Date(this.now()).toISOString(),
      value: AgentSchedule = {
        ...input,
        ...(sourceThreadId ? { sourceThreadId } : {}),
        id,
        version: 1,
        nextRunAt: input.enabled ? nextRunAt : null,
        createdAt: now,
        updatedAt: now,
      };
    await this.db.insertIfAbsent(owner, "schedules", value);
    return this.get(owner, id);
  }
  async update(owner: string, id: string, raw: unknown) {
    const old = await this.get(owner, id),
      input = scheduleInputSchema.parse(raw);
    await this.validate(owner, input);
    let nextRunAt: string | null;
    try {
      nextRunAt = input.enabled ? nextScheduleDate(input, this.now()) : null;
    } catch {
      throw new AppError("반복식 또는 시간대가 올바르지 않습니다", 422);
    }
    if (input.enabled && !nextRunAt) throw new AppError("미래의 실행 시각을 입력하세요", 422);
    const value = await this.db.compareAndSwap<AgentSchedule>(
      owner,
      "schedules",
      id,
      { version: old.version },
      {
        ...input,
        nextRunAt,
        version: old.version + 1,
        updatedAt: new Date(this.now()).toISOString(),
      },
    );
    if (!value) throw new AppError("스케줄이 변경되었습니다. 새로고침하세요", 409);
    return value;
  }
  async remove(owner: string, id: string) {
    await this.get(owner, id);
    await this.db.remove(owner, "schedules", id);
    return { ok: true };
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now(),
        iso = new Date(now).toISOString();
      for (const { owner, value: s } of await this.db.scan<AgentSchedule>("schedules")) {
        if (!s.enabled || !s.nextRunAt || Date.parse(s.nextRunAt) > now) continue;
        // Coalesce downtime to one catch-up run, then resume the future cadence.
        const run: ScheduleRun = {
          id: hash(`${s.id}:${s.nextRunAt}`),
          scheduleId: s.id,
          scheduleVersion: s.version,
          sourceThreadId: s.sourceThreadId,
          scheduledFor: s.nextRunAt,
          title: s.title,
          prompt: s.prompt,
          modelId: s.modelId,
          teamId: s.teamId,
          status: "pending",
          attempts: 0,
          leaseUntil: null,
          createdAt: iso,
          updatedAt: iso,
        };
        await this.db.claimScheduleRun(
          owner,
          s.id,
          { version: s.version, enabled: true, nextRunAt: s.nextRunAt },
          {
            nextRunAt: nextScheduleDate(s, now),
            lastRunAt: s.nextRunAt,
            enabled: s.timing.type !== "once",
            updatedAt: iso,
          },
          run,
        );
      }
      for (const { owner, value: r } of await this.db.scan<ScheduleRun>("schedule-runs")) {
        if (
          !["pending", "dispatching"].includes(r.status) ||
          (r.leaseUntil && Date.parse(r.leaseUntil) > now)
        )
          continue;
        if (
          !(await this.db.compareAndSwap(
            owner,
            "schedule-runs",
            r.id,
            { status: r.status, leaseUntil: r.leaseUntil, attempts: r.attempts },
            {
              status: "dispatching",
              leaseUntil: new Date(now + 60000).toISOString(),
              attempts: r.attempts + 1,
            },
          ))
        )
          continue;
        try {
          const schedule = await this.db.get<AgentSchedule>(owner, "schedules", r.scheduleId);
          if (
            !schedule ||
            (r.scheduleVersion !== undefined && r.scheduleVersion !== schedule.version) ||
            (!schedule.enabled && schedule.timing.type !== "once")
          ) {
            await this.db.compareAndSwap(
              owner,
              "schedule-runs",
              r.id,
              { status: "dispatching", attempts: r.attempts + 1 },
              {
                status: "skipped",
                leaseUntil: null,
                error: "예약이 중지·변경·삭제되어 실행하지 않았습니다",
                updatedAt: iso,
              },
            );
            continue;
          }
          const previous = (await this.db.list<ScheduleRun>(owner, "schedule-runs")).filter(
            (p) => p.scheduleId === r.scheduleId && p.id !== r.id && p.taskId,
          );
          let overlap = false;
          for (const p of previous) {
            const task = await this.db.get<AgentTask>(owner, "tasks", p.taskId!);
            if (task && !["succeeded", "failed", "cancelled"].includes(task.status)) {
              overlap = true;
              break;
            }
          }
          if (overlap) {
            await this.db.compareAndSwap(
              owner,
              "schedule-runs",
              r.id,
              { status: "dispatching", attempts: r.attempts + 1 },
              {
                status: "skipped",
                leaseUntil: null,
                error: "이전 예약 작업이 진행 중이어서 중복 실행을 건너뛰었습니다",
                updatedAt: iso,
              },
            );
            continue;
          }
          const task = await this.createTask(
            owner,
            {
              kind: "agent",
              title: `예약: ${r.title}`,
              prompt: r.prompt,
              modelId: r.modelId,
              teamId: r.teamId,
              input: { scheduleId: r.scheduleId, scheduledFor: r.scheduledFor },
            },
            `schedule:${r.id}`,
            r.sourceThreadId,
          );
          await this.db.compareAndSwap(
            owner,
            "schedule-runs",
            r.id,
            { status: "dispatching", attempts: r.attempts + 1 },
            { status: "dispatched", leaseUntil: null, taskId: task.id, updatedAt: iso },
          );
        } catch {
          await this.db.compareAndSwap(
            owner,
            "schedule-runs",
            r.id,
            { status: "dispatching", attempts: r.attempts + 1 },
            {
              status: r.attempts >= 2 ? "failed" : "pending",
              leaseUntil: r.attempts >= 2 ? null : new Date(now + 15000).toISOString(),
              error: "예약 작업을 생성하지 못했습니다. 모델·팀 설정과 대기 작업 한도를 확인하세요",
              updatedAt: iso,
            },
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
