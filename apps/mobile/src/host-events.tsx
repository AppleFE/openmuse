import { fetch as streamFetch } from "expo/fetch";
import { MessageCircle, Radio } from "lucide-react-native";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { AppState, Platform, Text, View } from "react-native";
import { type HostEvent, hostEventLabels } from "../../../packages/domain/src/host-events";
import { API_URL } from "./api";
import { CopyButton } from "./copy-button";
import { useMuseThread } from "./threads";
import { Button, Card, Chip, ErrorNotice, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

const statuses = {
  queued: "대화 전달 대기",
  running: "AI 응답 중",
  delivered: "전달 완료",
  failed: "응답 실패",
  interrupted: "응답 중단",
};
const Context = createContext<{
  events: HostEvent[];
  versions: Record<string, number>;
  connected: boolean;
}>({ events: [], versions: {}, connected: false });
export const useHostEvents = () => useContext(Context);
export function HostEventsProvider({ children }: { children: ReactNode }) {
  const { api } = useWorkspace();
  const [events, setEvents] = useState<HostEvent[]>([]),
    [versions, setVersions] = useState<Record<string, number>>({}),
    [connected, setConnected] = useState(false);
  useEffect(() => {
    let stopped = false,
      controller: AbortController | undefined,
      reconnect: ReturnType<typeof setTimeout> | undefined;
    const active = () =>
      Platform.OS !== "web"
        ? AppState.currentState === "active"
        : document.visibilityState !== "hidden";
    const apply = (incoming: HostEvent[], replace = false) => {
      setEvents((old) => {
        const map = new Map((replace ? [] : old).map((e) => [e.id, e]));
        for (const e of incoming) {
          const prior = map.get(e.id);
          if (!prior || prior.updatedAt <= e.updatedAt) map.set(e.id, e);
        }
        return [...map.values()]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 100);
      });
      setVersions((old) => {
        const next = { ...old };
        for (const e of incoming)
          if (e.status !== "queued") next[e.threadId] = (next[e.threadId] ?? 0) + 1;
        return next;
      });
    };
    async function connect() {
      if (stopped || !active() || controller) return;
      controller = new AbortController();
      try {
        const response = await streamFetch(`${API_URL}/api/host-events/stream`, {
          headers: { Authorization: `Bearer ${api.token}` },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          if (response.status === 401) await api.request("/api/host-events");
          throw Error("stream");
        }
        setConnected(true);
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 8 * 1024 * 1024) throw Error("stream limit");
          while (buffer.includes("\n\n")) {
            const boundary = buffer.indexOf("\n\n");
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (!frame.startsWith("data: ")) continue;
            const data = JSON.parse(frame.slice(6)) as { events?: HostEvent[]; event?: HostEvent };
            if (data.events) apply(data.events);
            else if (data.event) apply([data.event]);
          }
        }
      } catch {
        /* Visibility changes abort the stream; a new connection replays durable inbox state. */
      } finally {
        controller = undefined;
        if (!stopped) {
          setConnected(false);
          if (active()) reconnect = setTimeout(() => void connect(), 3000);
        }
      }
    }
    const visibility = () => {
      if (reconnect) clearTimeout(reconnect);
      if (!active()) controller?.abort();
      else void connect();
    };
    const appState = AppState.addEventListener("change", visibility);
    if (Platform.OS === "web") document.addEventListener("visibilitychange", visibility);
    void connect();
    return () => {
      stopped = true;
      controller?.abort();
      if (reconnect) clearTimeout(reconnect);
      appState.remove();
      if (Platform.OS === "web") document.removeEventListener("visibilitychange", visibility);
    };
  }, [api]);
  return <Context.Provider value={{ events, versions, connected }}>{children}</Context.Provider>;
}
export function HostEventsButton() {
  const { open } = useWorkspace(),
    { events } = useHostEvents();
  const pending = events.filter(
    (e) => e.origin !== "task" && (e.type === "question" || e.type === "error"),
  ).length;
  return (
    <Button icon={Radio} onPress={() => open({ type: "host-events" })}>
      호스트 호출{pending ? ` · 질문·문제 ${pending}` : ""}
    </Button>
  );
}
export function HostEventsSheet() {
  const { close } = useWorkspace(),
    { events, connected } = useHostEvents(),
    hostReports = events.filter((e) => e.origin !== "task"),
    { selection, select, refetch } = useMuseThread();
  const command = `openmuse send --source codex --target ${selection.id} --type completed --message "작업 완료: 테스트 통과" --idempotency-key 작업ID-complete`;
  return (
    <Sheet
      title="호스트 호출"
      subtitle="원격 에이전트가 완료·질문·문제를 대화로 직접 전달합니다."
      onClose={close}
      wide
    >
      <View testID="host-events" style={{ gap: 16 }}>
        <Text style={s.muted}>
          {connected ? "실시간 보고 연결됨" : "보고 연결 대기 중"} · 최근 100건
        </Text>
        <Card>
          <Text style={s.heading}>현재 대화로 보내기</Text>
          <Text selectable style={s.text}>
            {command}
          </Text>
          <CopyButton text={command} label="명령 복사" />
          <Text style={s.muted}>
            대상을 생략하면 기본 대화로 보냅니다. Host Agent 0.9.0부터 --target "대화 이름"도 사용할
            수 있습니다. AI 응답 없이 기록만 남기려면 --no-reply를 추가하세요.
          </Text>
          <Text style={s.small}>
            유형: completed(완료) · question(질문) · error(문제) · progress(진행). 같은 보고를
            재시도할 때 중복 방지 키를 그대로 사용하세요.
          </Text>
        </Card>
        {!hostReports.length && <Text style={s.muted}>아직 받은 보고가 없습니다.</Text>}
        {hostReports.map((e) => (
          <Card key={e.id}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <Text style={s.heading}>
                {e.hostName} · {e.source}
              </Text>
              <Chip>{hostEventLabels[e.type]}</Chip>
            </View>
            <Text style={s.small}>
              {new Date(e.createdAt).toLocaleString("ko-KR")} · {statuses[e.status]}
              {e.task ? ` · ${e.task}` : ""}
            </Text>
            <Text selectable style={s.text}>
              {e.message}
            </Text>
            {!!e.error && <ErrorNotice error={e.error} />}
            <Button
              icon={MessageCircle}
              onPress={() => {
                refetch();
                select({ id: e.threadId, existing: true });
                close();
              }}
            >
              대화 열기
            </Button>
          </Card>
        ))}
      </View>
    </Sheet>
  );
}
