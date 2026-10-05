/** Localize application labels only; preserve model IDs, user content and protocol values. */
export const UI_LOCALE = "ko-KR";

const labels: Record<string, string> = {
  active: "활성",
  closed: "닫힘",
  pending: "대기 중",
  queued: "실행 대기",
  scheduled: "예약됨",
  running: "실행 중",
  waiting: "대기 중",
  waiting_input: "입력 대기",
  waiting_approval: "승인 대기",
  succeeded: "완료",
  completed: "완료",
  failed: "실패",
  cancelled: "취소됨",
  paused: "일시 중지",
  stopped: "중지됨",
  expired: "만료됨",
  accepted: "수락됨",
  dismissed: "닫힘",
  new: "새 항목",
  approved: "승인됨",
  rejected: "거절됨",
  ready: "준비됨",
  starting: "시작 중",
  stopping: "중지 중",
  unavailable: "사용할 수 없음",
  timed_out: "시간 초과",
  planner: "플래너",
  coder: "코더",
  reviewer: "리뷰어",
  Planner: "플래너",
  Coder: "코더",
  Reviewer: "리뷰어",
  custom: "사용자 지정",
  agent: "에이전트",
  plan: "계획",
  document: "문서",
  finance: "재무",
  report: "보고서",
  comparison: "비교",
  sequential: "순차",
  parallel: "병렬",
  chat: "대화",
  tools: "도구 사용",
  coding: "코딩",
  system: "기기 설정",
  light: "라이트",
  dark: "다크",
  warm: "따뜻하게",
  concise: "간결하게",
  thoughtful: "신중하게",
  sky: "하늘색",
  sand: "모래색",
  lilac: "라일락색",
  started: "시작됨",
  resumed: "다시 시작됨",
  retry: "재시도",
  progress: "진행 상황",
  evidence: "근거",
  title: "제목",
  name: "이름",
  summary: "요약",
  description: "설명",
  notes: "메모",
  sources: "출처",
  steps: "단계",
  items: "항목",
  categories: "분류",
  transactions: "거래 내역",
  amount: "금액",
  category: "분류",
  income: "수입",
  spending: "지출",
  saved: "저축액",
  count: "개수",
  period: "기간",
  from: "시작",
  to: "종료",
  date: "날짜",
  amountConvention: "금액 표기 기준",
  observation: "관찰",
  status: "상태",
  artifact: "결과물",
  result: "결과",
  error: "오류",
  step: "단계",
  task: "작업",
  model: "모델",
  tool: "도구",
  memory: "기억",
  notification: "알림",
  team: "팀",
  role: "역할",
  input: "입력",
  approval: "승인",
  Available: "사용 가능",
  "Server key required": "서버 인증 정보 필요",
  Disabled: "비활성화",
  "API key required": "API 키 필요",
  "Understand the outcome": "원하는 결과 파악",
  "Plan the work": "작업 계획 수립",
  "Use connected tools": "연결된 도구 사용",
  "Return a result": "결과 전달",
  "Find the source document": "원본 문서 찾기",
  "Fill a new copy": "새 사본 작성",
  "Prepare a reply": "답장 준비",
  "Wait for your decision": "사용자 결정 대기",
  "Record the outcome": "결과 기록",
  "Check the source": "원본 확인",
  "Compare with the last observation": "이전 관찰 결과와 비교",
  "Report a meaningful change": "의미 있는 변화 보고",
  "Validate transactions": "거래 내역 검증",
  "Calculate the summary": "요약 계산",
  "Save your tracker": "추적 정보 저장",
  "Started working": "작업 시작",
  "Resumed work": "작업 재개",
  "Work completed": "작업 완료",
  "Agent update": "진행 상황 보고",
  "Approved action completed": "승인된 작업 완료",
  "Found the document": "문서 찾기 완료",
  "Saved a filled copy": "작성한 사본 저장",
  "Analyzing the imported transactions": "가져온 거래 내역 분석",
  "A meaningful change was found": "의미 있는 변화 발견",
  "Watch needs attention": "추적 항목 확인 필요",
  "Make a concrete plan for the delegated outcome": "요청한 결과를 위한 구체적인 계획 수립",
  "Read the authorized workspace sources": "접근이 허용된 워크스페이스 자료 읽기",
  "Read the complete selected email thread": "선택한 메일 대화 전체 읽기",
  "Import a selected email PDF attachment": "선택한 메일의 PDF 첨부 파일 가져오기",
  "Inspect the supported fields of a PDF": "PDF에서 지원하는 필드 확인",
  "Save a new PDF using only values supplied by the user": "사용자가 제공한 값으로 새 PDF 저장",
  "Read a public webpage in the agent browser": "에이전트 브라우저에서 공개 웹페이지 읽기",
  "Save a persistent plan, comparison or report": "계획, 비교 또는 보고서 저장",
  "Prepare the exact email for a separate user review": "사용자 검토를 위한 메일 준비",
  "Prepare an event for a separate user review": "사용자 검토를 위한 일정 준비",
  "Pause for a fact or decision that is missing": "추가 정보나 결정을 기다리며 일시 중지",
  "Finish only when the requested outcome is actually achieved": "요청한 결과의 완료 확인",
  "API base URL": "API 기본 URL",
  "Server URL": "서버 URL",
  "API URL": "API URL",
  "API key": "API 키",
  "Personal access token": "개인 액세스 토큰",
  "API access token": "API 액세스 토큰",
  Tailnet: "테일넷",
  "Verify TLS": "TLS 인증서 검증",
  "CA certificate (PEM)": "CA 인증서(PEM)",
  "API token id": "API 토큰 ID",
  "API token secret": "API 토큰 비밀값",
  "wg executable path": "wg 실행 파일 경로",
  Interface: "인터페이스",
  "Read repositories, issues and pull requests from GitHub or GitHub Enterprise.":
    "GitHub 또는 GitHub Enterprise의 저장소, 이슈와 풀 리퀘스트를 읽습니다.",
  "Read repositories, branches, files, commits, issues and pull requests from GitHub or GitHub Enterprise.":
    "GitHub 또는 GitHub Enterprise의 비공개 저장소, 브랜치, 파일 내용, 커밋, 이슈와 풀 리퀘스트를 읽습니다.",
  "Defaults to https://api.github.com. Set for GitHub Enterprise Server.":
    "기본값은 https://api.github.com입니다. GitHub Enterprise 서버 사용 시 변경하세요.",
  "Fine-grained or classic PAT with repository read access.":
    "저장소 읽기 권한이 있는 세분화 또는 클래식 개인 액세스 토큰입니다.",
  "Fine-grained PAT: select the repository and grant Contents read access. Classic PAT: repo scope for private repositories.":
    "세분화 토큰은 대상 저장소와 Contents 읽기 권한을 지정하세요. 클래식 토큰은 비공개 저장소 접근에 repo 범위가 필요합니다.",
  "List devices on a Tailscale tailnet.": "Tailscale 테일넷의 기기 목록을 확인합니다.",
  'Tailnet name, or "-" for the key\'s default tailnet.':
    '테일넷 이름을 입력하세요. 키의 기본 테일넷은 "-"로 지정합니다.',
  "Defaults to https://api.tailscale.com/api/v2.":
    "기본값은 https://api.tailscale.com/api/v2입니다.",
  "tskey-api-… access token or OAuth access token.":
    "tskey-api-… 액세스 토큰 또는 OAuth 액세스 토큰입니다.",
  "List nodes on a self-hosted Headscale coordination server.":
    "자체 호스팅 Headscale 서버의 노드를 확인합니다.",
  "Headscale base URL, for example https://headscale.example.com.":
    "Headscale 기본 URL입니다. 예: https://headscale.example.com",
  "Created with `headscale apikeys create`.": "headscale apikeys create 명령으로 만든 키입니다.",
  "Read nodes, VMs, containers and cluster resources from a Proxmox VE API token.":
    "Proxmox VE API 토큰으로 노드, 가상 머신, 컨테이너와 클러스터 자원을 확인합니다.",
  "Manage nodes, storage, VMs, containers, snapshots, backups and provider tasks with a Proxmox VE API token.":
    "Proxmox VE의 노드·스토리지·VM·컨테이너를 조회하고 전원·설정·스냅샷·백업을 관리합니다.",
  "For example https://pve.example.com:8006.": "예: https://pve.example.com:8006",
  "Disable only for self-signed lab deployments.":
    "자체 서명 인증서를 사용하는 실험 환경에서만 끄세요.",
  "Custom CA bundle for self-signed deployments.":
    "자체 서명 인증서 환경에서 사용하는 사용자 지정 CA 인증서 묶음입니다.",
  "For the default Proxmox certificate, paste /etc/pve/pve-root-ca.pem from the Proxmox host, including BEGIN/END CERTIFICATE lines.":
    "Proxmox 기본 인증서라면 서버 콘솔에서 cat /etc/pve/pve-root-ca.pem을 실행한 결과를 붙여 넣으세요. BEGIN/END CERTIFICATE 줄을 포함해야 합니다. API 토큰 비밀값과 다른 공개 인증서입니다.",
  "user@realm!tokenname, for example monitoring@pve!openmuse.":
    "형식은 user@realm!tokenname입니다. 예: monitoring@pve!openmuse",
  "UUID shown once when the token is created.": "토큰을 만들 때 한 번 표시되는 UUID입니다.",
  "Read local WireGuard interface and peer status via `wg show dump`. Private and preshared keys are never returned.":
    "wg show dump로 로컬 WireGuard 인터페이스와 피어 상태를 확인합니다. 개인 키와 사전 공유 키는 반환하지 않습니다.",
  "Defaults to `wg` on PATH.": "기본값은 PATH에 있는 wg 실행 파일입니다.",
  "Limit status to one interface such as wg0; defaults to all.":
    "wg0처럼 확인할 인터페이스를 지정하세요. 기본값은 전체입니다.",
};

export function uiLabel(value: string) {
  return labels[value] ?? value;
}

const errors: Record<string, string> = {
  "Connect Proxmox before preparing an action": "작업을 준비하기 전에 Proxmox를 연결하세요.",
  "Proxmox is disconnected. Reconnect before approving this action.":
    "Proxmox 연결이 끊겼습니다. 다시 연결한 뒤 작업을 승인하세요.",
  "Proxmox connection changed. Prepare a fresh action.":
    "Proxmox 연결이 변경됐습니다. 작업을 새로 준비하세요.",
  "Provider accepted a write but returned an unrecognized receipt; inspect provider tasks before retrying":
    "서버가 변경 요청을 받았지만 실행 결과를 확인할 수 없습니다. 작업 기록을 먼저 확인하세요.",
  "Configure a Proxmox connector with credentials before preparing a write":
    "인증 정보가 등록된 Proxmox 연결을 먼저 설정하세요.",
  "Provider did not return a target configuration version":
    "서버가 대상 설정의 버전 정보를 반환하지 않았습니다. 대상과 조회 권한을 확인하세요.",
  "Prepare a fresh Proxmox action before execution": "Proxmox 작업을 새로 준비한 뒤 실행하세요.",
  "Connector configuration or credentials changed. Prepare a fresh action.":
    "연결 설정 또는 인증 정보가 변경됐습니다. 작업을 새로 준비하세요.",
  "Proxmox target configuration changed. Prepare a fresh action.":
    "Proxmox 대상 설정이 변경됐습니다. 최신 설정을 확인하고 작업을 새로 준비하세요.",
  "This connector does not support writes": "이 연결은 변경 작업을 지원하지 않습니다.",
  "Provider certificate is not trusted. Configure a CA certificate for this connection.":
    "서버의 인증서를 신뢰할 수 없습니다. 연결 설정에 CA 인증서(PEM)를 등록하세요.",
  "Provider certificate does not match the configured URL.":
    "서버 인증서에 지정된 호스트와 API URL이 다릅니다. 인증서에 포함된 주소로 연결하세요.",
  "Provider certificate has expired.":
    "서버의 인증서가 만료됐습니다. 서버에서 인증서를 갱신하세요.",
  "Provider certificate is not yet valid.":
    "서버 인증서의 유효 기간이 시작되지 않았습니다. 서버의 시간과 인증서를 확인하세요.",
  "Provider did not respond in time": "서버가 제한 시간 안에 응답하지 않았습니다.",
  "Stored conversation history cannot be modified by the client":
    "앱과 서버의 대화 기록이 다릅니다. 페이지를 새로고침한 뒤 답변을 다시 시도하세요. 저장된 대화는 유지됩니다.",
  "Access key is incorrect": "접속 키가 올바르지 않습니다.",
  "Sign in to OpenMuse": "OpenMuse에 로그인하세요.",
  "Session expired. Sign in again.": "세션이 만료됐습니다. 다시 로그인하세요.",
  "Could not open your workspace.": "워크스페이스를 열 수 없습니다.",
  "Failed to fetch": "서버에 연결할 수 없습니다. 연결 상태를 확인하세요.",
  "Network request failed": "네트워크 요청에 실패했습니다. 연결 상태를 확인하세요.",
  "Request failed. Check the server setup and try again.":
    "요청에 실패했습니다. 서버 설정을 확인한 뒤 다시 시도하세요.",
  "Credential storage is not configured. TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes as base64.":
    "서버의 인증 정보 암호화 키 설정이 올바르지 않습니다. 서버 관리자가 TOKEN_ENCRYPTION_KEY를 32바이트의 base64 키로 설정해야 합니다.",
  "Stored credentials could not be decrypted. Reconnect the provider.":
    "저장된 인증 정보를 복호화할 수 없습니다. 토큰을 다시 입력해 연결하세요.",
  "Enter a complete date and time.": "날짜와 시간을 모두 입력하세요.",
  "Choose a valid date and time.": "유효한 날짜와 시간을 선택하세요.",
  "This time does not exist in the selected time zone. Choose another time.":
    "선택한 시간대에 존재하지 않는 시각입니다. 다른 시각을 선택하세요.",
  "Choose a valid time zone.": "유효한 시간대를 선택하세요.",
  "Model is not configured or enabled on this server":
    "서버에 설정됐거나 활성화된 모델이 아닙니다.",
  "The model's server-side provider credential is not configured":
    "모델의 서버 인증 정보가 설정되지 않았습니다.",
  "Invalid address": "잘못된 주소입니다.",
  "Enter a website address, like copilotkit.ai or https://news.ycombinator.com.":
    "copilotkit.ai 또는 https://news.ycombinator.com 같은 웹 주소를 입력하세요.",
};

export function errorLabel(value: string) {
  const text = value.replace(/^Error: /, "");
  if (/Public forks can.?t be made private/i.test(text))
    return "GitHub가 이 요청을 공개 포크의 비공개 전환으로 판정해 거부했습니다 (HTTP 422). 현재 저장소 정보(fork·private)와 연결 계정을 다시 조회하세요. 과거의 실패가 현재 저장소 상태를 뜻하지는 않습니다.";
  if (errors[text]) return errors[text];
  if (text.startsWith("Provider write outcome is unknown; do not retry automatically:"))
    return "변경 요청을 보낸 후 연결이 끊겨 실행 결과를 확인할 수 없습니다. Proxmox 작업 기록과 대상 상태를 먼저 확인하세요.";
  const auth = /^Provider rejected the configured credentials \(HTTP (401|403)\)$/.exec(text);
  if (auth) return `서버가 인증을 거부했습니다 (HTTP ${auth[1]}). 토큰과 접근 권한을 확인하세요.`;
  const request = /^Request failed \((\d+)\)$/.exec(text);
  if (request) return `요청에 실패했습니다 (HTTP ${request[1]}).`;
  return text;
}

/** Localize persisted provider checks as well as fresh test results. */
export function connectorCheckLabel(value: string) {
  const version = /^Proxmox VE (.+) reachable$/.exec(value);
  if (version) return `Proxmox VE ${version[1]} 연결 확인 완료`;
  // Old checks stored before structured TLS errors also need actionable text.
  if (
    /^Provider is unreachable: (unable to verify the first certificate|unable to get (local )?issuer certificate|self[- ]signed certificate)/i.test(
      value,
    )
  ) {
    return errorLabel(
      "Provider certificate is not trusted. Configure a CA certificate for this connection.",
    );
  }
  return errorLabel(value);
}
