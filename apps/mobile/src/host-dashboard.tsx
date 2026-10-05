import {
  Activity,
  Cpu,
  HardDrive,
  MemoryStick,
  Monitor,
  Network,
  RefreshCw,
  Zap,
} from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { AppState, Platform, Pressable, Text, View } from "react-native";
import Svg, { Line, Path } from "react-native-svg";
import type { ConnectorView } from "../../../packages/domain/src/connectors";
import type { HostMetricPoint, HostMetricsView } from "../../../packages/domain/src/host-metrics";
import { Button, Card, colors, ErrorNotice, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

export function metricBytes(value: number | null | undefined, suffix = "") {
  if (value == null || !Number.isFinite(value)) return "—";
  let n = Math.max(0, value),
    index = 0;
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  while (n >= 1024 && index < units.length - 1) {
    n /= 1024;
    index++;
  }
  return `${n.toFixed(index ? 1 : 0)} ${units[index]}${suffix}`;
}
const percent = (value: number | null | undefined) =>
  value == null ? "—" : `${value.toFixed(1)}%`;
const clock = (value: string) =>
  new Date(value).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
const age = (seconds: number | null) =>
  seconds === null
    ? "—"
    : `${Math.floor(seconds / 86400)}일 ${Math.floor(seconds / 3600) % 24}시간 ${Math.floor(seconds / 60) % 60}분`;
const stateLabel = (state?: string) =>
  ({ online: "온라인", offline: "연결 안 됨", unsupported: "업데이트 필요" })[state ?? ""] ??
  "조회 중";
const sum = (values: (number | null)[]) =>
  values.some((v) => v !== null) ? values.reduce<number>((a, b) => a + (b ?? 0), 0) : null;

function Trend({
  history,
  fields,
  max,
  minutes,
  format,
}: {
  history: HostMetricPoint[];
  fields: { key: keyof Omit<HostMetricPoint, "at">; color: string; label: string }[];
  max?: number;
  minutes: number;
  format: (n: number) => string;
}) {
  const end = Math.max(Date.now(), Date.parse(history.at(-1)?.at ?? "") || 0),
    start = end - minutes * 60000;
  const points = history.filter((p) => Date.parse(p.at) >= start);
  const values = fields.flatMap((f) =>
    points.map((p) => p[f.key]).filter((n): n is number => typeof n === "number"),
  );
  const ceiling = max ?? Math.max(1, ...values) * 1.15;
  return (
    <View style={{ gap: 5 }}>
      <View style={s.between}>
        <Text style={s.small}>{format(ceiling)}</Text>
        <Text style={s.small}>최근 {minutes}분</Text>
      </View>
      <View
        accessibilityLabel={`${fields.map((f) => f.label).join("·")} 사용량 그래프`}
        style={{ height: 105 }}
      >
        <Svg width="100%" height="100%" viewBox="0 0 400 100" preserveAspectRatio="none">
          {[0, 25, 50, 75, 100].map((y) => (
            <Line key={y} x1="0" x2="400" y1={y} y2={y} stroke={colors.line} strokeWidth="0.7" />
          ))}
          {fields.map((f) => {
            let pen = false,
              previous = 0;
            const path = points
              .map((p) => {
                const n = p[f.key],
                  at = Date.parse(p.at);
                if (n === null) {
                  pen = false;
                  return "";
                }
                const command = pen && at - previous < 20000 ? "L" : "M";
                pen = true;
                previous = at;
                return `${command}${(((at - start) / (end - start)) * 400).toFixed(1)},${(98 - Math.min(1, n / ceiling) * 96).toFixed(1)}`;
              })
              .join(" ");
            return <Path key={f.key} d={path} stroke={f.color} strokeWidth="2" fill="none" />;
          })}
        </Svg>
        {values.length < 2 && (
          <Text style={[s.small, { position: "absolute", top: 42, alignSelf: "center" }]}>
            측정값을 기다리는 중
          </Text>
        )}
      </View>
      <View style={s.between}>
        <Text style={s.small}>{clock(new Date(start).toISOString())}</Text>
        <Text style={s.small}>지금</Text>
      </View>
      <View style={[s.row, { gap: 14, flexWrap: "wrap" }]}>
        {fields.map((f) => (
          <Text key={f.key} style={[s.small, { color: f.color }]}>
            ● {f.label}
          </Text>
        ))}
      </View>
    </View>
  );
}
function Meter({ label, value }: { label: string; value: number | null }) {
  return (
    <View style={{ gap: 6, flex: 1, minWidth: 100 }}>
      <View style={s.between}>
        <Text style={s.small}>{label}</Text>
        <Text style={s.small}>{percent(value)}</Text>
      </View>
      <View
        style={{ height: 5, borderRadius: 4, backgroundColor: colors.line, overflow: "hidden" }}
      >
        <View
          style={{
            width: `${Math.max(0, Math.min(100, value ?? 0))}%`,
            height: 5,
            backgroundColor: value !== null && value > 90 ? colors.danger : colors.blueDark,
          }}
        />
      </View>
    </View>
  );
}
function MetricCard({
  title,
  value,
  icon: Icon,
  children,
}: {
  title: string;
  value: string;
  icon: typeof Cpu;
  children: React.ReactNode;
}) {
  return (
    <Card
      style={{ flexGrow: 1, flexShrink: 1, flexBasis: 380, minWidth: 0, maxWidth: "100%", gap: 14 }}
    >
      <View style={[s.between, { gap: 10, flexWrap: "wrap" }]}>
        <View style={[s.row, { gap: 8 }]}>
          <Icon size={20} color={colors.blueDark} />
          <Text style={s.heading}>{title}</Text>
        </View>
        <Text style={[s.text, { fontSize: 23, fontWeight: "600" }]}>{value}</Text>
      </View>
      {children}
    </Card>
  );
}
export function HostDashboard({
  onClose,
  initialId,
  onManage,
}: {
  onClose: () => void;
  initialId?: string;
  onManage?: (host: ConnectorView) => void;
}) {
  const { api } = useWorkspace();
  const [hosts, setHosts] = useState<ConnectorView[]>([]),
    [data, setData] = useState<Record<string, HostMetricsView>>({});
  const [selected, setSelected] = useState(initialId),
    [error, setError] = useState(""),
    [paused, setPaused] = useState(false),
    [busy, setBusy] = useState(false),
    [minutes, setMinutes] = useState(5),
    [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    let active = true,
      pending = false;
    const visible = () =>
      AppState.currentState === "active" && (Platform.OS !== "web" || !document.hidden);
    const poll = async () => {
      if (!active || pending || !visible() || paused) return;
      pending = true;
      setBusy(true);
      try {
        const { hosts: list } = await api.request<{ hosts: ConnectorView[] }>("/api/hosts");
        if (!active) return;
        setHosts(list);
        setSelected((id) => (list.some((h) => h.id === id) ? id : list[0]?.id));
        setError("");
        let index = 0;
        await Promise.all(
          Array.from({ length: Math.min(3, list.length) }, async () => {
            while (active && index < list.length) {
              const host = list[index++];
              try {
                const response = await api.request<HostMetricsView>(
                  `/api/hosts/${host.id}/metrics`,
                );
                if (active) setData((prev) => ({ ...prev, [host.id]: response }));
              } catch (e) {
                if (active)
                  setData((prev) => ({
                    ...prev,
                    [host.id]: {
                      id: host.id,
                      status: "offline",
                      checkedAt: new Date().toISOString(),
                      sample: prev[host.id]?.sample ?? null,
                      history: prev[host.id]?.history ?? [],
                      error: e instanceof Error ? e.message : String(e),
                    },
                  }));
              }
            }
          }),
        );
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        pending = false;
        if (active) setBusy(false);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000),
      listener = AppState.addEventListener("change", () => void poll());
    const resume = () => void poll();
    if (Platform.OS === "web") document.addEventListener("visibilitychange", resume);
    return () => {
      active = false;
      clearInterval(timer);
      listener.remove();
      if (Platform.OS === "web") document.removeEventListener("visibilitychange", resume);
    };
  }, [api, paused, revision]);
  const host = hosts.find((h) => h.id === selected),
    current = selected ? data[selected] : undefined,
    sample = current?.sample,
    history = current?.history ?? [];
  const online = hosts.filter((h) => data[h.id]?.status === "online").length;
  const networkRx = sample ? sum(sample.network.map((n) => n.rxBps)) : null,
    networkTx = sample ? sum(sample.network.map((n) => n.txBps)) : null;
  const memory =
    sample?.memory.total && sample.memory.used !== null
      ? (sample.memory.used / sample.memory.total) * 100
      : null;
  return (
    <Sheet
      title="원격 호스트 대시보드"
      subtitle="연결된 컴퓨터의 리소스와 상태를 한눈에 확인하세요."
      onClose={onClose}
      wide
    >
      <View style={{ gap: 20 }} testID="host-dashboard">
        <View style={[s.between, { flexWrap: "wrap", gap: 10 }]}>
          <View>
            <Text style={s.heading}>
              전체 {hosts.length}대 · 온라인 {online}대
            </Text>
            <Text style={s.small}>
              {paused ? "자동 새로고침 일시 정지" : "보고 있는 동안 5초마다 수집 · 최근 30분 보관"}
            </Text>
          </View>
          <View style={[s.row, { gap: 8 }]}>
            <Button small onPress={() => setPaused(!paused)}>
              {paused ? "수집 재개" : "수집 일시 정지"}
            </Button>
            <Button small icon={RefreshCw} disabled={busy || paused} onPress={refresh}>
              새로고침
            </Button>
          </View>
        </View>
        <ErrorNotice error={error} />
        {!hosts.length && !busy && (
          <Text style={s.muted}>
            연결된 원격 호스트가 없습니다. 인프라 연결에서 Host Agent 또는 SSH 연결을 추가하세요.
          </Text>
        )}
        <View style={[s.row, { flexWrap: "wrap", gap: 12, alignItems: "stretch" }]}>
          {hosts.map((item) => {
            const report = data[item.id],
              metrics = report?.sample;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={`호스트 선택: ${item.name}`}
                accessibilityState={{ selected: item.id === selected }}
                onPress={() => setSelected(item.id)}
                style={{ flexGrow: 1, flexBasis: 280, minWidth: 0 }}
              >
                <Card
                  style={{
                    borderWidth: 1,
                    borderColor: item.id === selected ? colors.blueDark : colors.line,
                    gap: 12,
                  }}
                >
                  <View style={[s.row, { gap: 9 }]}>
                    <Monitor size={22} color={colors.blueDark} />
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={s.heading}>
                        {item.name}
                      </Text>
                      <Text style={s.small}>
                        {metrics
                          ? `${metrics.platform} · ${metrics.arch}`
                          : String(item.config.platform)}{" "}
                        · {item.config.mode === "ssh" ? "SSH" : "Host Agent"}
                      </Text>
                    </View>
                    <Text
                      style={[
                        s.small,
                        { color: report?.status === "online" ? colors.success : colors.muted },
                      ]}
                    >
                      {stateLabel(report?.status)}
                    </Text>
                  </View>
                  <View style={[s.row, { gap: 15 }]}>
                    <Meter
                      label="CPU"
                      value={report?.status === "online" ? (metrics?.cpu.percent ?? null) : null}
                    />
                    <Meter
                      label="메모리"
                      value={
                        report?.status === "online" &&
                        metrics?.memory.total &&
                        metrics.memory.used !== null
                          ? (metrics.memory.used / metrics.memory.total) * 100
                          : null
                      }
                    />
                  </View>
                </Card>
              </Pressable>
            );
          })}
        </View>
        {host && (
          <View style={{ gap: 16 }}>
            <View style={[s.between, { flexWrap: "wrap", gap: 12 }]}>
              <View style={{ flexShrink: 1 }}>
                <Text style={[s.heading, { fontSize: 22 }]}>{host.name}</Text>
                <Text selectable style={s.small}>
                  {String(host.config.baseUrl ?? `${host.config.host}:${host.config.port ?? 22}`)}
                </Text>
                <Text style={s.small}>
                  {sample?.os} · {sample?.hostname}
                </Text>
              </View>
              {onManage && (
                <Button small onPress={() => onManage(host)}>
                  셸·브라우저 관리
                </Button>
              )}
            </View>
            {!!current?.error && <ErrorNotice error={current.error} />}
            {sample && (
              <>
                <View style={[s.between, { gap: 10, flexWrap: "wrap" }]}>
                  <View>
                    <Text style={s.small}>
                      가동 시간 {age(sample.uptime)} ·{" "}
                      {sample.agentVersion ? `Host Agent ${sample.agentVersion}` : "SSH 직접 조회"}
                    </Text>
                    <Text
                      style={[s.small, current?.status !== "online" && { color: colors.danger }]}
                    >
                      마지막 측정 {clock(sample.collectedAt)}
                      {current?.status !== "online" ? " · 연결 끊김: 이전 측정값입니다" : ""}
                    </Text>
                  </View>
                  <View style={[s.row, { gap: 6 }]}>
                    {[5, 15, 30].map((m) => (
                      <Button key={m} small primary={minutes === m} onPress={() => setMinutes(m)}>
                        {m}분
                      </Button>
                    ))}
                  </View>
                </View>
                <View style={[s.row, { flexWrap: "wrap", gap: 14, alignItems: "stretch" }]}>
                  <MetricCard title="CPU" value={percent(sample.cpu.percent)} icon={Cpu}>
                    <Text style={s.small}>
                      {sample.cpu.model || "프로세서"} · 논리 코어 {sample.cpu.cores}개
                    </Text>
                    <Trend
                      history={history}
                      fields={[{ key: "cpu", color: colors.blueDark, label: "CPU 사용률" }]}
                      max={100}
                      minutes={minutes}
                      format={percent}
                    />
                  </MetricCard>
                  <MetricCard title="메모리" value={percent(memory)} icon={MemoryStick}>
                    <Text style={s.small}>
                      {metricBytes(sample.memory.used)} / {metricBytes(sample.memory.total)} · 사용
                      가능 {metricBytes(sample.memory.available)}
                    </Text>
                    <Trend
                      history={history}
                      fields={[{ key: "memory", color: colors.success, label: "메모리 사용률" }]}
                      max={100}
                      minutes={minutes}
                      format={percent}
                    />
                    <Text style={s.small}>
                      스왑 {metricBytes(sample.memory.swapUsed)} /{" "}
                      {metricBytes(sample.memory.swapTotal)}
                    </Text>
                  </MetricCard>
                  <MetricCard
                    title="디스크 I/O"
                    value={metricBytes(sample.diskIO.readBps, "/s")}
                    icon={Activity}
                  >
                    <Text style={s.small}>
                      읽기 {metricBytes(sample.diskIO.readBps, "/s")} · 쓰기{" "}
                      {metricBytes(sample.diskIO.writeBps, "/s")}
                    </Text>
                    <Trend
                      history={history}
                      fields={[
                        { key: "diskRead", color: colors.blueDark, label: "읽기" },
                        { key: "diskWrite", color: colors.success, label: "쓰기" },
                      ]}
                      minutes={minutes}
                      format={(n) => metricBytes(n, "/s")}
                    />
                  </MetricCard>
                  <MetricCard title="네트워크" value={metricBytes(networkRx, "/s")} icon={Network}>
                    <Text style={s.small}>
                      수신 {metricBytes(networkRx, "/s")} · 송신 {metricBytes(networkTx, "/s")}
                    </Text>
                    <Trend
                      history={history}
                      fields={[
                        { key: "networkRx", color: colors.blueDark, label: "수신" },
                        { key: "networkTx", color: colors.success, label: "송신" },
                      ]}
                      minutes={minutes}
                      format={(n) => metricBytes(n, "/s")}
                    />
                    <Text style={s.small}>
                      인터페이스 합계 · VPN·가상 인터페이스의 트래픽이 중복 집계될 수 있습니다.
                    </Text>
                  </MetricCard>
                  <MetricCard
                    title="에너지"
                    value={
                      sample.energy.watts === null
                        ? "측정 불가"
                        : `${sample.energy.watts.toFixed(2)} W`
                    }
                    icon={Zap}
                  >
                    <Text style={s.small}>{sample.energy.detail}</Text>
                    {sample.energy.watts !== null && (
                      <Trend
                        history={history}
                        fields={[
                          { key: "watts", color: colors.blueDark, label: sample.energy.source },
                        ]}
                        minutes={minutes}
                        format={(n) => `${n.toFixed(1)} W`}
                      />
                    )}
                    <Text style={s.text}>
                      {sample.energy.hasBattery === true
                        ? `배터리 ${percent(sample.energy.percent)} · ${sample.energy.charging ? "충전 중" : sample.energy.acConnected ? "전원 연결됨" : "배터리 사용 중"}`
                        : sample.energy.hasBattery === false
                          ? "배터리 없음"
                          : "배터리 정보 없음"}
                    </Text>
                  </MetricCard>
                </View>
                <Card style={{ gap: 15 }}>
                  <View style={[s.row, { gap: 8 }]}>
                    <HardDrive size={20} color={colors.blueDark} />
                    <Text style={s.heading}>디스크 · 저장 공간</Text>
                  </View>
                  {sample.disks.map((disk) => (
                    <View key={`${disk.device}:${disk.mount}`} style={{ gap: 7 }}>
                      <Text selectable style={s.text}>
                        {disk.mount}
                      </Text>
                      <Text style={s.small}>
                        {disk.device}
                        {disk.type ? ` · ${disk.type}` : ""}
                      </Text>
                      <Meter
                        label={`${metricBytes(disk.used)} / ${metricBytes(disk.total)}`}
                        value={disk.total ? (disk.used / disk.total) * 100 : null}
                      />
                      <Text style={s.small}>사용 가능 {metricBytes(disk.available)}</Text>
                    </View>
                  ))}
                  {!sample.disks.length && (
                    <Text style={s.muted}>조회 가능한 디스크가 없습니다.</Text>
                  )}
                  <Text style={s.small}>
                    볼륨별 용량입니다. APFS 등에서 여러 볼륨이 같은 저장 공간을 공유할 수 있습니다.
                  </Text>
                </Card>
                <Card style={{ gap: 14 }}>
                  <Text style={s.heading}>네트워크 인터페이스</Text>
                  {sample.network.map((net) => (
                    <View key={net.name} style={{ gap: 4 }}>
                      <Text style={s.text}>
                        {net.name} ·{" "}
                        {net.state === "up"
                          ? "연결됨"
                          : net.state === "down"
                            ? "연결 안 됨"
                            : "상태 정보 없음"}
                        {net.speedMbps ? ` · ${net.speedMbps} Mbps` : ""}
                      </Text>
                      <Text style={s.small}>
                        수신 {metricBytes(net.rxBps, "/s")} · 송신 {metricBytes(net.txBps, "/s")}
                      </Text>
                      <Text style={s.small}>
                        누적 수신 {metricBytes(net.rxBytes)} · 누적 송신 {metricBytes(net.txBytes)}
                      </Text>
                    </View>
                  ))}
                </Card>
                {sample.warnings.map((warning) => (
                  <Text key={warning} style={s.small}>
                    {warning}
                  </Text>
                ))}
                <Text style={s.small}>
                  —는 아직 두 번째 표본이 없거나 OS에서 해당 지표를 제공하지 않는 값입니다. 화면을
                  닫거나 앱이 백그라운드로 이동하면 수집을 멈춥니다.
                </Text>
              </>
            )}
          </View>
        )}
      </View>
    </Sheet>
  );
}
