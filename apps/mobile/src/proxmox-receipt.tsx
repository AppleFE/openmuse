import { useState } from "react";
import { Text, View } from "react-native";
import type { ActionProposal } from "../../../packages/domain/src";
import { Button, Card, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

export function ProxmoxActionReceipt({ action }: { action: ActionProposal }) {
  const { api } = useWorkspace();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [task, setTask] = useState<Record<string, unknown>>(),
    [lines, setLines] = useState<{ n: number; t: string }[]>([]);
  let receipt: { status?: string; upid?: string; node?: string } = {};
  try {
    receipt = JSON.parse(action.result ?? "{}");
  } catch {}
  async function check() {
    setBusy(true);
    setError("");
    try {
      const body = { operation: "task_status", params: { node: receipt.node, upid: receipt.upid } };
      const result = await api.request<{ data: { task: Record<string, unknown> } }>(
        `/api/connectors/${action.data.connectorId}/query`,
        body,
      );
      setTask(result.data.task);
      const log = await api.request<{ data: { lines: { n: number; t: string }[] } }>(
        `/api/connectors/${action.data.connectorId}/query`,
        { operation: "task_log", params: { node: receipt.node, upid: receipt.upid, limit: 100 } },
      );
      setLines(log.data.lines);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const finished = task?.status === "stopped",
    ok = finished && task?.exitstatus === "OK";
  return (
    <Card style={{ gap: 12, marginTop: 16 }}>
      <Text style={s.heading}>
        {receipt.status === "completed"
          ? "처리 완료"
          : task
            ? ok
              ? "작업 완료"
              : finished
                ? "작업 실패"
                : "작업 진행 중"
            : "Proxmox 작업 접수"}
      </Text>
      <Text style={s.small}>
        {receipt.status === "completed"
          ? "Proxmox가 동기 작업의 완료를 확인했습니다."
          : "Proxmox가 작업 ID를 반환했습니다. 실행 상태와 로그로 완료 여부를 확인할 수 있습니다."}
      </Text>
      {!!receipt.upid && (
        <>
          <Text selectable style={s.small}>
            {receipt.upid}
          </Text>
          <Button small busy={busy} onPress={() => void check()}>
            실행 상태 확인
          </Button>
        </>
      )}
      {task && (
        <Text style={{ color: finished && !ok ? colors.danger : colors.text }}>
          {finished
            ? `종료 결과: ${String(task.exitstatus ?? "알 수 없음")}`
            : "현재 상태: 실행 중"}
        </Text>
      )}
      {lines.length > 0 && (
        <View style={{ gap: 4 }}>
          {lines.map((line) => (
            <Text selectable key={line.n} style={s.small}>
              {line.t}
            </Text>
          ))}
        </View>
      )}
      <ErrorNotice error={error} />
    </Card>
  );
}
