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
