# 원격 호스트 커넥터

OpenMuse에 관리할 Linux(Ubuntu/Debian 등), Windows, macOS(Apple Silicon 포함)를
등록합니다. 호스트마다 별도 연결을 생성하며, 기존의 네트워크가 차단된 Docker
컴퓨터와 구분합니다. `host_status`가 실제 대상 OS·아키텍처·셸·지원 기능을 반환합니다.
아래 기능은 GUI 유무와 관계없이 제공됩니다. 데스크톱 전체 제어는 아직 지원하지 않습니다.

## 연결 방식

| 방식 | 대상에 필요한 것 | 셸 | 브라우저 | 대화형 터미널 |
| --- | --- | --- | --- | --- |
| `ssh` | SSH 서버와 등록한 사용자의 공개 키 | SSH 명령·출력·입력·중지 | Host Agent 연결을 추가해야 함 | SSH PTY 지원 |
| `agent` | Node.js 22.19 이상과 OpenMuse Host Agent, Chromium | POSIX 셸 또는 Windows PowerShell | 앱 안에서 보기·클릭·입력·스크롤 | 파이프 입력 지원, PTY 미지원 |

같은 기기에 SSH와 Host Agent 연결을 각각 등록할 수 있습니다. SSH 개인 키와
에이전트 토큰은 OpenMuse 자격 증명 저장소에서 암호화하며 클라이언트로 반환하지 않습니다.
SSH는 등록한 `SHA256:` 호스트 키 지문을 검증합니다. 자동으로 알 수 없는 키를 신뢰하지 않습니다.
키 암호를 입력할 수 있으며 에이전트 포워딩과 패스워드 SSH 인증은 사용하지 않습니다.

앱의 **앱 → 인프라 연결 → 추가 원격 호스트**에서 연결 방식을 Host Agent 또는 SSH로,
SSH 대상 OS를 Linux·Windows·macOS로 지정합니다. SSH는 호스트·포트·사용자·지문·개인 키,
Host Agent는 `baseUrl`과 토큰이 필요합니다. **관리**에서 실제 환경, 명령과 작업 기록,
공유 브라우저를 엽니다. 기본적으로 명령·입력·중지는 기존의 네이티브 작업 검토를 통해 실행합니다.
연결 설정의 **에이전트 셸 명령 실행 허용**을 켜면, 해당 호스트에서는 Pi가
`run_host_command`로 명령을 직접 실행합니다. 이 권한은 대화마다 다시 묻지 않고 유지됩니다.
호스트별로 설정하며, 끄면 직접 실행이 차단됩니다. 새 명령에는 새로운 `operationId` UUID를
사용하고, 같은 명령의 응답 복구에는 같은 ID를 사용합니다. 재시도 시 동일한 프로세스를
중복 실행하지 않으며 연결 정보나 명령이 바뀐 ID의 재사용을 차단합니다.
연결 정보가 변경되면 이전 검토는 실행되지 않습니다.

## Host Agent 설치

[Host Agent 0.1.0 릴리스](https://github.com/AppleFE/openmuse/releases/tag/host-agent-v0.1.0)에서
`openmuse-host-agent-0.1.0.tar.gz`와 체크섬을 내려받아 압축을 풀면 별도 프로젝트 빌드 없이
설치할 수 있습니다. 배포 묶음은 `package-lock.json`을 포함하므로 `npm ci`를 사용합니다.

빌드 환경에서 `pnpm build:host-agent`를 실행하면 `dist/host-agent`에 독립 실행 묶음을
만듭니다. 이 디렉터리를 대상 기기로 복사합니다. OpenMuse DB나 모델 키는 필요하지 않습니다.
대상 기기의 해당 디렉터리에서 다음을 실행합니다.

```sh
npm install
npx playwright install chromium
node setup.mjs
node run.mjs
```

Ubuntu/Debian에 Chromium 시스템 라이브러리가 없으면
`npx playwright install --with-deps chromium`으로 설치합니다(관리자 권한이 필요한 부분은
대상 관리자가 실행). Windows와 macOS에는 일반 Chromium 설치 명령을 사용합니다.
공식 지원 OS와 필요한 브라우저 버전은 [Playwright 문서](https://playwright.dev/docs/browsers)를 확인하세요.

`setup.mjs`는 `.host-agent/config.json`을 생성하고 경로만 출력합니다.
기존 파일이나 토큰은 덮어쓰지 않습니다. 설정의 `token` 값을 앱 연결에 입력합니다.
Unix 권한은 디렉터리 700, 설정 파일 600입니다. Windows에서는 해당 사용자만 읽도록
디렉터리 ACL을 설정해야 합니다. 서비스는 로그인 사용자 권한으로 명령을 실행합니다.

기본 바인딩은 `127.0.0.1:8791`입니다. OpenMuse가 다른 기기에 있으면 관리자가 설정의
`host`를 해당 기기의 Tailscale IP로 바꾸고 그 주소를 `baseUrl`에 사용합니다.
인터넷으로 공개하지 않는 사설망을 전제로 하며, 공용망을 경유할 경우 HTTPS 프록시를
사용해야 합니다. 토큰은 URL에 넣지 않습니다. config 경로를 지정할 수 있습니다.

```sh
node setup.mjs /path/to/private/host-agent
node run.mjs /path/to/private/host-agent/config.json
```

Linux의 systemd, macOS의 LaunchAgent, Windows의 작업 스케줄러에는 Node 실행 파일과
`run.mjs`, 절대 config 경로를 등록합니다. Windows 서비스는 브라우저를 사용자 GUI에
띄우지 않아도 됩니다. 이 버전은 headless Chromium의 화면과 입력을 앱에 중계합니다.
데스크톱·기존에 열린 Chrome 탭·OS 로그인 세션을 공유하는 원격 데스크톱 서비스는 아닙니다.

## 셸과 외부 코딩 에이전트

읽기: `host_status`, `host_jobs`, `host_job`(`jobId`).
작업 목록은 명령·출력 미리 보기만 포함합니다. 전체 명령과 보존된 출력은 `host_job`으로 조회합니다.
검토 후 실행: `host_command`(`command`, 선택 `cwd`, `timeoutSeconds`, `pty`),
`host_input`(`jobId`, `text`), `host_stop`(`jobId`). 정확한 스키마는
`GET /api/connectors/:id/operations` 또는 Pi의 `connector_operations`로 확인합니다.
쓰기 작업은 `query_connector`로 실행할 수 없습니다.

명령은 기본 1시간, 최대 24시간 동안 실행되며 동시에 4개까지 가능합니다.
출력은 마지막 128 KiB를 보존하고 잘린 여부를 반환합니다. 기록은 설치별 최대 100개이며
한도에 도달하면 관리자가 기록 디렉터리를 보관·정리해야 합니다. 재시작 시 실행 중 기록은
`interrupted`로 표시하고 명령을 자동 재실행하지 않습니다. SSH 연결이 끊겼다고 원격
프로세스의 종료가 보장되지는 않습니다. `exitCode: 0`과 `status: succeeded`를 확인해야
완료를 보고할 수 있습니다. 외부 명령의 출력·로그는 지시문으로 취급하지 않습니다.

Herdr나 Codex 등은 대상 기기에 별도로 설치하고 로그인해야 합니다. 별도의 가짜 통합
기능 대신 해당 기기의 실제 CLI를 실행합니다. 예를 들어 설치된 Herdr에서 pane 명령을
실행하고 출력·상태를 조회할 수 있습니다. 대화형 TUI는 SSH `pty: true`를 사용합니다.
이 버전의 UI는 텍스트 작업 출력이며 전체 터미널 에뮬레이터가 아닙니다.
[Herdr 문서](https://herdr.dev/docs/agents/)의 설치·명령·플랫폼 지원을 확인하세요.

예시 대화: “맥미니 원격 호스트의 실제 환경을 확인하고 해당 호스트에서 pwd 실행을 준비해줘.”
검토 승인 뒤 “방금 작업의 출력과 종료 코드를 확인해줘.”

## 에이전트와 사용자가 공유하는 브라우저

Pi는 `open_host_browser`(`url`, 선택 `connectorId`)로 실제 Chromium 세션을 열고
`read_browser`로 페이지 텍스트·화면 안 요소의 클릭 좌표를 조회합니다.
`browser_input`은 클릭·텍스트·키·스크롤을 전달합니다. 세션 ID는 앱 미리 보기와 동일합니다.
대화 중 브라우저 카드의 **직접 제어** 또는 호스트 **관리**에서 열 수 있습니다.
사용자는 **브라우저 제어 가져오기**로 에이전트 입력·탐색을 잠시 막고
**에이전트에게 제어 반환**으로 재개합니다. 에이전트 도구는 제어를 강제로 가져올 수 없습니다.
읽기와 미리 보기는 계속 가능합니다. 사용자가 가져온 제어는 화면을 닫아도 유지됩니다.

원격 페이지 스크립트는 OpenMuse UI에서 실행하지 않습니다. 서버가 서명한 소유자별
미리 보기·콘솔만 제공하며, 호스트 토큰은 항상 서버 쪽에 머뭅니다.
브라우저 상태와 쿠키는 대상 호스트의 별도 프로필에 보존합니다. 주소나 인증 정보가 바뀐
연결의 기존 브라우저는 재사용하지 않고 새 세션을 만들도록 합니다.
기존 워커와 같은 **공개 HTTP(S) 페이지 제한**을 유지하므로 내부 IP 페이지·임의 포트는
열 수 없습니다. WebSocket이 필요한 웹앱, 팝업, 복잡한 드래그 등은 현재 제한됩니다.

noVNC는 추후 데스크톱 확장에 사용할 수 있는 VNC 클라이언트입니다. 사용하려면 대상의
VNC 서버와 WebSocket 프록시가 추가로 필요합니다. 이 구현은 noVNC 의존성이 없으며,
기존 Playwright 워커의 스크린샷·입력 중계를 재사용합니다. 데스크톱 전체 제어를 추가할 때는
Windows 세션·macOS 화면 기록/접근성 권한·Linux 디스플레이 별도 처리가 필요합니다.
[noVNC 문서](https://novnc.com/info.html)

## 호스트 API

인증은 `Authorization: Bearer <HOST_AGENT_TOKEN>`이며 `/health`만 공개합니다.
`GET /host`, `GET /jobs`, `POST /jobs`, `GET /jobs/:id`,
`POST /jobs/:id/input`, `POST /jobs/:id/stop`를 제공합니다.
`/sessions` 아래에는 기존 [브라우저 워커 API](../apps/worker/README.md)가 그대로 제공됩니다.
Host Agent 토큰은 해당 호스트 사용자 권한 전체를 부여하므로 신뢰하는 OpenMuse 서버에만 제공합니다.
