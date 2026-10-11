import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Button, Card, colors, ErrorNotice, s } from "./ui";

type AccountStatus = {
  busy: boolean;
  activeId?: string;
  sharing: boolean;
  error?: string;
  accounts: Array<{ id: string; label: string; email?: string; connected: boolean }>;
};
interface DesktopBridge {
  apiUrl: string;
  session(): Promise<{ token: string; mode: "live" }>;
  status(): Promise<AccountStatus>;
  signIn(id?: string): Promise<AccountStatus>;
  enablePlan(id: string): Promise<AccountStatus>;
  cancelSignIn(): Promise<void>;
  select(id: string): Promise<AccountStatus>;
  signOut(): Promise<AccountStatus>;
  usage(): Promise<void>;
  importGoogleClient(): Promise<{ configured?: boolean; canceled?: boolean }>;
}
declare global {
  interface Window {
    openmuseDesktop?: DesktopBridge;
  }
}
export const desktopBridge = typeof window !== "undefined" ? window.openmuseDesktop : undefined;
const AccountContext = createContext<{
  status?: AccountStatus;
  error: string;
  run: (action: () => Promise<unknown>) => void;
}>({ error: "", run: () => {} });

export function DesktopGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AccountStatus>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!desktopBridge) return;
    let disposed = false;
    const refresh = () =>
      desktopBridge
        .status()
        .then((value) => {
          if (!disposed) setStatus(value);
        })
        .catch(() => {
          if (!disposed) setError("ChatGPT 연결 상태를 확인하지 못했습니다.");
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  if (!desktopBridge) return children;
  const run = (action: () => Promise<unknown>) => {
    setError("");
    void action()
      .then(() => desktopBridge.status())
      .then(setStatus)
      .catch((e) =>
        setError(
          e instanceof Error
            ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, "")
            : "연결 작업에 실패했습니다.",
        ),
      );
  };
  return (
    <AccountContext.Provider value={{ status, error, run }}>
      {status?.sharing ? (
        children
      ) : (
        <View
          style={{
            flex: 1,
            backgroundColor: colors.canvas,
            padding: 40,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <View style={{ width: "100%", maxWidth: 620 }}>
            <Text style={[s.title, { fontSize: 36, marginBottom: 16 }]}>OpenMuse</Text>
            <Text style={[s.text, { marginBottom: 24 }]}>나의 PC에서 시작하는 AI 워크스페이스</Text>
            {status ? <DesktopAccountSettings /> : <ActivityIndicator />}
            <ErrorNotice error={!status ? error : ""} />
          </View>
        </View>
      )}
    </AccountContext.Provider>
  );
}

export function DesktopAccountSettings() {
  const { status, error, run } = useContext(AccountContext);
  if (!desktopBridge) return null;
  const bridge = desktopBridge;
  const active = status?.accounts.find((account) => account.id === status.activeId);
  return (
    <Card>
      <Text style={s.title}>ChatGPT 계정</Text>
      <Text style={[s.text, { marginVertical: 12 }]}>
        {status?.sharing
          ? `Using ChatGPT plan · ${active?.email || active?.label}`
          : "자신의 ChatGPT 계정으로 로그인하세요. 지원되는 요금제와 앱 사용 허용이 필요하며, 사용량은 해당 계정에 반영됩니다."}
      </Text>
      <ErrorNotice error={error || status?.error || ""} />
      <View style={{ gap: 10 }}>
        {status?.accounts.map((account) => (
          <View
            key={account.id}
            style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}
          >
            <Text style={s.text}>
              {account.email || account.label} · {account.label}
              {account.id === status.activeId ? " (선택됨)" : ""}
            </Text>
            <Button
              disabled={status.busy}
              onPress={() =>
                run(() =>
                  account.connected ? bridge.select(account.id) : bridge.enablePlan(account.id),
                )
              }
            >
              {account.connected ? "선택" : "로그인 및 요금제 사용 허용"}
            </Button>
          </View>
        ))}
        {status?.busy ? (
          <Button onPress={() => run(() => bridge.cancelSignIn())}>로그인 취소</Button>
        ) : (
          <Button onPress={() => run(() => bridge.signIn())}>Continue with ChatGPT</Button>
        )}
        <Button onPress={() => run(() => bridge.usage())}>사용량 관리 (Manage usage)</Button>
        {status?.sharing && (
          <Button disabled={status.busy} onPress={() => run(() => bridge.signOut())}>
            ChatGPT 로그아웃
          </Button>
        )}
      </View>
      <Text style={[s.small, { marginTop: 18 }]}>
        대화와 파일은 이 PC에 저장됩니다. 다른 사람의 서버나 계정을 공유하지 않습니다.
        브라우저·컴퓨터 도구는 원격 호스트 연결 후 사용할 수 있습니다.
      </Text>
    </Card>
  );
}
