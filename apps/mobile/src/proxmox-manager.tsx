import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ActionProposal } from "../../../packages/domain/src";
import type {
  ConnectorOperationInfo,
  ConnectorView,
} from "../../../packages/domain/src/connectors";
import {
  parseProxmoxForm,
  proxmoxBytes,
  proxmoxParamLabel,
  proxmoxValueLabel,
} from "./proxmox-core";
import { Button, Card, colors, ErrorNotice, Field, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

type Guest = {
  vmid: number;
  node: string;
  type: "qemu" | "lxc";
  name: string | null;
  status: string | null;
};
type Storage = {
  storage: string;
  type: string;
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  active: boolean;
  enabled: boolean;
  contentTypes: string[];
};
type Row = Record<string, unknown>;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const powerActions = ["start", "shutdown", "reboot", "stop", "suspend", "resume"] as const;

export function ProxmoxManager({
  connector,
  onClose,
}: {
  connector: ConnectorView;
  onClose: () => void;
}) {
  const { api, open, refresh } = useWorkspace();
  const [nodes, setNodes] = useState<{ node: string; status: string | null }[]>([]),
    [node, setNode] = useState(""),
    [tab, setTab] = useState("storages");
  const [storages, setStorages] = useState<Storage[]>([]),
    [guests, setGuests] = useState<Guest[]>([]),
    [tasks, setTasks] = useState<Row[]>([]),
    [operations, setOperations] = useState<ConnectorOperationInfo[]>([]);
  const [volumes, setVolumes] = useState<{ node: string; storage: string; rows: Row[] }>(),
    [detail, setDetail] = useState<{ guest: Guest; config: Row; snapshots: Row[] }>();
  const [cores, setCores] = useState(""),
    [memory, setMemory] = useState(""),
    [snapshot, setSnapshot] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [epoch, setEpoch] = useState(0);
  const query = async <T,>(operation: string, params: Row = {}): Promise<T> =>
    (await api.request<{ data: T }>(`/api/connectors/${connector.id}/query`, { operation, params }))
      .data;
  useEffect(() => {
    let active = true;
    setBusy(true);
    Promise.all([
      query<{ nodes: { node: string; status: string | null }[] }>("nodes"),
      api.request<{ operations: ConnectorOperationInfo[] }>(
        `/api/connectors/${connector.id}/operations`,
      ),
    ])
      .then(([result, info]) => {
        if (active) {
          setNodes(result.nodes);
          setNode(
            result.nodes.find((n) => n.status === "online")?.node ?? result.nodes[0]?.node ?? "",
          );
          setOperations(info.operations);
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api, connector.id]);
  useEffect(() => {
    if (!node) return;
    let active = true;
    setBusy(true);
    setError("");
    setDetail(undefined);
    setVolumes(undefined);
    setStorages([]);
    setGuests([]);
    setTasks([]);
    Promise.allSettled([
      query<{ storages: Storage[] }>("storages", { node }),
      query<{ resources: Guest[] }>("resources", { node, type: "vm" }),
      query<{ tasks: Row[] }>("tasks", { node, limit: 50 }),
    ])
      .then(([a, b, c]) => {
        if (active) {
          if (a.status === "fulfilled") setStorages(a.value.storages);
          if (b.status === "fulfilled") setGuests(b.value.resources);
          if (c.status === "fulfilled") setTasks(c.value.tasks);
          setError(
            [a, b, c]
              .filter((r) => r.status === "rejected")
              .map((r) => (r.status === "rejected" ? errorText(r.reason) : ""))
              .join("\n"),
          );
        }
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api, connector.id, node, epoch]);
  async function prepare(operation: string, params: Row) {
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
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function contents(storage: string) {
    setBusy(true);
    setError("");
    try {
      const r = await query<{ volumes: Row[] }>("storage_content", { node, storage });
      setVolumes({ node, storage, rows: r.volumes });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function inspect(guest: Guest) {
    setBusy(true);
    setError("");
    try {
      const params = { node: guest.node, kind: guest.type, vmid: guest.vmid };
      const [config, snaps] = await Promise.all([
        query<{ config: Row }>("guest_config", params),
        query<{ snapshots: Row[] }>("snapshots", params),
      ]);
      setDetail({ guest, config: config.config, snapshots: snaps.snapshots });
      setCores(String(config.config.cores ?? ""));
      setMemory(String(config.config.memory ?? ""));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const guestParams = detail
    ? { node: detail.guest.node, kind: detail.guest.type, vmid: detail.guest.vmid }
    : {};
  return (
    <Sheet
      title={`Proxmox 관리: ${connector.name}`}
      subtitle={String(connector.config.baseUrl)}
      onClose={onClose}
    >
      <View style={{ gap: 16 }}>
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          {nodes.map((n) => (
            <Button
              key={n.node}
              small
              disabled={busy}
              primary={node === n.node}
              onPress={() => setNode(n.node)}
            >
              {n.node} · {proxmoxValueLabel(n.status ?? "")}
            </Button>
          ))}
          <Button small busy={busy} onPress={() => setEpoch((v) => v + 1)}>
            새로고침
          </Button>
        </View>
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          {[
            ["storages", "스토리지"],
            ["guests", "VM·컨테이너"],
            ["tasks", "작업 기록"],
            ["operations", "전체 작업"],
          ].map(([id, label]) => (
            <Button
              key={id}
              small
              primary={tab === id}
              onPress={() => {
                setTab(id);
                setDetail(undefined);
                setVolumes(undefined);
              }}
            >
              {label}
            </Button>
          ))}
        </View>
        <ErrorNotice error={error} />
        {!node && !busy && <Text style={s.muted}>이 토큰으로 조회할 수 있는 노드가 없습니다.</Text>}
        {tab === "storages" && (
          <>
            {storages.map((storage) => (
              <Card key={storage.storage} style={{ gap: 10 }}>
                <View style={s.between}>
                  <Text style={s.heading}>{storage.storage}</Text>
                  <Text style={{ color: storage.active ? colors.success : colors.muted }}>
                    {storage.active ? "사용 가능" : "비활성"}
                  </Text>
                </View>
                <Text style={s.small}>
                  {storage.type} · {storage.contentTypes.map(proxmoxValueLabel).join(", ")}
                </Text>
                <Text style={s.text}>
                  {proxmoxBytes(storage.usedBytes)} 사용 / {proxmoxBytes(storage.totalBytes)} 전체 ·{" "}
                  {proxmoxBytes(storage.availableBytes)} 남음
                </Text>
                {!!storage.totalBytes && (
                  <View style={{ height: 7, borderRadius: 4, backgroundColor: colors.line }}>
                    <View
                      style={{
                        height: 7,
                        borderRadius: 4,
                        backgroundColor: colors.blueDark,
                        width: `${Math.min(100, Math.max(0, ((storage.usedBytes ?? 0) / storage.totalBytes) * 100))}%`,
                      }}
                    />
                  </View>
                )}
                <Button small busy={busy} onPress={() => void contents(storage.storage)}>
                  내용물 보기: {storage.storage}
                </Button>
                {volumes?.node === node && volumes.storage === storage.storage && (
                  <View style={{ gap: 8 }}>
                    {volumes.rows.length === 0 ? (
                      <Text style={s.muted}>조회된 볼륨이 없습니다.</Text>
                    ) : (
                      volumes.rows.map((v, i) => (
                        <View key={String(v.volid ?? i)} style={{ gap: 3 }}>
                          <Text selectable style={s.text}>
                            {String(v.volid ?? v.name ?? "")}
                          </Text>
                          <Text style={s.small}>
                            {proxmoxValueLabel(String(v.content ?? ""))} · {proxmoxBytes(v.size)}
                          </Text>
                        </View>
                      ))
                    )}
                  </View>
                )}
              </Card>
            ))}
            {!storages.length && !busy && (
              <Text style={s.muted}>
                조회된 스토리지가 없습니다. 토큰의 Datastore.Audit 권한도 확인하세요.
              </Text>
            )}
          </>
        )}
        {tab === "guests" && (
          <>
            {guests.map((guest) => (
              <Card key={`${guest.type}/${guest.vmid}`} style={{ gap: 10 }}>
                <View style={s.between}>
                  <Text style={s.heading}>
                    {guest.vmid} · {guest.name ?? "이름 없음"}
                  </Text>
                  <Text style={s.small}>{proxmoxValueLabel(guest.status ?? "")}</Text>
                </View>
                <Text style={s.small}>
                  {proxmoxValueLabel(guest.type)} · {guest.node}
                </Text>
                <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                  <Button small busy={busy} onPress={() => void inspect(guest)}>
                    상세 보기: {guest.vmid}
                  </Button>
                  {powerActions
                    .filter((a) => (guest.status === "stopped" ? a === "start" : a !== "start"))
                    .map((action) => (
                      <Button
                        key={action}
                        small
                        danger={action === "stop"}
                        busy={busy}
                        onPress={() =>
                          void prepare("guest_power", {
                            node: guest.node,
                            kind: guest.type,
                            vmid: guest.vmid,
                            action,
                          })
                        }
                      >
                        {proxmoxValueLabel(action)}
                      </Button>
                    ))}
                </View>
              </Card>
            ))}
            {!guests.length && !busy && <Text style={s.muted}>조회된 VM·컨테이너가 없습니다.</Text>}
            {detail && detail.guest.node === node && (
              <Card style={{ gap: 12 }}>
                <Text style={s.heading}>{detail.guest.vmid} 설정·스냅샷</Text>
                <Field
                  label="CPU 코어"
                  value={cores}
                  onChangeText={setCores}
                  keyboardType="numeric"
                />
                <Field label="메모리(MB)" value={memory} onChangeText={setMemory} />
                <Button
                  small
                  busy={busy}
                  disabled={!cores.trim() || !memory.trim()}
                  onPress={() =>
                    void prepare("guest_config_update", {
                      ...guestParams,
                      settings: {
                        cores: Number(cores),
                        memory: detail.guest.type === "qemu" ? memory : Number(memory),
                      },
                    })
                  }
                >
                  CPU·메모리 변경 검토
                </Button>
                <Text selectable style={s.small}>
                  {JSON.stringify(detail.config, null, 2)}
                </Text>
                <Field
                  label="새 스냅샷 이름"
                  value={snapshot}
                  onChangeText={setSnapshot}
                  autoCapitalize="none"
                />
                <Button
                  small
                  busy={busy}
                  disabled={!snapshot.trim()}
                  onPress={() =>
                    void prepare("snapshot_create", { ...guestParams, snapshot: snapshot.trim() })
                  }
                >
                  스냅샷 생성 검토
                </Button>
                {detail.snapshots
                  .filter((snap) => snap.name !== "current")
                  .map((snap) => (
                    <View key={String(snap.name)} style={{ gap: 7 }}>
                      <Text style={s.text}>
                        {String(snap.name)} · {String(snap.description ?? "")}
                      </Text>
                      <View style={[s.row, { gap: 8 }]}>
                        <Button
                          small
                          busy={busy}
                          onPress={() =>
                            void prepare("snapshot_rollback", {
                              ...guestParams,
                              snapshot: snap.name,
                            })
                          }
                        >
                          스냅샷 복원
                        </Button>
                        <Button
                          small
                          danger
                          busy={busy}
                          onPress={() =>
                            void prepare("snapshot_delete", { ...guestParams, snapshot: snap.name })
                          }
                        >
                          스냅샷 삭제
                        </Button>
                      </View>
                    </View>
                  ))}
              </Card>
            )}
          </>
        )}
        {tab === "tasks" && (
          <>
            {tasks.map((task, i) => (
              <ProviderTask
                key={String(task.upid ?? i)}
                task={task}
                node={node}
                connectorId={connector.id}
              />
            ))}
            {!tasks.length && !busy && <Text style={s.muted}>조회된 작업이 없습니다.</Text>}
          </>
        )}
        {tab === "operations" && (
          <OperationForm
            key={node}
            operations={operations}
            node={node}
            busy={busy}
            onRead={async (operation, params) => query(operation, params)}
            onWrite={prepare}
          />
        )}
      </View>
    </Sheet>
  );
}

function ProviderTask({
  task,
  node,
  connectorId,
}: {
  task: Row;
  node: string;
  connectorId: string;
}) {
  const { api } = useWorkspace();
  const [lines, setLines] = useState<{ n: number; t: string }[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function log() {
    setBusy(true);
    setError("");
    try {
      const r = await api.request<{ data: { lines: { n: number; t: string }[] } }>(
        `/api/connectors/${connectorId}/query`,
        { operation: "task_log", params: { node, upid: task.upid, limit: 100 } },
      );
      setLines(r.data.lines);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={{ gap: 8 }}>
      <Text style={s.heading}>
        {String(task.type ?? "작업")} · {String(task.id ?? "")}
      </Text>
      <Text style={s.small}>
        {String(task.status ?? "진행 중")} ·{" "}
        {typeof task.starttime === "number"
          ? new Date(task.starttime * 1000).toLocaleString("ko-KR")
          : ""}
      </Text>
      <Button small busy={busy} onPress={() => void log()}>
        로그 보기
      </Button>
      {lines.map((line) => (
        <Text key={line.n} selectable style={s.small}>
          {line.t}
        </Text>
      ))}
      <ErrorNotice error={error} />
    </Card>
  );
}

function OperationForm({
  operations,
  node,
  busy,
  onRead,
  onWrite,
}: {
  operations: ConnectorOperationInfo[];
  node: string;
  busy: boolean;
  onRead: (operation: string, params: Row) => Promise<unknown>;
  onWrite: (operation: string, params: Row) => Promise<void>;
}) {
  const [selected, setSelected] = useState("node_status"),
    [choosing, setChoosing] = useState(false),
    [values, setValues] = useState<Row>({ node }),
    [json, setJson] = useState(
      '{"type":"dir","storage":"new-storage","path":"/mnt/storage","content":"iso,backup"}',
    ),
    [result, setResult] = useState<unknown>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const operation = operations.find((o) => o.name === selected);
  async function run() {
    if (!operation) return;
    setLoading(true);
    setError("");
    try {
      const params = operation.params.length
        ? parseProxmoxForm(
            operation.params.filter((p) => p.name !== "digest"),
            values,
          )
        : operation.name === "storage_create"
          ? JSON.parse(json)
          : {};
      if (operation.kind === "write") await onWrite(operation.name, params);
      else setResult(await onRead(operation.name, params));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  return (
    <View style={{ gap: 12 }}>
      <Button small onPress={() => setChoosing((v) => !v)}>
        작업 선택: {operation?.label ?? selected}
      </Button>
      {choosing &&
        ["read", "write"].map((kind) => (
          <View key={kind} style={{ gap: 8 }}>
            <Text style={s.heading}>{kind === "read" ? "조회" : "제어·변경"}</Text>
            <View style={[s.row, { gap: 7, flexWrap: "wrap" }]}>
              {operations
                .filter((op) => (op.kind ?? "read") === kind)
                .map((op) => (
                  <Button
                    key={op.name}
                    small
                    onPress={() => {
                      setSelected(op.name);
                      setValues({ node });
                      setResult(undefined);
                      setError("");
                      setChoosing(false);
                    }}
                  >
                    {op.label ?? op.name}
                  </Button>
                ))}
            </View>
          </View>
        ))}
      {operation?.params
        .filter((p) => p.name !== "digest")
        .map((field) => (
          <View key={field.name} style={{ gap: 8 }}>
            {field.type === "boolean" ? (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel={proxmoxParamLabel(field.name)}
                aria-checked={values[field.name] === true}
                onPress={() => setValues((v) => ({ ...v, [field.name]: v[field.name] !== true }))}
                style={s.row}
              >
                <Text style={s.text}>
                  {values[field.name] === true ? "☑" : "☐"} {proxmoxParamLabel(field.name)}
                </Text>
              </Pressable>
            ) : field.enum ? (
              <>
                <Text style={s.label}>{proxmoxParamLabel(field.name)}</Text>
                <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
                  {field.enum.map((value) => (
                    <Button
                      key={value}
                      small
                      primary={values[field.name] === value}
                      onPress={() => setValues((v) => ({ ...v, [field.name]: value }))}
                    >
                      {proxmoxValueLabel(value)}
                    </Button>
                  ))}
                </View>
              </>
            ) : (
              <Field
                label={`${proxmoxParamLabel(field.name)}${field.required ? "" : " (선택)"}`}
                value={String(values[field.name] ?? "")}
                onChangeText={(value) => setValues((v) => ({ ...v, [field.name]: value }))}
                autoCapitalize="none"
                multiline={field.type === "json"}
                keyboardType={field.type === "number" ? "numeric" : "default"}
                placeholder={field.name === "settings" ? '{"cores":4,"memory":4096}' : undefined}
              />
            )}
          </View>
        ))}
      {operation?.name === "storage_create" && (
        <Field
          label="스토리지 설정(JSON)"
          value={json}
          onChangeText={setJson}
          multiline
          autoCapitalize="none"
        />
      )}
      <ErrorNotice error={error} />
      <Button primary busy={busy || loading} disabled={!operation} onPress={() => void run()}>
        {operation?.kind === "write" ? "작업 내용 검토" : "조회 실행"}
      </Button>
      {result !== undefined && (
        <Card>
          <Text selectable style={s.text}>
            {JSON.stringify(result, null, 2)}
          </Text>
        </Card>
      )}
    </View>
  );
}
