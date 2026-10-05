import { ShieldCheck } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button, colors, ErrorNotice, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

export function ChatApproval({ threadId, disabled }: { threadId: string; disabled: boolean }) {
  const { api } = useWorkspace();
  const [mode, setMode] = useState<"review" | "bypass">("review");
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setLoaded(false);
    setMode("review");
    void api
      .request<{ mode: "review" | "bypass" }>(
        `/api/copilotkit/threads/${encodeURIComponent(threadId)}/approval`,
      )
      .then((value) => {
        if (current) {
          setMode(value.mode);
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
  async function save(next: "review" | "bypass") {
    setBusy(true);
    setError("");
    try {
      const value = await api.request<{ mode: "review" | "bypass" }>(
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
  return (
    <>
      <Button small disabled={disabled || busy} onPress={() => setOpen(true)}>
        <ShieldCheck size={15} color={mode === "bypass" ? colors.blueDark : colors.text} />
        {mode === "bypass" ? "자동 승인" : "승인 설정"}
      </Button>
      {open && (
        <Sheet
          title="이 대화의 승인 방식"
          subtitle="다른 대화와 독립적으로 저장되며 새로고침 후에도 유지됩니다."
          onClose={() => setOpen(false)}
        >
          <View style={{ gap: 14 }}>
            <Text style={s.text}>
              자동 승인을 선택하면 이 대화와 여기서 위임한 작업의 연결된 계정 변경·셸 작업을 확인
              팝업 없이 실행합니다. GitHub·서버의 권한 제한을 우회하는 기능은 아닙니다. 별도로 만든
              예약 작업에는 적용되지 않습니다.
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
              자동 승인 (bypass)
            </Button>
            <ErrorNotice error={error} />
          </View>
        </Sheet>
      )}
    </>
  );
}
