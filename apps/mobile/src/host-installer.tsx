import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Button, Card, ErrorNotice, Field, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";
export function HostInstaller({ onRegistered }: { onRegistered: () => Promise<void> }) {
  const { api } = useWorkspace();
  const [opened, setOpened] = useState(false),
    [name, setName] = useState("새 호스트"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [instruction, setInstruction] = useState<{
      windows: string;
      posix: string;
      expiresAt: number;
      privileges: string;
      network: string;
    }>();
  useEffect(() => {
    if (!opened || !instruction) return;
    const timer = setInterval(() => void onRegistered(), 5000);
    return () => clearInterval(timer);
  }, [opened, instruction, onRegistered]);
  return (
    <>
      <Button small onPress={() => setOpened(true)}>
        원격 호스트 자동 설치
      </Button>
      {opened && (
        <Sheet
          title="Host Agent 자동 설치"
          subtitle="Windows · macOS Apple Silicon · Linux"
          onClose={() => setOpened(false)}
        >
          <View style={{ gap: 12 }}>
            <Field label="연결 이름" value={name} onChangeText={setName} />
            <Button
              primary
              busy={busy}
              disabled={!name.trim()}
              onPress={() => {
                setBusy(true);
                setError("");
                void api
                  .request<typeof instruction>("/api/host-agent/invitations", { name })
                  .then(setInstruction)
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              설치 명령 만들기
            </Button>
            <Text style={s.muted}>
              대상 PC의 터미널에서 명령 하나를 실행하세요. 관리자 인증 후 백그라운드 서비스를
              등록하고 OpenMuse에 자동 연결합니다. 재부팅 후 자동 시작하며 에이전트의 셸 실행을
              허용합니다.
            </Text>
            {instruction && (
              <>
                <Card style={{ gap: 8 }}>
                  <Text style={s.heading}>Windows PowerShell</Text>
                  <Text selectable style={s.small}>
                    {instruction.windows}
                  </Text>
                  <Button small onPress={() => void Clipboard.setStringAsync(instruction.windows)}>
                    Windows 명령 복사
                  </Button>
                </Card>
                <Card style={{ gap: 8 }}>
                  <Text style={s.heading}>macOS · Linux 터미널</Text>
                  <Text selectable style={s.small}>
                    {instruction.posix}
                  </Text>
                  <Button small onPress={() => void Clipboard.setStringAsync(instruction.posix)}>
                    macOS·Linux 명령 복사
                  </Button>
                </Card>
                <Text style={s.small}>
                  {instruction.privileges} · {instruction.network}
                </Text>
                <Text style={s.small}>
                  설치 명령은 1회 등록에 사용할 수 있으며{" "}
                  {new Date(instruction.expiresAt).toLocaleTimeString("ko-KR")}까지 유효합니다. 인증
                  토큰은 대상 PC에서 생성되어 서버에 암호화 저장됩니다. 일반 사용자로 설치한 기존
                  연결은 자동으로 관리자 권한이 되지 않습니다.
                </Text>
                <Button small onPress={() => void onRegistered()}>
                  설치한 연결 확인
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
