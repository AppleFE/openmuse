import type { AssistantMessage } from "@earendil-works/pi-ai";

// Report a useful category without echoing provider payloads, URLs or credentials.
export function piAssistantFailure(message: Pick<AssistantMessage, "stopReason" | "errorMessage">) {
  if (message.stopReason === "aborted")
    return "모델 응답이 중단되었습니다. 도구 실행 여부를 확인한 뒤 다시 시도하세요.";
  if (message.stopReason !== "error") return undefined;
  const error = message.errorMessage ?? "";
  const reason =
    /401|403|unauthori|forbidden|authentication|invalid.api.key|인증|접근 권한|사용 권한|허용되지/i.test(
      error,
    )
      ? "인증 또는 접근 권한 오류입니다. 모델 계정의 로그인 상태와 권한을 확인하세요."
      : /429|rate.limit|quota|usage.limit|insufficient.quota|사용 한도|호출 한도/i.test(error)
        ? "사용량 또는 호출 한도 오류입니다. 계정 한도를 확인하고 잠시 뒤 다시 시도하세요."
        : /context.length|context.window|too.many.tokens|maximum.context/i.test(error)
          ? "대화가 모델의 컨텍스트 한도를 초과했습니다."
          : /timeout|timed.out|network|fetch.failed|connection|ECONN|502|503|504/i.test(error)
            ? "모델 제공자 연결 또는 시간 초과 오류입니다."
            : "모델 제공자가 응답 생성 오류를 반환했습니다.";
  return `모델 호출 실패: ${reason} 이전 도구 실행 결과는 유지됩니다.`;
}

export const emptyPiRecoveryPrompt =
  "The last turn returned no assistant text. Continue in this same session from existing tool receipts. Do not repeat completed external actions, send another message, or create replacement jobs. If tool results already answer the request, summarize their actual outcome. Otherwise perform only the remaining authorized work, then report its result or the concrete blocker.";

export const piRetrySettings = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
  maxAgentDelayMs: 30_000,
};
/** Upper bound for one Pi run regardless of activity. The owner setting is the idle window. */
export const piHardLimitMs = 60 * 60 * 1000;
export const piMaxEmptyRecoveries = 2;

/**
 * Abort a Pi run only when it stops making progress. Model output and tool events reset the
 * idle window; a running tool keeps it open because each tool enforces its own timeout.
 */
export function piWatchdog(idleMs: number, hardMs = Math.max(piHardLimitMs, idleMs)) {
  const controller = new AbortController();
  let reason: "idle" | "limit" | undefined;
  let tools = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const fire = (next: "idle" | "limit") => {
    if (controller.signal.aborted) return;
    reason = next;
    controller.abort();
  };
  const arm = () => {
    if (idle) clearTimeout(idle);
    idle = tools > 0 ? undefined : setTimeout(() => fire("idle"), idleMs);
  };
  const hard = setTimeout(() => fire("limit"), hardMs);
  arm();
  const minutes = (ms: number) => Math.max(1, Math.round(ms / 60000));
  return {
    signal: controller.signal,
    get aborted() {
      return controller.signal.aborted;
    },
    touch(event?: { type?: string }) {
      if (controller.signal.aborted) return;
      if (event?.type === "tool_execution_start") tools += 1;
      else if (event?.type === "tool_execution_end") tools = Math.max(0, tools - 1);
      arm();
    },
    message() {
      return reason === "limit"
        ? `Embedded pi timed out: 한 번의 실행 상한(${minutes(hardMs)}분)에 도달했습니다. 진행 기록은 보존되며 다시 시도하면 이어서 진행합니다.`
        : `Embedded pi timed out: 모델 응답이나 도구 진행이 ${minutes(idleMs)}분 동안 없어 중단했습니다. 진행 기록은 보존되며 다시 시도하면 이어서 진행합니다.`;
    },
    dispose() {
      if (idle) clearTimeout(idle);
      clearTimeout(hard);
    },
  };
}
