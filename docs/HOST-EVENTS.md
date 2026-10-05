# 호스트 호출 (Host Agent 0.6.0)

원격 PC에서 작업하는 Codex 같은 에이전트가 완료·질문·문제를 OpenMuse 대화에 직접
보냅니다. `muse-cli`의 send/target/파일 입력/중복 방지 키 인터페이스를 참고했습니다.
브라우저 자동화나 원격 프로세스 조회 없이 설치된 Host Agent가 서버 API를 호출하고,
웹앱은 SSE로 보고를 받습니다. 기본 모델이 해당 대화에서 응답하며 기존 승인 설정을 따릅니다.

## 설치와 사용

OpenMuse의 **앱 → 인프라 연결 → 원격 호스트 자동 설치** 명령으로 Host Agent 0.6.0 이상을
설치하면 `openmuse` CLI도 설치됩니다. Windows는 새 터미널에서 PATH가 반영됩니다.
기존 호스트는 새 설치 명령으로 업데이트하며 기존 config.json의 연결 ID와 토큰을 보존합니다.
수동 설치는 패키지의 `install-cli.mjs`를 관리자 권한으로 실행하세요. 수동 Host Agent 설정에는
기존 토큰 외에 `connectorId`와 `enrollmentOrigin`(OpenMuse 서버 origin)이 필요합니다.

```sh
openmuse status
openmuse send --source codex --type completed --message "작업 완료. 테스트 통과." --idempotency-key task-123-completed
openmuse send --source codex --type question --message "두 구현 중 어느 쪽을 선택할까요?" --idempotency-key task-123-question-1
openmuse send --source codex --type error --message "빌드 실패. 원인과 다음 조치는 다음과 같습니다…" --idempotency-key task-123-error-1
openmuse send --source codex --type progress --file report.txt --target THREAD_ID --idempotency-key task-123-progress-1
openmuse delivery show task-123-completed
```

`--message`, `--file`, `--stdin` 중 정확히 하나를 지정합니다. 메시지는 UTF-8 최대 32,000바이트이며
PowerShell에서 여러 줄·따옴표·한글은 UTF-8 파일을 권장합니다. `--task 작업ID`는 보고에 작업
이름을 붙이고, `--no-reply`는 대화에 저장만 하며 AI를 호출하지 않습니다. `--dry-run`은 전송하지
않고 입력만 검증합니다. `openmuse schema`는 API와 명령 계약을 JSON으로 표시합니다.

대상 생략 시 `main`(기본 대화), `--target host`는 호스트별 보고 대화, 대화 ID는 기존 대화로
보냅니다. **호스트 호출 → 현재 대화로 보내기 → 명령 복사**에서 대상 ID가 포함된 명령을
얻을 수 있습니다. `openmuse config set-target THREAD_ID`로 현재 사용자 기본 대상을 저장하고
`openmuse config set-target main`으로 되돌립니다. 다른 소유자의 대화나 보관된 대화에는
전송할 수 없습니다. 응답 중인 대화에는 보고를 대기시켰다가 응답 종료 이벤트로 이어갑니다.

작업하는 에이전트에는 다음처럼 지시할 수 있습니다. 특정 제품의 자동 훅을 설치하거나
전역 에이전트 지침을 변경하지 않으며, 호출 시점은 작업 에이전트가 결정합니다.

> 작업 완료, 사용자 답변 필요, 진행을 막는 문제가 생기면 `openmuse send`로 보고해.
> `--source codex --target main`을 사용하고, 작업 ID와 보고 순서로 고유한
> `--idempotency-key`를 만들어. 재시도할 때는 같은 키와 내용을 유지해.
> 원시 토큰이나 비밀번호는 보고에 넣지 말고, 완료·미완료·질문을 구분해.

## 로컬 HTTP API

Host Agent가 실행 중인 동일 PC에서만 `127.0.0.1:8792`로 호출할 수 있습니다. 설치된
서비스가 자신의 등록 정보로 전달하므로 CLI 사용자가 토큰을 읽거나 로그인할 필요가 없습니다.

```http
POST /events HTTP/1.1
Host: 127.0.0.1:8792
Content-Type: application/json
X-OpenMuse-Client: cli

{"key":"task-123-question-1","target":"main","type":"question","source":"codex","task":"task-123","message":"선택이 필요합니다.","reply":true}
```

- `GET /status`: 등록된 연결 ID, 서버 주소, 대기·실패 건수. 같은 클라이언트 헤더가 필요합니다.
- `GET /events/{URL 인코딩한 key}`: 로컬 영수증과 서버의 최신 전달 상태를 확인합니다.
- 포트를 바꾸려면 Host Agent config.json의 `notifyPort`를 지정하고 서비스를 재시작합니다.
  CLI는 `--port` 또는 `OPENMUSE_NOTIFY_PORT`로 같은 값을 사용합니다.

원격 전송은 `POST /api/host-agent/{connectorId}/events`를 사용하며 등록된 Host Agent
Bearer 토큰을 요구합니다. 워크스페이스 세션이나 로그인 생략 설정으로 이 인증을 대체할 수
없습니다. 신규 보고는 해당 에이전트가 실제 응답하는지도 확인합니다. 연결을 삭제하거나
토큰을 교체하면 이전 토큰은 거부됩니다. 이 토큰은 CLI 사용자에게 반환하지 않습니다.

로컬 알림 포트는 loopback에만 바인딩하며 Origin/Sec-Fetch-Site, 다른 Host 헤더와
클라이언트 헤더가 없는 요청을 거부합니다. PC의 로컬 사용자/프로세스는 **보고만** 제출할 수
있습니다. 이 포트는 관리자 셸이나 브라우저 조작 권한을 제공하지 않습니다. 보고는 사람이
입력한 시스템 지시가 아닌, 해당 호스트/에이전트가 보낸 외부 작업 정보로 표시됩니다.

## 전달 보장과 복구

stdout은 `{ "ok": true, "data": ... }` 또는 `{ "ok": false, "error": ... }` JSON 한 줄입니다.
`queued`는 로컬 디스크에 저장되어 전송 대기, `accepted`는 OpenMuse 서버에 저장됨을 뜻합니다.
`accepted` 안의 `event.status`가 `delivered`일 때 대화 저장/선택한 AI 응답 처리가 끝났습니다.
`running`은 AI 응답 중이며 `failed`/`interrupted`면 대화·오류를 확인하세요. 전송 접수만으로
AI 작업이나 외부 작업이 성공했다고 간주하지 않습니다. CLI 종료 0은 로컬 접수 성공,
2는 잘못된 입력/중복 키 충돌, 3은 Host Agent에 접속할 수 없음, 1은 그 밖의 실패입니다.

서버 연결 실패 시 지수형 대기(최대 60초) 후 같은 보고를 다시 보내며 Host Agent 재시작 후에도
이어갑니다. 서버는 같은 호스트·키·내용을 중복 삽입하지 않고 같은 키의 다른 내용은 거부합니다.
등록 서버/호스트가 바뀌면 이전 대기 보고를 새 서버로 보내지 않습니다. 서버가 AI 응답 도중
재시작되면 중단으로 기록하고 이미 실행했을 수 있는 도구를 자동 재실행하지 않습니다.

대기 보고는 호스트별 최대 100건, 신규 접수는 분당 30건입니다. 서버는 대기 중인 보고와
최근 완료 기록 약 1,000건, UI는 최근 100건, Host Agent는 대기 보고와 최근 영수증 500건을
보관합니다. 자동 정리 이후 영구 중복 방지는 보장하지 않으므로 매 작업/보고마다 새로운 키를
사용하세요. 사용자 답변을 원격 Codex에 자동 주입하는 기능은 제공하지 않습니다.
