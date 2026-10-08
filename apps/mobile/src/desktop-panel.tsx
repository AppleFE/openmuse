import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { BrowserSession } from "../../../packages/domain/src";
import type { ConnectorView } from "../../../packages/domain/src/connectors";
import { BrowserThreadCard } from "./computer";
import { Button, Card, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

type Capability = { available: boolean; reason?: string };
export function DesktopPanel({
  hosts,
  hostId,
  setHostId,
}: {
  hosts: ConnectorView[];
  hostId: string;
  setHostId: (id: string) => void;
}) {
  const { api, workspace, refresh, open } = useWorkspace();
  const [capabilities, setCapabilities] = useState<{ virtual: Capability; native: Capability }>();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setCapabilities(undefined);
    setError("");
    api
      .request<{ desktop: { virtual: Capability; native: Capability }; message?: string }>(
        "/api/automation/capabilities" +
          (hostId ? "?connectorId=" + encodeURIComponent(hostId) : ""),
      )
      .then((result) => {
        if (active) {
          setCapabilities(result.desktop);
          setError(result.message ?? "");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api, hostId, revision]);
  async function start(mode: "virtual" | "native") {
    setBusy(true);
    setError("");
    try {
      const browser = await api.request<BrowserSession>("/api/desktops", {
        mode,
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
    <View style={{ gap: 16 }}>
      <Text style={s.label}>화면을 실행할 호스트</Text>
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button small primary={!hostId} onPress={() => setHostId("")}>
          OpenMuse 서버
        </Button>
        {hosts.map((h) => (
          <Button key={h.id} small primary={hostId === h.id} onPress={() => setHostId(h.id)}>
            {h.name}
          </Button>
        ))}
      </View>
      <Card style={{ gap: 10 }}>
        <Text style={s.heading}>가상 데스크톱</Text>
        <Text style={s.muted}>
          별도의 Linux 화면에서 작업합니다. 네트워크는 격리되며 종료 시 임시 파일이 초기화됩니다. 웹
          탐색은 브라우저 탭에서 사용할 수 있습니다.
        </Text>
        <Text style={s.small}>{capabilities?.virtual.reason}</Text>
        <Button
          primary
          busy={busy}
          disabled={!capabilities?.virtual.available}
          onPress={() => void start("virtual")}
        >
          가상 데스크톱 열기
        </Button>
      </Card>
      <Card style={{ gap: 10 }}>
        <Text style={s.heading}>호스트의 실제 화면</Text>
        <Text style={s.muted}>
          로그인한 사용자의 Windows·macOS·Linux(X11) 화면을 공유합니다. OpenMuse Desktop 보조
          프로그램이 실행 중이어야 합니다. macOS에서는 화면 기록·손쉬운 사용 권한이 필요합니다.
        </Text>
        <Text style={s.small}>{capabilities?.native.reason}</Text>
        <Button
          primary
          busy={busy}
          disabled={!capabilities?.native.available}
          onPress={() => void start("native")}
        >
          호스트 화면 열기
        </Button>
      </Card>
      <ErrorNotice error={error} />
      <Button small onPress={() => setRevision((n) => n + 1)}>
        지원 상태 다시 확인
      </Button>
      {workspace.browsers
        .filter((b) => b.kind === "desktop" && (b.connectorId ?? "") === hostId)
        .map((b) => (
          <BrowserThreadCard key={b.id} browser={b} removable />
        ))}
    </View>
  );
}
