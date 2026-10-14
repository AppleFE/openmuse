import { ShieldCheck } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button, colors, ErrorNotice, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

type Mode = "review" | "bypass";

export function ChatApproval({ threadId, disabled }: { threadId: string; disabled: boolean }) {
  const { api } = useWorkspace();
  const [mode, setMode] = useState<Mode>("review");
  const [ownerMode, setOwnerMode] = useState<Mode>("review");
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setLoaded(false);
    setMode("review");
    void Promise.all([
      api.request<{ mode: Mode }>(
        `/api/copilotkit/threads/${encodeURIComponent(threadId)}/approval`,
      ),
      api.request<{ mode: Mode }>("/api/approval-settings"),
    ])
      .then(([thread, owner]) => {
        if (current) {
          setMode(thread.mode);
          setOwnerMode(owner.mode);
          setLoaded(true);
          setError("");
        }
      })
      .catch((e) => {
        if (current) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      current = false;
    };
  }, [api, threadId]);
  async function save(next: Mode) {
    setBusy(true);
    setError("");
    try {
      const value = await api.request<{ mode: Mode }>(
        `/api/copilotkit/threads/${encodeURIComponent(threadId)}/approval`,
        { mode: next },
        "PUT",
      );
      setMode(value.mode);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function saveOwner(next: Mode) {
    setBusy(true);
    setError("");
    try {
      const value = await api.request<{ mode: Mode }>(
        "/api/approval-settings",
        { mode: next },
        "PUT",
      );
      setOwnerMode(value.mode);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const automatic = ownerMode === "bypass" || mode === "bypass";
  return (
    <>
      <Button small disabled={busy} onPress={() => setOpen(true)}>
        <ShieldCheck size={15} color={automatic ? colors.blueDark : colors.text} />
        {ownerMode === "bypass" ? "전체 자동 승인" : mode === "bypass" ? "자동 승인" : "승인 설정"}
      </Button>
      {open && (
        <Sheet
          title="승인 방식"
          subtitle="전체 설정은 모든 대화와 백그라운드·예약 작업에 적용됩니다."
          onClose={() => setOpen(false)}
        >
          <View style={{ gap: 14 }}>
            <Text style={s.label}>모든 대화·작업</Text>
            <Text style={s.text}>
              전체 자동 승인을 켜면 모든 대화, 위임한 작업, 예약 작업의 브라우저·화면 조작, 연결된
              계정 변경과 셸 작업을 확인 팝업 없이 바로 실행합니다. GitHub·서버의 권한 제한을
              우회하는 기능은 아닙니다.
            </Text>
            <Button
              primary={ownerMode === "bypass"}
              disabled={!loaded || busy}
              onPress={() => void saveOwner("bypass")}
            >
              전체 자동 승인 (승인 없이 진행)
            </Button>
            <Button
              primary={ownerMode === "review"}
              disabled={!loaded || busy}
              onPress={() => void saveOwner("review")}
            >
              대화별 설정 사용
            </Button>
            {ownerMode === "review" && (
              <>
                <Text style={s.label}>이 대화</Text>
                <Text style={s.text}>
                  이 대화와 여기서 위임·예약한 작업에만 적용됩니다. 응답 중에는 변경할 수 없습니다.
                </Text>
                <Button
                  primary={mode === "review"}
                  disabled={!loaded || busy || disabled}
                  onPress={() => void save("review")}
                >
                  매번 승인 요청
                </Button>
                <Button
                  primary={mode === "bypass"}
                  disabled={!loaded || busy || disabled}
                  onPress={() => void save("bypass")}
                >
                  이 대화만 자동 승인 (bypass)
                </Button>
              </>
            )}
            <ErrorNotice error={error} />
          </View>
        </Sheet>
      )}
    </>
  );
}
