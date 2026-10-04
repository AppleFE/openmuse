import { useCallback, useEffect, useState } from "react";
import { AppState, Platform, Text, View } from "react-native";
import type { ActionProposal, BrowserSession } from "../../../packages/domain/src";
import type { ConnectorView } from "../../../packages/domain/src/connectors";
import type { RemoteHostStatus, RemoteJob } from "../../../packages/domain/src/remote-host";
import { browserAddress } from "./browser-address";
import { Button, Card, ErrorNotice, Field, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

const labels: Record<string, string> = {
  running: "실행 중",
  stopping: "중지 요청 중",
  succeeded: "완료",
  failed: "실패",
  stopped: "중지됨",
  timed_out: "시간 초과",
  interrupted: "연결 중단·결과 확인 필요",
};
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
export function RemoteHostManager({
  connector,
  onClose,
}: {
  connector: ConnectorView;
  onClose: () => void;
}) {
  const { api, open, refresh } = useWorkspace();
  const [status, setStatus] = useState<RemoteHostStatus>();
  const [jobs, setJobs] = useState<RemoteJob[]>([]),
    [selected, setSelected] = useState<RemoteJob>();
  const [command, setCommand] = useState(""),
    [cwd, setCwd] = useState(""),
    [text, setText] = useState(""),
    [url, setUrl] = useState("https://www.google.com");
  const [pty, setPty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const query = useCallback(
    async <T,>(operation: string, params = {}): Promise<T> =>
      (
        await api.request<{ data: T }>(`/api/connectors/${connector.id}/query`, {
          operation,
          params,
        })
      ).data,
    [api, connector.id],
  );
  const load = useCallback(async () => {
    try {
      const [host, list] = await Promise.all([
        query<RemoteHostStatus>("host_status"),
        query<{ jobs: RemoteJob[] }>("host_jobs"),
      ]);
      setStatus(host);
      setJobs(list.jobs);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [query]);
  useEffect(() => {
    let pending = false,
      active = true;
    const poll = async () => {
      if (!active || pending || AppState.currentState !== "active") return;
      pending = true;
      await load();
      pending = false;
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [load]);
  useEffect(() => {
    if (!selected?.id) return;
    let active = true,
      pending = false;
    const poll = async () => {
      if (!active || pending || AppState.currentState !== "active") return;
      pending = true;
      try {
        const { job } = await query<{ job: RemoteJob }>("host_job", { jobId: selected.id });
        if (active) setSelected(job);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [query, selected?.id]);
  async function prepare(operation: string, params: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const action = await api.request<ActionProposal>("/api/actions", {
        kind: "connector.write",
        data: { connectorId: connector.id, operation, params },
      });
      await refresh();
      onClose();
      open({ type: "review", action });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function browser() {
    setBusy(true);
    setError("");
    try {
      const session = await api.request<BrowserSession>("/api/browsers", {
        url: browserAddress(url),
        connectorId: connector.id,
      });
      await refresh();
      onClose();
      open({ type: "browser", browser: session });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={connector.name}
      subtitle="원격 호스트 · 셸 작업과 공유 브라우저"
      onClose={onClose}
      wide
    >
      <View style={{ gap: 16 }}>
        <Card style={{ gap: 8 }}>
          <Text style={s.heading}>{status?.hostname ?? "호스트 확인 중…"}</Text>
          <Text style={s.muted}>
            {status
              ? `${status.platform} · ${status.arch} · ${status.shell}`
              : String(connector.config.baseUrl ?? connector.config.host)}
          </Text>
          {status && (
            <Text style={s.small}>
              셸 {status.capabilities.shell ? "지원" : "미지원"} · 브라우저{" "}
              {status.capabilities.browser ? "지원" : "Host Agent 필요"} · PTY{" "}
              {status.capabilities.pty ? "지원" : "SSH 방식에서 지원"}
            </Text>
          )}
          <Button small onPress={() => void load()}>
            새로고침
          </Button>
        </Card>
        <ErrorNotice error={error} />
        <Card style={{ gap: 8 }}>
          <Text style={s.heading}>원격 셸</Text>
          <Field
            label="작업 디렉터리 (선택)"
            value={cwd}
            onChangeText={setCwd}
            autoCapitalize="none"
          />
          <Field
            label="호스트에서 실행할 명령"
            value={command}
            onChangeText={setCommand}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={status?.platform === "win32" ? "Get-Location" : "pwd"}
          />
          {status?.capabilities.pty && (
            <Button small primary={pty} onPress={() => setPty(!pty)}>
              PTY {pty ? "사용" : "사용 안 함"}
            </Button>
          )}
          <Button
            primary
            busy={busy}
            disabled={!command.trim() || !status?.capabilities.shell}
            onPress={() =>
              void prepare("host_command", {
                command,
                ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
                pty,
              })
            }
          >
            명령 실행 검토
          </Button>
          <Text style={s.small}>
            이 호스트의 로그인 사용자 권한으로 실행됩니다. 설치된 Herdr·Codex 등도 명령으로 호출할
            수 있습니다.
          </Text>
        </Card>
        {status?.capabilities.browser && (
          <Card style={{ gap: 8 }}>
            <Text style={s.heading}>공유 브라우저</Text>
            <Field label="웹사이트 주소" value={url} onChangeText={setUrl} autoCapitalize="none" />
            <Button busy={busy} disabled={!url.trim()} onPress={() => void browser()}>
              이 호스트에서 브라우저 열기
            </Button>
          </Card>
        )}
        <Text style={s.heading}>셸 작업 기록</Text>
        {jobs.length === 0 && <Text style={s.muted}>이 연결에서 실행한 작업이 없습니다.</Text>}
        {jobs.map((job) => (
          <Button key={job.id} small onPress={() => setSelected(job)}>
            {labels[job.status]} · {job.command.slice(0, 80)}
          </Button>
        ))}
        {selected && (
          <Card style={{ gap: 10 }}>
            <Text style={s.heading}>
              {labels[selected.status]} · 종료 코드 {selected.exitCode ?? "대기"}
            </Text>
            <Text selectable style={s.muted}>
              {selected.command}
            </Text>
            {selected.outputTruncated && (
              <Text style={s.small}>출력이 길어 마지막 128 KiB만 표시합니다.</Text>
            )}
            <Text
              selectable
              style={[
                s.text,
                { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12 },
              ]}
            >
              {selected.output.replace(ansi, "") || "출력을 기다리는 중…"}
            </Text>
            {selected.status === "running" && (
              <>
                <Field
                  label="작업에 보낼 입력"
                  value={text}
                  onChangeText={setText}
                  autoCapitalize="none"
                  multiline
                />
                <Button
                  busy={busy}
                  disabled={!text}
                  onPress={() =>
                    void prepare("host_input", { jobId: selected.id, text: `${text}\n` })
                  }
                >
                  입력 전송 검토
                </Button>
                <Button
                  danger
                  busy={busy}
                  onPress={() => void prepare("host_stop", { jobId: selected.id })}
                >
                  작업 중지 검토
                </Button>
              </>
            )}
          </Card>
        )}
      </View>
    </Sheet>
  );
}
