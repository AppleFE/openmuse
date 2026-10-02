import type { ConnectorOperationParam } from "../../../packages/domain/src/connectors";

export type ProxmoxTokenAccess = {
  tokenId: string;
  permissions: Record<string, Record<string, number | boolean>>;
};

/** Proxmox privilege values are propagation flags; a defined zero still grants access. */
export function proxmoxHasPrivileges(permissions: ProxmoxTokenAccess["permissions"]) {
  return Object.values(permissions).some((privileges) => Object.keys(privileges).length > 0);
}

/** Pi emits its native text-content envelope; other runtimes return the value directly. */
export function proxmoxToolValue(result: unknown): unknown {
  let value = result;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return undefined;
      }
    } else if (
      value &&
      typeof value === "object" &&
      "content" in value &&
      Array.isArray(value.content)
    ) {
      const text = value.content.find(
        (part) => part?.type === "text" && typeof part.text === "string",
      );
      if (!text) return undefined;
      value = text.text;
    } else return value;
  }
  return value;
}

const labels: Record<string, string> = {
  node: "노드",
  kind: "종류",
  vmid: "VM/LXC ID",
  storage: "스토리지",
  action: "전원 작업",
  timeout: "종료 대기 시간(초)",
  settings: "변경할 설정(JSON)",
  newid: "새 VM/LXC ID",
  name: "이름",
  full: "전체 복제",
  target: "대상 노드",
  targetStorage: "대상 스토리지",
  purge: "관련 작업·설정도 제거",
  deleteUnreferencedDisks: "연결되지 않은 디스크도 삭제",
  snapshot: "스냅샷 이름",
  description: "설명",
  vmstate: "메모리 상태 포함",
  mode: "백업 방식",
  compress: "압축",
  archive: "백업 볼륨 ID",
  force: "기존 대상 덮어쓰기",
  volume: "볼륨 ID",
  url: "다운로드 URL",
  filename: "파일 이름",
  content: "내용 유형",
  checksum: "SHA-256 체크섬",
  type: "스토리지 종류",
  path: "디렉터리 경로",
  vgname: "볼륨 그룹",
  thinpool: "씬 풀",
  pool: "ZFS 풀",
  server: "NFS 서버",
  export: "NFS 공유 경로",
  nodes: "사용할 노드",
  disable: "비활성화",
  shared: "공유 스토리지",
  upid: "작업 ID",
  start: "시작 위치",
  limit: "조회 개수",
  source: "작업 범위",
  digest: "설정 버전",
  onboot: "자동 시작",
  cores: "CPU 코어",
  memory: "메모리(MB)",
  tags: "태그",
};
export const proxmoxParamLabel = (key: string) => labels[key] ?? key;
const enumLabels: Record<string, string> = {
  qemu: "가상 머신",
  lxc: "컨테이너",
  start: "시작",
  shutdown: "정상 종료",
  reboot: "재부팅",
  stop: "강제 정지",
  suspend: "일시 중지",
  resume: "재개",
  snapshot: "스냅샷",
  images: "VM 디스크",
  rootdir: "컨테이너 디스크",
  iso: "ISO",
  vztmpl: "컨테이너 템플릿",
  backup: "백업",
  snippets: "스니펫",
  archive: "완료된 작업",
  active: "진행 중",
  all: "전체",
  dir: "디렉터리",
  lvmthin: "LVM 씬 풀",
  zfspool: "ZFS 풀",
  nfs: "NFS",
  running: "실행 중",
  stopped: "정지됨",
  paused: "일시 중지됨",
  online: "온라인",
  offline: "오프라인",
};
export const proxmoxValueLabel = (value: string) => enumLabels[value] ?? value;
export function proxmoxBytes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value === 0) return "0 B";
  const index = Math.min(4, Math.max(0, Math.floor(Math.log(Math.abs(value)) / Math.log(1024))));
  return `${(value / 1024 ** index).toLocaleString("ko-KR", { maximumFractionDigits: 1 })} ${["B", "KiB", "MiB", "GiB", "TiB"][index]}`;
}
export function parseProxmoxForm(
  fields: ConnectorOperationParam[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (raw === undefined || raw === "") {
      if (field.required) throw Error(`${proxmoxParamLabel(field.name)}을 입력하세요.`);
      continue;
    }
    if (field.type === "boolean") {
      if (typeof raw !== "boolean")
        throw Error(`${proxmoxParamLabel(field.name)}의 값을 선택하세요.`);
      params[field.name] = raw;
    } else if (field.type === "number") {
      const num = Number(raw);
      if (!Number.isFinite(num))
        throw Error(`${proxmoxParamLabel(field.name)}에 숫자를 입력하세요.`);
      params[field.name] = num;
    } else if (field.type === "json") {
      try {
        params[field.name] = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        throw Error(`${proxmoxParamLabel(field.name)}의 JSON 형식이 올바르지 않습니다.`);
      }
    } else params[field.name] = String(raw).trim();
  }
  return params;
}
