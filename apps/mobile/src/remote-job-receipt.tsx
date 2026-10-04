import { useEffect, useState } from "react";
import { Text } from "react-native";
import type { ActionProposal } from "../../../packages/domain/src";
import type { RemoteJob } from "../../../packages/domain/src/remote-host";
import { Button, Card, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

export function RemoteJobReceipt({ action }: { action: ActionProposal }) {
  const { api } = useWorkspace();
  const [job, setJob] = useState<RemoteJob>(),
    [error, setError] = useState("");
  let initial: RemoteJob | undefined;
  try {
    initial = JSON.parse(action.result ?? "{}").job;
  } catch {}
  const id = initial?.id;
  const check = async () => {
    if (!id) return;
    try {
      const result = await api.request<{ data: { job: RemoteJob } }>(
        `/api/connectors/${action.data.connectorId}/query`,
        { operation: "host_job", params: { jobId: id } },
      );
      setJob(result.data.job);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void check();
  }, [api, id]);
  const value = job ?? initial;
  return (
    <Card style={{ gap: 10, marginTop: 16 }}>
      <Text style={s.heading}>
        {value?.status === "succeeded"
          ? "명령 완료"
          : value?.status === "running"
            ? "명령 실행 중"
            : value?.status === "failed"
              ? "명령 실패"
              : "원격 명령 상태"}
      </Text>
      <Text selectable style={s.small}>
        작업 ID: {id ?? "응답 없음"} · 상태: {value?.status ?? "확인 필요"} · 종료 코드:{" "}
        {value?.exitCode ?? "대기"}
      </Text>
      <Text selectable style={s.text}>
        {value?.output.slice(-12000) || "아직 출력이 없습니다."}
      </Text>
      {value?.outputTruncated && <Text style={s.small}>출력이 길어 일부만 보존되었습니다.</Text>}
      <ErrorNotice error={error} />
      <Button small onPress={() => void check()}>
        현재 출력 확인
      </Button>
    </Card>
  );
}
