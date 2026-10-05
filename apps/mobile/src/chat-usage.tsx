import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Card, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

type Totals = {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  unreportedCalls: number;
};
type Summary = {
  since: string | null;
  thread: Totals;
  allChats: Totals;
  all: Totals;
  latest: { tokensPerSecond: number | null } | null;
  messageTimes: Record<string, string>;
};
export function useChatUsage(
  threadId: string,
  running: boolean,
  textLength: number,
  refreshKey = 0,
) {
  const { api } = useWorkspace();
  const [usage, setUsage] = useState<Summary>();
  const [speed, setSpeed] = useState<string>("— tok/s");
  const start = useRef({ time: 0, length: 0 });
  useEffect(() => {
    let active = true,
      pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await api.request<Summary>(
          `/api/usage?threadId=${encodeURIComponent(threadId)}`,
        );
        if (active) setUsage(value);
      } catch {
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), running ? 1000 : 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, threadId, running, refreshKey]);
  useEffect(() => {
    if (!running) {
      start.current = { time: 0, length: textLength };
      setSpeed(
        usage?.latest?.tokensPerSecond != null
          ? `${usage.latest.tokensPerSecond.toFixed(1)} tok/s`
          : "— tok/s",
      );
      return;
    }
    if (!start.current.time) start.current = { time: Date.now(), length: textLength };
    const elapsed = (Date.now() - start.current.time) / 1000;
    const delta = Math.max(0, textLength - start.current.length);
    if (delta && elapsed > 0.2) setSpeed(`≈${(delta / 3 / elapsed).toFixed(1)} tok/s`);
    else setSpeed("생성 대기");
  }, [running, textLength, usage]);
  return { usage, speed };
}
export function ChatUsage({ usage, speed }: { usage?: Summary; speed: string }) {
  const [opened, setOpened] = useState(false);
  const totals = (name: string, value: Totals) => (
    <Card style={{ gap: 6 }}>
      <Text style={s.heading}>{name}</Text>
      <Text style={s.text}>
        {value.totalTokens.toLocaleString()} 토큰 · {value.calls.toLocaleString()}회 모델 호출
      </Text>
      <Text style={s.small}>
        입력 {value.input.toLocaleString()} · 출력 {value.output.toLocaleString()} · 캐시 읽기{" "}
        {value.cacheRead.toLocaleString()} · 캐시 쓰기 {value.cacheWrite.toLocaleString()}
      </Text>
      {value.unreportedCalls > 0 && (
        <Text style={s.small}>
          사용량을 보고하지 않은 호출 {value.unreportedCalls}회는 토큰 합계에서 제외됩니다.
        </Text>
      )}
    </Card>
  );
  return (
    <View style={[s.row, { gap: 12, flexShrink: 0 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="AI 사용량 상세"
        onPress={() => setOpened(true)}
        style={{ justifyContent: "center", minHeight: 38 }}
      >
        <Text style={[s.small, { fontSize: 12, lineHeight: 18 }]}>
          사용량 {usage?.thread.totalTokens.toLocaleString() ?? "—"} 토큰
        </Text>
      </Pressable>
      <Text accessibilityLabel="AI 생성 속도" style={s.small}>
        {speed}
      </Text>
      {opened && (
        <Sheet
          title="AI 사용량"
          subtitle="OpenMuse 서버에 누적된 모델 호출 기록"
          onClose={() => setOpened(false)}
        >
          <View style={{ gap: 12 }}>
            {usage ? (
              <>
                {totals("현재 대화", usage.thread)}
                {totals("전체 대화", usage.allChats)}
                {totals("백그라운드 작업 포함 전체", usage.all)}
                <Text style={s.small}>
                  {usage.since
                    ? `기록 시작: ${new Date(usage.since).toLocaleString("ko-KR")}`
                    : "아직 사용량이 없습니다."}{" "}
                  · 기능 적용 이전 사용량은 소급 집계되지 않습니다. 생성 중 ≈ 속도는 문자 기반
                  추정이며, 응답 완료 후 제공자가 보고한 출력 토큰으로 계산합니다.
                </Text>
              </>
            ) : (
              <Text style={s.muted}>사용량을 불러오는 중…</Text>
            )}
          </View>
        </Sheet>
      )}
    </View>
  );
}
