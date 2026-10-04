import {
  FileText,
  FolderOpen,
  Globe2,
  Monitor,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { AppState, Image, Pressable, Text, View } from "react-native";
import type { BrowserSession } from "../../../packages/domain/src";
import type { ConnectorView } from "../../../packages/domain/src/connectors";
import { browserAddress } from "./browser-address";
import { useComputerDraft } from "./computer-drafts";
import { LinuxWorkspace } from "./computer-workspace";
import { Button, Card, colors, ErrorNotice, Field, LinkRow, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

export function ComputerEntry() {
  const { workspace, open } = useWorkspace();
  const available = workspace.connections.some(
    (c) => c.id === "browser" && c.status === "connected",
  );
  const active = workspace.browsers.filter((b) => b.status === "active").length;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="에이전트 컴퓨터 직접 제어"
      onPress={() => open({ type: "computer" })}
      style={[
        s.row,
        {
          alignSelf: "center",
          gap: 6,
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: 20,
          backgroundColor: colors.surfaceMuted,
        },
      ]}
    >
      <Monitor size={13} color={colors.muted} />
      <Text style={{ fontSize: 12, color: colors.muted }}>
        컴퓨터
        {!available ? " · 오프라인" : active ? " · 직접 제어" : " · 준비됨"}
      </Text>
      <View
        style={{
          width: 5,
          height: 5,
          borderRadius: 3,
          backgroundColor: available ? "#57AD85" : "#ACB0B5",
        }}
      />
    </Pressable>
  );
}
export function BrowserThreadCard({
  browser,
  removable = false,
}: {
  browser: BrowserSession;
  removable?: boolean;
}) {
  const { open, api, refresh } = useWorkspace();
  const [deleting, setDeleting] = useState(false),
    [error, setError] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [browser.previewUrl, browser.updatedAt]);
  return (
    <Card
      style={{
        padding: 13,
        backgroundColor: colors.surfaceMuted,
        gap: 12,
        maxWidth: 440,
        width: "100%",
      }}
    >
      <View style={[s.row, { gap: 10 }]}>
        <View style={[s.iconBox, { width: 36, height: 36, borderRadius: 9 }]}>
          <Globe2 size={21} color={colors.blueDark} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.text, { fontWeight: "600" }]}>브라우저</Text>
          <Text numberOfLines={1} style={s.small}>
            {browser.status === "closed"
              ? "세션 저장됨"
              : browser.status === "error"
                ? "확인 필요"
                : browser.title}
          </Text>
        </View>
      </View>
      {browser.previewUrl && browser.status === "active" && !failed ? (
        <Image
          accessibilityLabel={`브라우저 미리 보기: ${browser.title}`}
          source={{ uri: browser.previewUrl }}
          style={{
            width: "100%",
            aspectRatio: 1.6,
            borderRadius: 11,
            backgroundColor: colors.card,
          }}
          resizeMode="contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <View
          style={{
            padding: 24,
            borderRadius: 12,
            backgroundColor: colors.card,
            alignItems: "center",
            gap: 10,
          }}
        >
          <Globe2 size={30} color={colors.muted} />
          <Text numberOfLines={2} style={[s.muted, { textAlign: "center" }]}>
            {failed
              ? "미리 보기를 사용할 수 없습니다. 브라우저를 열어 다시 연결하세요."
              : browser.url}
          </Text>
        </View>
      )}
      <Button onPress={() => open({ type: "browser", browser })}>
        {browser.status === "closed"
          ? "브라우저 다시 열기"
          : browser.status === "error"
            ? "브라우저 다시 연결"
            : "직접 제어"}
      </Button>
      {removable && (
        <Button
          small
          danger
          icon={Trash2}
          onPress={() => {
            if (!deleting) {
              setDeleting(true);
              return;
            }
            void api
              .request(`/api/browsers/${browser.id}`, undefined, "DELETE")
              .then(() => refresh())
              .catch((e) => setError(e.message));
          }}
        >
          {deleting ? "로그인·다운로드 포함 삭제 확인" : "세션 삭제"}
        </Button>
      )}
      <ErrorNotice error={error} />
    </Card>
  );
}
export function ComputerSheet() {
  const { workspace, api, refresh, close, open, navigate } = useWorkspace();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hosts, setHosts] = useState<ConnectorView[]>([]);
  const [hostId, setHostId] = useState("");
  const [clearConfirmed, setClearConfirmed] = useState(false);
  const [tab, setTab] = useComputerDraft("tab");
  const available = hostId
    ? hosts.some((host) => host.id === hostId)
    : workspace.connections.some((c) => c.id === "browser" && c.status === "connected");
  useEffect(() => {
    let active = true;
    void api
      .request<{ connectors: ConnectorView[] }>("/api/connectors")
      .then(({ connectors }) => {
        if (active)
          setHosts(
            connectors.filter(
              (host) =>
                host.provider === "remote_host" && host.config.mode === "agent" && host.hasSecret,
            ),
          );
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api]);
  useEffect(() => {
    let active = true;
    const timer = setInterval(() => {
      if (AppState.currentState !== "active") return;
      void refresh().catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);
  async function create() {
    if (busy || !url.trim()) return;
    setBusy(true);
    setError("");
    try {
      const browser = await api.request<BrowserSession>("/api/browsers", {
        url: browserAddress(url),
        ...(hostId ? { connectorId: hostId } : {}),
      });
      await refresh();
      open({ type: "browser", browser });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="에이전트 컴퓨터"
      subtitle="에이전트가 작업하는 공간입니다. 필요할 때 직접 제어하세요."
      onClose={close}
    >
      <View style={{ gap: 20 }}>
        {tab === "브라우저" && (
          <View
            style={[s.row, { gap: 12, padding: 18, borderRadius: 20, backgroundColor: colors.sky }]}
          >
            <Monitor size={28} color={colors.blueDark} />
            <View style={{ flex: 1 }}>
              <Text style={s.heading}>{available ? "브라우저 연결됨" : "브라우저 오프라인"}</Text>
              <Text style={s.muted}>
                {available
                  ? "에이전트의 브라우저와 문서를 한곳에서 확인하세요."
                  : "이 컴퓨터에 연결하려면 브라우저 워커를 시작하세요."}
              </Text>
            </View>
          </View>
        )}
        <View style={[s.row, { gap: 8 }]}>
          {(["브라우저", "터미널", "파일"] as const).map((item) => (
            <Button
              key={item}
              primary={tab === item}
              icon={item === "브라우저" ? Globe2 : item === "터미널" ? Terminal : FolderOpen}
              onPress={() => setTab(item)}
            >
              {item}
            </Button>
          ))}
        </View>
        <View style={{ display: tab === "브라우저" ? "none" : "flex" }}>
          <LinuxWorkspace tab={tab === "파일" ? "파일" : "터미널"} />
        </View>
        <ErrorNotice error={error} />
        {tab === "브라우저" ? (
          <>
            {!!hosts.length && (
              <View style={{ gap: 8 }}>
                <Text style={s.label}>브라우저를 실행할 호스트</Text>
                <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                  <Button small primary={!hostId} onPress={() => setHostId("")}>
                    OpenMuse 서버
                  </Button>
                  {hosts.map((host) => (
                    <Button
                      key={host.id}
                      small
                      primary={hostId === host.id}
                      onPress={() => setHostId(host.id)}
                    >
                      {host.name}
                    </Button>
                  ))}
                </View>
              </View>
            )}
            <View>
              <Field
                label="웹사이트 주소"
                value={url}
                onChangeText={setUrl}
                placeholder="https://example.com"
                autoCapitalize="none"
                keyboardType="url"
                onSubmitEditing={() => void create()}
              />
              <Button
                primary
                icon={Plus}
                busy={busy}
                disabled={!available || !url.trim()}
                onPress={() => void create()}
              >
                브라우저 세션 열기
              </Button>
            </View>
            <View style={[s.row, { gap: 8 }]}>
              <Text style={[s.small, { flex: 1 }]}>
                새 세션을 열 때 종료된 기록을 호스트별 최근 12개·30일 범위로 정리합니다.
              </Text>
              <Button
                small
                danger
                disabled={busy || !workspace.browsers.some((b) => b.status !== "active")}
                onPress={() => {
                  if (!clearConfirmed) {
                    setClearConfirmed(true);
                    return;
                  }
                  setBusy(true);
                  void api
                    .request<{ results: { ok: boolean; error?: string }[] }>(
                      "/api/browsers/delete",
                      {
                        ids: workspace.browsers
                          .filter((b) => b.status !== "active")
                          .map((b) => b.id)
                          .slice(0, 100),
                      },
                    )
                    .then(async (result) => {
                      const failures = result.results.filter((r) => !r.ok);
                      if (failures.length) setError(failures.map((r) => r.error).join("\n"));
                      await refresh();
                      setClearConfirmed(false);
                    })
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                {clearConfirmed ? "종료된 세션 일괄 삭제 확인" : "기록 정리"}
              </Button>
            </View>
            {[...workspace.browsers]
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .map((browser) => (
                <BrowserThreadCard key={browser.id} browser={browser} removable />
              ))}
            {!workspace.browsers.length && (
              <Text style={s.muted}>
                페이지를 열거나 에이전트에게 조사를 요청하세요. 탐색 세션이 여기에 표시됩니다.
              </Text>
            )}
            <Text style={s.small}>
              브라우저 세션마다 로그인과 다운로드가 저장됩니다. 직접 제어한 뒤 대화로 돌아갈 수
              있습니다.
            </Text>
          </>
        ) : tab === "파일" ? (
          <>
            <Text style={s.heading}>문서</Text>
            <Text style={s.small}>메일, 브라우저 다운로드와 업로드에서 저장한 PDF입니다.</Text>
            {workspace.files.map((file) => (
              <LinkRow
                key={file.id}
                icon={FileText}
                title={file.name}
                detail={`${file.pageCount}페이지 · PDF`}
                onPress={() => open({ type: "file", file })}
              />
            ))}
            <Button
              icon={Plus}
              onPress={() => {
                close();
                navigate("files");
              }}
            >
              문서 가져오기
            </Button>
          </>
        ) : null}
        <Button
          small
          icon={RefreshCw}
          onPress={() =>
            void refresh()
              .then(() => setError(""))
              .catch((e) => setError(String(e)))
          }
        >
          컴퓨터 새로고침
        </Button>
      </View>
    </Sheet>
  );
}
