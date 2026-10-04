import { createHash } from "node:crypto";
import type { Store } from "./db.ts";
export interface UsageRecord { id: string; threadId: string | null; modelId: string; input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; durationMs: number; reported: boolean; createdAt: string; }
export class UsageService {
  constructor(private db: Store) {}
  async record(owner: string, key: string, value: Omit<UsageRecord, "id">) {
    const count = (n: number) => Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    const record = { ...value, id: createHash("sha256").update(key).digest("hex"), input: count(value.input), output: count(value.output), cacheRead: count(value.cacheRead), cacheWrite: count(value.cacheWrite), totalTokens: count(value.totalTokens) };
    await this.db.insertIfAbsent(owner, "usage", record);
    return record;
  }
  async summary(owner: string, threadId?: string) {
    const rows = await this.db.list<UsageRecord>(owner, "usage");
    const sum = (list: UsageRecord[]) => list.reduce((total, row) => ({ calls: total.calls + 1, input: total.input + row.input, output: total.output + row.output, cacheRead: total.cacheRead + row.cacheRead, cacheWrite: total.cacheWrite + row.cacheWrite, totalTokens: total.totalTokens + row.totalTokens, unreportedCalls: total.unreportedCalls + (row.reported ? 0 : 1) }), { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, unreportedCalls: 0 });
    const current = rows.filter((row) => row.threadId === threadId).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    const latest = current[0];
    const thread = threadId ? await this.db.get<{ messageTimes?: Record<string,string> }>(owner, "conversation-threads", threadId) : undefined;
    return { since: rows.map((row) => row.createdAt).sort()[0] ?? null, thread: sum(current), allChats: sum(rows.filter((row) => row.threadId !== null)), all: sum(rows), latest: latest ? { ...latest, tokensPerSecond: latest.reported && latest.durationMs > 0 ? latest.output / (latest.durationMs / 1000) : null } : null, messageTimes: thread?.messageTimes ?? {} };
  }
}
