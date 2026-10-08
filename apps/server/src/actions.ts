import { createHash, randomUUID } from "node:crypto";
import { githubOperationLabels } from "../../../packages/domain/src/github.ts";
import {
  type ActionProposal,
  type CalendarEvent,
  type ProposalInput,
  proposalSchema,
} from "../../../packages/domain/src/index.ts";
import { proxmoxOperationLabels } from "../../../packages/domain/src/proxmox.ts";
import { remoteOperationLabels } from "../../../packages/domain/src/remote-host.ts";
import { automationReceipt } from "./automation-result.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

interface Options {
  execute: (
    owner: string,
    input: ProposalInput,
    connectionId?: string,
    targetVersion?: string,
    signal?: AbortSignal,
  ) => Promise<string>;
  prepare?: (
    owner: string,
    input: ProposalInput,
    connectionId?: string,
  ) => Promise<{
    input: ProposalInput;
    target?: CalendarEvent;
    targetVersion?: string;
  }>;
  connected: (owner: string, input: ProposalInput) => Promise<boolean>;
  connection?: (
    owner: string,
    input: ProposalInput,
  ) => Promise<{ id: string; account: string } | null>;
  now?: () => number;
}
export class ActionService {
  private readonly now: () => number;
  constructor(
    private readonly db: Store,
    private readonly options: Options,
  ) {
    this.now = options.now ?? Date.now;
  }
  async get(owner: string, id: string) {
    const action = await this.db.get<ActionProposal>(owner, "actions", id);
    if (!action) throw new AppError("Action not found", 404);
    return action;
  }
  async propose(
    owner: string,
    raw: unknown,
    idempotencyKey?: string,
    taskId?: string,
    conversationId?: string,
  ): Promise<ActionProposal> {
    const id =
      idempotencyKey === undefined
        ? randomUUID()
        : createHash("sha256").update(idempotencyKey).digest("hex");
    if (idempotencyKey !== undefined) {
      const existing = await this.db.get<ActionProposal>(owner, "actions", id);
      if (existing) return existing;
    }
    const parsed = proposalSchema.parse(raw);
    const connection = await this.options.connection?.(owner, parsed);
    if (this.options.connection && !connection)
      throw new AppError(
        parsed.kind === "connector.write"
          ? "Connect the target connector before preparing an action"
          : parsed.kind === "automation.write"
            ? "화면 세션을 먼저 연결하세요."
            : "Connect Google before preparing an action",
        409,
      );
    const prepared = await this.options.prepare?.(owner, parsed, connection?.id);
    const input = proposalSchema.parse(prepared?.input ?? parsed);
    const title =
      input.kind === "automation.write"
        ? `화면 조작 · ${connection?.account ?? input.data.sessionId}`
        : input.kind === "connector.write"
          ? `${remoteOperationLabels[input.data.operation] ?? proxmoxOperationLabels[input.data.operation] ?? githubOperationLabels[input.data.operation]} · ${connection?.account ?? input.data.connectorId}`
          : input.kind === "email.send"
            ? `Send “${input.data.subject}”`
            : input.kind === "calendar.delete"
              ? `Delete ${input.data.title}`
              : `${input.kind === "calendar.create" ? "Create" : "Update"} ${input.data.title}`;
    const createdAt = new Date(this.now()).toISOString();
    const proposal: ActionProposal = {
      id,
      taskId,
      conversationId,
      title,
      kind: input.kind,
      data: input.data,
      account: connection?.account,
      connectionId: connection?.id,
      target: prepared?.target,
      targetVersion: prepared?.targetVersion,
      status: "awaiting_review",
      hash: createHash("sha256")
        .update(
          JSON.stringify({
            input,
            connection,
            target: prepared?.target,
            targetVersion: prepared?.targetVersion,
          }),
        )
        .digest("hex"),
      createdAt,
      expiresAt: new Date(this.now() + 30 * 60 * 1000).toISOString(),
    };
    const saved =
      idempotencyKey === undefined
        ? await this.db.put(owner, "actions", proposal)
        : await this.db.insertIfAbsent(owner, "actions", proposal);
    if (!saved) {
      const existing = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!existing) throw new AppError("Prepared action could not be loaded", 409);
      return existing;
    }
    await this.record(owner, saved, "Ready for your review");
    return saved;
  }
  async approvalMode(owner: string, threadId?: string): Promise<"review" | "bypass"> {
    if (!threadId) return "review";
    const thread = await this.db.get<{ approvalMode?: string; archived: boolean }>(
      owner,
      "conversation-threads",
      threadId,
    );
    return thread?.approvalMode === "bypass" && !thread.archived ? "bypass" : "review";
  }
  async proposeForConversation(
    owner: string,
    threadId: string,
    raw: unknown,
    key?: string,
    taskId?: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const proposal = await this.propose(owner, raw, key, taskId, threadId);
    if (
      proposal.conversationId !== threadId ||
      (await this.approvalMode(owner, threadId)) !== "bypass"
    )
      return proposal;
    return this.decide(owner, proposal.id, proposal.hash, "approve", "session-bypass", signal);
  }
  async decide(
    owner: string,
    id: string,
    hash: string,
    decision: "approve" | "deny",
    method: "user" | "session-bypass" = "user",
    signal?: AbortSignal,
  ): Promise<ActionProposal> {
    const proposal = await this.db.get<ActionProposal>(owner, "actions", id);
    if (!proposal) throw new AppError("Action not found", 404);
    if (proposal.hash !== hash)
      throw new AppError("This proposal changed. Open its latest review before deciding.", 409);
    if (method === "session-bypass" && !proposal.conversationId)
      throw new AppError("자동 승인의 원본 대화를 확인할 수 없습니다", 409);
    if (proposal.status !== "awaiting_review") return proposal;
    if (decision === "approve" && proposal.taskId) {
      const task = await this.db.get<{ status: string }>(owner, "tasks", proposal.taskId);
      if (!task || !["running", "waiting_approval"].includes(task.status))
        throw new AppError(
          "Resume the task before approving this action. Cancelled tasks cannot execute.",
          409,
        );
    }
    if (Date.parse(proposal.expiresAt) <= this.now()) {
      const expired = await this.db.compareAndSwap<ActionProposal>(
        owner,
        "actions",
        id,
        { status: "awaiting_review", hash, expiresAt: proposal.expiresAt },
        { status: "expired" },
      );
      if (!expired) {
        const current = await this.db.get<ActionProposal>(owner, "actions", id);
        if (!current) throw new AppError("Action not found", 404);
        return current;
      }
      throw new AppError("This review expired. Create a fresh proposal.", 409);
    }
    const reviewedInput = proposalSchema.parse({ kind: proposal.kind, data: proposal.data });
    if (decision === "approve" && !(await this.options.connected(owner, reviewedInput)))
      throw new AppError(
        proposal.kind === "connector.write"
          ? "The connector is disconnected. Reconnect before approving this action."
          : proposal.kind === "automation.write"
            ? "화면 세션이 연결되어 있지 않습니다. 다시 연결하세요."
            : "Google is disconnected. Reconnect before approving this action.",
        409,
      );
    if (decision === "approve" && this.options.connection) {
      const connection = await this.options.connection(owner, reviewedInput);
      if (
        !connection ||
        connection.id !== proposal.connectionId ||
        connection.account !== proposal.account
      )
        throw new AppError(
          proposal.kind === "connector.write"
            ? "Connector connection changed. Prepare a fresh action."
            : proposal.kind === "automation.write"
              ? "화면 연결이 변경되었습니다. 작업을 다시 요청하세요."
              : "Google account or connection changed. Prepare a new action for the connected account.",
          409,
        );
    }
    const claimed = await this.db.claim<ActionProposal>(
      owner,
      id,
      decision === "deny" ? "denied" : "executing",
      new Date(this.now()).toISOString(),
      method === "session-bypass" ? proposal.conversationId : undefined,
    );
    if (!claimed) {
      const current = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!current) throw new AppError("Action not found", 404);
      return current;
    }
    if (decision === "approve") claimed.approvalMethod = method;
    await this.record(
      owner,
      claimed,
      decision === "deny"
        ? "Declined; no changes made"
        : method === "session-bypass"
          ? "이 대화의 자동 승인 설정으로 실행 시작"
          : "Approved; execution started",
    );
    if (decision === "deny") return claimed;
    let finished: ActionProposal;
    try {
      signal?.throwIfAborted();
      const input = proposalSchema.parse({ kind: claimed.kind, data: claimed.data });
      const result = await this.options.execute(
        owner,
        input,
        claimed.connectionId,
        claimed.targetVersion,
        signal,
      );
      finished = { ...claimed, status: "succeeded", result };
    } catch (error) {
      const unknown =
        error instanceof Error &&
        (("outcomeUnknown" in error && error.outcomeUnknown === true) ||
          ("code" in error && error.code === "outcome_unknown"));
      finished = {
        ...claimed,
        status: unknown ? "outcome_unknown" : "failed",
        error: error instanceof Error ? error.message : "Execution failed",
      };
    }
    const stored =
      finished.kind === "automation.write" && finished.result
        ? { ...finished, result: automationReceipt(finished.result) }
        : finished;
    await this.db.put(owner, "actions", stored);
    await this.record(owner, stored, stored.result ?? stored.error ?? stored.status);
    return finished;
  }
  private async record(owner: string, action: ActionProposal, detail: string) {
    await this.db.put(owner, "activity", {
      id: randomUUID(),
      actionId: action.id,
      title: action.title,
      detail,
      date: new Date(this.now()).toISOString(),
      status: action.status,
    });
  }
}
