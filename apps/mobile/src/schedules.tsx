import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { AgentSchedule, ScheduleRun } from "../../../packages/domain/src/schedules";
import { useAgentWorkspace } from "./agent-workspace";
import { zonedInstant } from "./date-time";
import { Button, Card, ErrorNotice, Field, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";
export function ScheduleManager() {
  const { api, open } = useWorkspace(),
    { data } = useAgentWorkspace();
  const [items, setItems] = useState<AgentSchedule[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [form, setForm] = useState(false),
    [editing, setEditing] = useState<AgentSchedule>();
  const [title, setTitle] = useState(""),
    [prompt, setPrompt] = useState(""),
    [mode, setMode] = useState("daily"),
    [time, setTime] = useState("08:00"),
    [date, setDate] = useState(""),
    [zone, setZone] = useState("Asia/Seoul"),
    [expression, setExpression] = useState("0 8 * * *"),
    [modelId, setModelId] = useState("");
  const [expanded, setExpanded] = useState<string>(),
    [runs, setRuns] = useState<(ScheduleRun & { task?: { id: string; status: string } | null })[]>(
      [],
    ),
    [deleting, setDeleting] = useState<string>();
  const load = useCallback(async () => {
    try {
      setItems(await api.request<AgentSchedule[]>("/api/agent/schedules"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [load]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function edit(item?: AgentSchedule) {
    setEditing(item);
    setTitle(item?.title ?? "");
    setPrompt(item?.prompt ?? "");
    setModelId(item?.modelId ?? "");
    setMode(item?.timing.type ?? "daily");
    setZone(item?.timing.type === "cron" ? item.timing.timeZone : "Asia/Seoul");
    setExpression(item?.timing.type === "cron" ? item.timing.expression : "0 8 * * *");
    setTime("08:00");
    setDate("");
    if (item?.timing.type === "once") {
      const local = new Date(item.timing.at)
        .toLocaleString("sv-SE", { timeZone: "Asia/Seoul" })
        .split(" ");
      setDate(local[0]);
      setTime(local[1].slice(0, 5));
    }
    setForm(true);
  }
  async function save() {
    await action(async () => {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) && mode !== "cron")
        throw new Error("시각은 HH:mm 형식으로 입력하세요");
      const [hour, minute] = time.split(":").map(Number);
      const timing =
        mode === "once"
          ? { type: "once", at: zonedInstant(date, time, zone) }
          : {
              type: "cron",
              expression: mode === "daily" ? `${minute} ${hour} * * *` : expression,
              timeZone: zone,
            };
      const value = {
        title,
        prompt,
        timing,
        ...(modelId ? { modelId } : {}),
        ...(editing?.teamId && !modelId ? { teamId: editing.teamId } : {}),
        enabled: editing?.enabled ?? true,
      };
      await api.request(
        editing ? `/api/agent/schedules/${editing.id}` : "/api/agent/schedules",
        value,
        editing ? "PUT" : "POST",
      );
      setForm(false);
    });
  }
  return (
    <Card style={{ gap: 12 }}>
      <View style={[s.row, { gap: 8 }]}>
        <Text style={[s.heading, { flex: 1 }]}>AI 예약 실행</Text>
        <Button small onPress={() => edit()}>
          스케줄 추가
        </Button>
      </View>
      <Text style={s.small}>
        “매일 아침 8시에 뉴스를 정리해 줘”처럼 대화로 등록할 수도 있습니다. 실행 결과는 활동에
        저장됩니다.
      </Text>
      <ErrorNotice error={error} />
      {!items.length && <Text style={s.muted}>등록된 스케줄이 없습니다.</Text>}
      {items.map((item) => (
        <View key={item.id} style={{ gap: 8, paddingVertical: 12 }}>
          <Text style={s.text}>
            {item.title} · {item.enabled ? "예약 중" : "일시 중지·완료"}
          </Text>
          <Text style={s.small}>
            {item.timing.type === "cron"
              ? `${item.timing.expression} · ${item.timing.timeZone}`
              : new Date(item.timing.at).toLocaleString("ko-KR")}{" "}
            · 다음 {item.nextRunAt ? new Date(item.nextRunAt).toLocaleString("ko-KR") : "없음"}
          </Text>
          <Text style={s.muted}>{item.prompt}</Text>
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button small disabled={busy} onPress={() => edit(item)}>
              수정
            </Button>
            <Button
              small
              disabled={busy}
              onPress={() =>
                void action(() =>
                  api.request(
                    `/api/agent/schedules/${item.id}`,
                    {
                      title: item.title,
                      prompt: item.prompt,
                      timing: item.timing,
                      modelId: item.modelId,
                      teamId: item.teamId,
                      enabled: !item.enabled,
                    },
                    "PUT",
                  ),
                )
              }
            >
              {item.enabled ? "중지" : "재개"}
            </Button>
            <Button
              small
              onPress={() =>
                void action(async () => {
                  setExpanded(item.id);
                  setRuns(await api.request(`/api/agent/schedules/${item.id}/runs`));
                })
              }
            >
              실행 기록
            </Button>
            <Button
              small
              danger
              disabled={busy}
              onPress={() => {
                if (deleting !== item.id) {
                  setDeleting(item.id);
                  return;
                }
                void action(() =>
                  api.request(`/api/agent/schedules/${item.id}`, undefined, "DELETE"),
                );
              }}
            >
              {deleting === item.id ? "삭제 확인" : "삭제"}
            </Button>
          </View>
          {expanded === item.id && (
            <View style={{ gap: 6 }}>
              {!runs.length && <Text style={s.small}>실행 기록이 없습니다.</Text>}
              {runs.map((run) => (
                <View key={run.id} style={[s.row, { gap: 8 }]}>
                  <Text style={[s.small, { flex: 1 }]}>
                    {new Date(run.scheduledFor).toLocaleString("ko-KR")} ·{" "}
                    {run.task?.status ?? run.status}
                    {run.error ? ` · ${run.error}` : ""}
                  </Text>
                  {run.task && (
                    <Button small onPress={() => open({ type: "task", taskId: run.task!.id })}>
                      결과
                    </Button>
                  )}
                </View>
              ))}
            </View>
          )}
        </View>
      ))}
      {form && (
        <Sheet title={editing ? "스케줄 수정" : "스케줄 등록"} onClose={() => setForm(false)}>
          <View style={{ gap: 12 }}>
            <Field label="제목" value={title} onChangeText={setTitle} />
            <Field label="AI가 실행할 작업" multiline value={prompt} onChangeText={setPrompt} />
            <View style={[s.row, { gap: 8 }]}>
              {["daily", "once", "cron"].map((value) => (
                <Button small key={value} primary={mode === value} onPress={() => setMode(value)}>
                  {{ daily: "매일", once: "한 번", cron: "반복식" }[value]}
                </Button>
              ))}
            </View>
            {mode === "once" && (
              <Field label="날짜 (YYYY-MM-DD)" value={date} onChangeText={setDate} />
            )}
            <Field label="시간대" value={zone} onChangeText={setZone} />
            {mode === "cron" ? (
              <Field
                label="반복식 (분 시 일 월 요일)"
                value={expression}
                onChangeText={setExpression}
              />
            ) : (
              <Field label="시각 (HH:mm)" value={time} onChangeText={setTime} />
            )}
            <Text style={s.label}>실행 모델</Text>
            <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
              <Button small primary={!modelId} onPress={() => setModelId("")}>
                기본 모델
              </Button>
              {data?.models
                ?.filter((m) => m.available)
                .map((m) => (
                  <Button
                    key={m.id}
                    small
                    primary={modelId === m.id}
                    onPress={() => setModelId(m.id)}
                  >
                    {m.label}
                  </Button>
                ))}
            </View>
            <Text style={s.small}>
              서버가 꺼져 있던 동안 놓친 실행은 다시 켤 때 한 번 수행합니다. 이전 작업이 진행 중이면
              중복 실행은 건너뜁니다.
            </Text>
            <ErrorNotice error={error} />
            <Button
              primary
              busy={busy}
              disabled={!title.trim() || !prompt.trim()}
              onPress={() => void save()}
            >
              저장
            </Button>
          </View>
        </Sheet>
      )}
    </Card>
  );
}
