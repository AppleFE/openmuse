import { CopilotKitProvider } from "@copilotkit/react-native/headless";
import { StatusBar } from "expo-status-bar";
import {
  Bell,
  Check,
  Lightbulb,
  type LucideIcon,
  Menu,
  MessageCircle,
  PanelsTopLeft,
  Shapes,
  SquareCheck,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { Section, Workspace } from "../../packages/domain/src";
import {
  AgentActivityScreen,
  AgentStatus,
  AppsScreen,
  GoalsScreen,
  IdeasScreen,
} from "./src/agent-ui";
import { AgentWorkspaceProvider, useAgentWorkspace } from "./src/agent-workspace";
import {
  API_URL,
  createSession,
  MuseApi,
  readStoredSessionToken,
  SessionError,
  storeSessionToken,
} from "./src/api";
import { ChatScreen, WorkspaceTools } from "./src/chat";
import { ComputerEntry } from "./src/computer";
import { ComputerDraftProvider } from "./src/computer-drafts";
import { Details } from "./src/details";
import { UI_LOCALE, uiLabel } from "./src/locale";
import { BrowserScreen, CalendarScreen, FilesScreen, MailScreen } from "./src/screens";
import { ThemeProvider, useTheme } from "./src/theme";
import { ThreadsProvider, ThreadsSheet, useMuseThread } from "./src/threads";
import { Button, Card, colors, ErrorNotice, Field, IconButton, Mascot, s } from "./src/ui";
import { type Detail, useWorkspace, WorkspaceContext } from "./src/workspace";

const nav: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "chat", label: "대화", icon: MessageCircle },
  { id: "activity", label: "활동", icon: PanelsTopLeft },
  { id: "ideas", label: "아이디어", icon: Lightbulb },
  { id: "goals", label: "목표", icon: SquareCheck },
  { id: "apps", label: "앱", icon: Shapes },
];
const titles: Partial<Record<Section, { title: string; subtitle: string }>> = {
  activity: { title: "활동", subtitle: "계획, 진행 상황, 결정과 결과를 확인하세요." },
  ideas: { title: "아이디어", subtitle: "연결된 정보를 바탕으로 다음 할 일을 제안합니다." },
  goals: {
    title: "목표",
    subtitle: "장기 목표와 관심 있는 일을 관리하세요.",
  },
  apps: {
    title: "앱",
    subtitle: "연결된 앱, 사용 가능한 기능과 에이전트의 기억을 관리하세요.",
  },
  connections: { title: "앱", subtitle: "연결된 앱과 사용 가능한 기능을 관리하세요." },
  mail: { title: "메일", subtitle: "업무에 필요한 메일을 확인하세요." },
  calendar: { title: "일정", subtitle: "중요한 일을 위한 시간을 마련하세요." },
  browser: { title: "브라우저", subtitle: "저장된 브라우저 세션을 확인하세요." },
  files: { title: "파일", subtitle: "문서, 양식과 작성한 사본을 관리하세요." },
};
export default function App() {
  return (
    <ThemeProvider>
      <MuseApp />
    </ThemeProvider>
  );
}
function MuseApp() {
  const { resolved } = useTheme();
  useEffect(() => {
    if (Platform.OS === "web" && typeof document !== "undefined") {
      document.documentElement.lang = UI_LOCALE;
    }
  }, []);
  const [token, setToken] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [needsAccessKey, setNeedsAccessKey] = useState(false);
  const currentToken = useRef("");
  const connecting = useRef(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const connect = useCallback(async (key?: string) => {
    if (connecting.current) return;
    connecting.current = true;
    setBusy(true);
    setError("");
    try {
      const session = await createSession(key);
      storeSessionToken(session.token);
      currentToken.current = session.token;
      setNeedsAccessKey(false);
      setAccessKey("");
      setToken(session.token);
    } catch (e) {
      if (e instanceof SessionError) setNeedsAccessKey(e.status === 401);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      connecting.current = false;
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    const storedToken = readStoredSessionToken();
    if (storedToken) {
      currentToken.current = storedToken;
      setToken(storedToken);
      setBusy(false);
      return;
    }
    void connect();
  }, [connect]);
  const logout = useCallback(() => {
    // Several expired requests may settle together. Ignore callbacks from an older session.
    if (connecting.current || currentToken.current !== token) return;
    currentToken.current = "";
    storeSessionToken();
    setAccessKey("");
    setError("");
    setToken("");
    void connect();
  }, [connect, token]);
  return (
    <SafeAreaProvider>
      <StatusBar style={resolved === "dark" ? "light" : "dark"} />
      {token ? (
        <CopilotKitProvider
          runtimeUrl={`${API_URL}/api/copilotkit`}
          headers={{ Authorization: `Bearer ${token}` }}
        >
          <WorkspaceApp token={token} onUnauthorized={logout} />
        </CopilotKitProvider>
      ) : (
        <SafeAreaView
          style={{
            flex: 1,
            backgroundColor: colors.canvas,
            justifyContent: "center",
            alignItems: "center",
            padding: 24,
          }}
        >
          <View style={{ width: "100%", maxWidth: 420, gap: 22, alignItems: "center" }}>
            <Mascot size={72} />
            <Text
              style={{ fontSize: 32, color: colors.text, letterSpacing: -1, fontWeight: "500" }}
            >
              OpenMuse에 오신 것을 환영합니다.
            </Text>
            <Text style={[s.muted, { textAlign: "center" }]}>하루에 여유를 더하세요.</Text>
            {busy ? (
              <ActivityIndicator color={colors.blueDark} />
            ) : (
              <Card style={{ width: "100%" }}>
                <ErrorNotice error={error} />
                {needsAccessKey && (
                  <Field
                    label="워크스페이스 접속 키"
                    value={accessKey}
                    onChangeText={setAccessKey}
                    secureTextEntry
                    placeholder="서버에 설정된 접속 키를 입력하세요"
                  />
                )}
                <Button primary onPress={() => void connect(accessKey || undefined)}>
                  {needsAccessKey ? "워크스페이스 열기" : "다시 연결"}
                </Button>
                <Text style={[s.small, { marginTop: 15 }]}>
                  {needsAccessKey ? "이 서버에는 접속 키가 필요합니다. " : ""}
                  OpenMuse 서버 주소: {API_URL}.
                </Text>
              </Card>
            )}
          </View>
        </SafeAreaView>
      )}
    </SafeAreaProvider>
  );
}
function WorkspaceApp({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const api = useMemo(() => new MuseApi(token, onUnauthorized), [token, onUnauthorized]);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [section, setSection] = useState<Section>("chat");
  const [detail, setDetail] = useState<Detail>();
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState<{ id: number; text: string }>();
  const refresh = useCallback(async () => {
    const snapshot = await api.request<Workspace>("/api/workspace");
    setWorkspace(snapshot);
    setError("");
  }, [api]);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, [refresh]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh().catch((e) => setError(String(e)));
    });
    return () => listener.remove();
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5500);
    return () => clearTimeout(timer);
  }, [toast]);
  const navigate = useCallback(
    (next: Section) =>
      setSection(next === "today" ? "chat" : next === "connections" ? "apps" : next),
    [],
  );
  const open = useCallback((next: Detail) => setDetail(next), []);
  const close = useCallback(() => setDetail(undefined), []);
  const ask = useCallback((text: string) => {
    setPrompt({ id: Date.now(), text });
    setSection("chat");
  }, []);
  if (!workspace)
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: colors.canvas,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 18,
        }}
      >
        <Mascot size={56} />
        {error ? (
          <>
            <ErrorNotice error={error} />
            <Button onPress={() => void refresh().catch((e) => setError(String(e)))}>
              다시 시도
            </Button>
          </>
        ) : (
          <>
            <ActivityIndicator color={colors.blueDark} />
            <Text style={s.muted}>워크스페이스를 여는 중…</Text>
          </>
        )}
      </SafeAreaView>
    );
  return (
    <WorkspaceContext.Provider
      value={{ workspace, api, section, navigate, refresh, open, close, notify: setToast, ask }}
    >
      <AgentWorkspaceProvider>
        <ComputerDraftProvider key={token}>
          <ThreadsProvider>
            <WorkspaceShell
              detail={detail}
              toast={toast}
              clearToast={() => setToast("")}
              error={error}
              prompt={prompt}
              onSignOut={onUnauthorized}
            />
          </ThreadsProvider>
        </ComputerDraftProvider>
      </AgentWorkspaceProvider>
    </WorkspaceContext.Provider>
  );
}
function WorkspaceShell({
  detail,
  toast,
  clearToast,
  error,
  prompt,
  onSignOut,
}: {
  detail?: Detail;
  toast: string;
  clearToast: () => void;
  error: string;
  prompt?: { id: number; text: string };
  onSignOut: () => void;
}) {
  const { workspace, section, navigate, open } = useWorkspace();
  const { data } = useAgentWorkspace();
  const {
    selection,
    visited,
    mainId,
    loading: threadsLoading,
    error: threadsError,
    retry: retryThreads,
  } = useMuseThread();
  const [threadsOpen, setThreadsOpen] = useState(false);
  const { width } = useWindowDimensions();
  const desktop = width >= 900;
  const pending =
    (data?.notifications.filter((n) => !n.read).length || 0) +
    workspace.actions.filter((a) => a.status === "awaiting_review").length;
  const activeTask =
    data?.tasks.find(
      (task) => task.status === "waiting_approval" || task.status === "waiting_input",
    ) || data?.tasks.find((task) => task.status === "running");
  const agentName = data?.identity.name || "OpenMuse";
  const status = activeTask
    ? activeTask.status === "waiting_approval"
      ? `검토 준비됨 · ${activeTask.title}`
      : activeTask.status === "waiting_input"
        ? `입력 필요 · ${activeTask.title}`
        : uiLabel(
            activeTask.plan.find((step) => step.status === "running")?.title || activeTask.title,
          )
    : data?.tasks.some((task) => task.status === "queued")
      ? "다음 작업을 준비하는 중…"
      : "필요할 때 언제든 도와드릴게요";
  const title = titles[section] || titles.apps;
  const Screen =
    section === "mail"
      ? MailScreen
      : section === "calendar"
        ? CalendarScreen
        : section === "browser"
          ? BrowserScreen
          : section === "files"
            ? FilesScreen
            : section === "activity"
              ? AgentActivityScreen
              : section === "ideas"
                ? IdeasScreen
                : section === "goals"
                  ? GoalsScreen
                  : AppsScreen;
  const utility = ["mail", "calendar", "browser", "files"].includes(section);
  return (
    <>
      <WorkspaceTools />
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }} edges={["top", "bottom"]}>
        <View
          style={{
            flex: 1,
            width:
              Platform.OS === "web" && width >= 1100 && detail?.type === "browser"
                ? Math.round(width * 0.42)
                : "100%",
            maxWidth: 760,
            alignSelf:
              Platform.OS === "web" && width >= 1100 && detail?.type === "browser"
                ? "flex-start"
                : "center",
          }}
        >
          <View
            style={{
              height: desktop ? 146 : 122,
              paddingTop: desktop ? 14 : 2,
              marginHorizontal: 20,
            }}
          >
            <View style={{ position: "absolute", left: 0, top: 16 }}>
              <IconButton
                icon={Menu}
                label="대화 목록과 메뉴 열기"
                onPress={() => setThreadsOpen(true)}
              />
            </View>
            <View pointerEvents="box-none" style={{ alignItems: "center", gap: 1 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`열기: ${agentName} 활동과 승인 요청`}
                onPress={() => navigate("activity")}
                style={({ pressed }) => ({
                  alignItems: "center",
                  maxWidth: "70%",
                  opacity: pressed ? 0.65 : 1,
                })}
              >
                <Mascot size={desktop ? 58 : 49} variant={data?.identity.avatar} />
                <Text
                  style={{
                    fontSize: 16,
                    fontWeight: "600",
                    color: colors.text,
                    letterSpacing: -0.4,
                  }}
                >
                  {agentName}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{ fontSize: 11, color: colors.muted, marginBottom: 6 }}
                >
                  {status}
                </Text>
              </Pressable>
              {section === "chat" && <ComputerEntry />}
            </View>
            <View style={{ position: "absolute", right: 0, top: 16 }}>
              <IconButton
                icon={Bell}
                label={`알림, ${pending}개 읽지 않음 또는 대기 중`}
                onPress={() => open({ type: "notifications" })}
              />
              {pending > 0 && (
                <View
                  pointerEvents="none"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 4,
                    position: "absolute",
                    top: 7,
                    right: 9,
                    backgroundColor: colors.blueDark,
                  }}
                />
              )}
            </View>
          </View>
          <View style={{ flex: 1, minHeight: 0 }}>
            {section !== "chat" && (
              <ScrollView
                key={section}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: desktop ? 42 : 22, paddingBottom: 28 }}
                keyboardShouldPersistTaps="handled"
              >
                {utility && (
                  <Button
                    small
                    style={{ alignSelf: "flex-start", marginBottom: 18 }}
                    onPress={() => navigate("apps")}
                  >
                    앱으로 돌아가기
                  </Button>
                )}
                <Text style={[s.title, { fontSize: 25, marginBottom: 22 }]}>{title?.title}</Text>
                <ErrorNotice error={error} />
                {section === "apps" ? (
                  <>
                    <AppsScreen />
                    {Platform.OS === "web" && (
                      <Button danger style={{ marginTop: 18 }} onPress={onSignOut}>
                        로그아웃
                      </Button>
                    )}
                  </>
                ) : (
                  <Screen />
                )}
              </ScrollView>
            )}
            <View
              style={{
                display: section === "chat" ? "flex" : "none",
                flex: 1,
                paddingHorizontal: desktop ? 42 : 17,
              }}
            >
              <AgentStatus />
              <ErrorNotice error={threadsError} />
              {threadsError ? (
                <Button onPress={retryThreads}>기본 대화 다시 연결</Button>
              ) : threadsLoading ? (
                <ActivityIndicator color={colors.blueDark} />
              ) : null}
              {!threadsLoading && selection.id !== mainId && (
                <Text style={[s.small, { textAlign: "center", marginBottom: 8 }]}>별도 대화</Text>
              )}
              {visited.map((thread) => (
                <View
                  key={thread.id}
                  style={{ display: selection.id === thread.id ? "flex" : "none", flex: 1 }}
                >
                  <ChatScreen
                    thread={thread}
                    active={section === "chat" && selection.id === thread.id}
                    prompt={selection.id === thread.id ? prompt : undefined}
                  />
                </View>
              ))}
            </View>
          </View>
          <View
            style={{
              paddingHorizontal: 22,
              paddingTop: 10,
              paddingBottom: desktop ? 22 : 7,
              alignItems: "center",
            }}
          >
            <View
              style={{
                flexDirection: "row",
                width: "100%",
                maxWidth: 370,
                padding: 5,
                backgroundColor: colors.surfaceRaised,
                borderRadius: 40,
                shadowColor: colors.shadow,
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.07,
                shadowRadius: 18,
                elevation: 3,
                borderWidth: 1,
                borderColor: colors.line,
              }}
            >
              {nav.map((item) => {
                const active = section === item.id || (item.id === "apps" && utility);
                return (
                  <Pressable
                    key={item.id}
                    accessibilityRole="tab"
                    accessibilityLabel={item.label}
                    accessibilityState={{ selected: active }}
                    onPress={() => navigate(item.id)}
                    style={{
                      flex: 1,
                      height: 47,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: active ? colors.surfaceMuted : "transparent",
                      borderRadius: 28,
                    }}
                  >
                    <item.icon size={23} strokeWidth={1.8} color={colors.text} />
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
        {!!toast && (
          <View
            pointerEvents="box-none"
            style={{ position: "absolute", bottom: 94, left: 20, right: 20, alignItems: "center" }}
          >
            <View
              style={[
                s.row,
                {
                  gap: 10,
                  padding: 14,
                  backgroundColor: colors.text,
                  borderRadius: 20,
                  maxWidth: 560,
                },
              ]}
            >
              <Check size={16} color={colors.blue} />
              <Text style={{ color: colors.inverseText, fontSize: 13, flexShrink: 1 }}>
                {toast}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="알림 닫기"
                onPress={clearToast}
              >
                <X size={16} color={colors.inverseText} />
              </Pressable>
            </View>
          </View>
        )}
        {threadsOpen && <ThreadsSheet onClose={() => setThreadsOpen(false)} />}
        {detail && (
          <Details
            key={
              detail.type === "task"
                ? detail.taskId
                : detail.type === "file"
                  ? detail.file.id
                  : detail.type === "browser"
                    ? detail.browser.id
                    : detail.type === "mail"
                      ? detail.mail.id
                      : detail.type === "review"
                        ? detail.action.id
                        : detail.type === "email"
                          ? JSON.stringify(detail.draft)
                          : detail.type === "event"
                            ? detail.event?.id || "event-new"
                            : detail.type
            }
            detail={detail}
          />
        )}
      </SafeAreaView>
    </>
  );
}
