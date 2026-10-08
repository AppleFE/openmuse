# Release verification

## OpenMuse 0.10.4 — 2026년 10월 8일

- 0.10.3 적용 후 실제 `gpt-6-luna` 재시험에서도 목표 탭 조회가 실패했습니다.
  확대 이미지의 좌표를 전체 화면 좌표처럼 보내는 오류와, 탭 검색 결과의 도메인을
  뒤쪽 페이지의 내용과 혼동하는 응답을 확인했습니다. 각 이미지 직후 실제 크기와
  좌표 환산식을 전달하고, 탭 선택 뒤 주소·본문을 다시 확인하도록 안내를 보강했습니다.
- 운영 OpenMuse와 Windows Host Agent의 같은 화면에서 `gpt-6-sol`이 Chrome 탭 검색,
  기존 Devin 탭 선택, 사용량 확대·판독까지 완료했습니다. 조회만 수행했고 결과를
  실제 화면과 별도로 대조했습니다. 사용자에게 탭을 선택해 달라고 요청하지 않았습니다.
- `gpt-6-luna`는 최종 보강 뒤에도 다른 탭에서 출발한 조회를 완료하지 못했습니다.
  이 버전은 모든 모델의 화면 탐색 성공을 보장하는 수정이 아닙니다. 화면 접근/입력과
  모델의 탐색 판단을 구분하며, 확인되지 않은 페이지 수치를 성공 결과로 취급하지 않습니다.
- 관련 자동화 검사 8개와 서버 타입 검사를 통과했습니다. 각 확대 이미지의 개별
  좌표 환산식, 권한·제어권, 실패 시 후속 동작 중단, 실제 Pi 이미지 전달을 검사했습니다.
  별도 QA 대화는 실행 후 삭제했고 메인 대화의 메시지 해시를 보존했습니다.
- 맥미니 서버를 갱신했습니다. 종료 대기 중인 기존 SSE 연결 때문에 이전 서버의 종료가
  지연되어, 실행 중인 작업이 없는 상태에서 정확한 서버 PID/명령을 확인한 뒤 종료했습니다.
  최종 배포 후 API·웹 정상 상태, 대화·노트·접속 정보 보존을 확인했습니다.
  Host Agent와 화면 보조 프로그램 0.10.2는 변경하지 않았습니다.

## OpenMuse 0.10.3 — 2026년 10월 8일

- 메인 채팅 실행은 정상 종료됐지만 하나의 답변에 연결된 도구 카드 11개가 최종 문장
  아래에 표시됐습니다. 도구 카드 뒤에 답변을 표시하고, 긴 백그라운드 작업 알림은
  기본적으로 접었습니다. 기존 메시지·도구 결과는 그대로 유지합니다.
- 실제 메인 대화 기록을 수정한 웹 빌드에 읽기 전용으로 연결해 1440px/390px에서
  답변이 마지막 도구 아래, 입력창 위에 자동으로 보이는지와 알림 펼치기/접기를
  확인했습니다. 새 메시지를 보내지 않았고 대화 기록 해시가 유지됐습니다.
- 실패했던 두 확대 입력을 재현해 서버 도구 경계에서 차단되고 좌표 수정 안내가
  반환되는지 검사했습니다. 올바른 좌표는 공식 SDK를 거쳐 원형 그대로 전달되고
  이미지가 반환됩니다. 이 검사는 실제 Devin 탭이나 한도 값을 판독한 검사가 아닙니다.
- 자동화·브라우저·대화 관련 검사 33개와 서버/모바일 타입 검사를 통과했습니다.
  웹 빌드를 확인했으며 Host Agent/사용자 화면 보조 프로그램 0.10.2는 호환됩니다.

## OpenMuse / Host Agent 0.10.2 — 2026년 10월 8일

- 0.10.1 최종 점검에서 사용자 보조 프로그램만 재시작한 경우 Host Agent의 활성 표시가
  남아 실제 재연결을 건너뛰는 문제를 추가로 발견했습니다. 같은 세션 열기를 실제 보조
  프로그램까지 전달하도록 수정했습니다. 입력을 재실행하거나 사용자 제어권을 변경하지 않습니다.
- 브라우저/자동화 관련 검사 25개를 통과했고, 서비스 수준의 재연결·제어권 보존 검사도
  추가해 관련 6개를 다시 통과했습니다. 설치된 Windows에서 보조 프로그램만 재시작한 뒤
  같은 기존 세션 ID로 다시 열어 실제 PNG 수신을 확인했습니다. 이 검사는 입력을 보내지 않습니다.

## OpenMuse / Host Agent 0.10.1 — 2026년 10월 8일

- 메인 채팅의 메모장 실행 실패 두 건은 `WIN+r`를 지원하지 않는 키로 거부한 뒤 일반
  브라우저 오류로 바꾸던 문제였습니다. Windows 키 별칭을 추가하고 잘못된 키는
  `INVALID_KEY`/422로 구분했습니다. 실제 SDK → 워커 → 사용자 보조 프로그램 경로를 검사합니다.
- 같은 요청의 셸 조회 실패는 Windows 호스트에 완료 기록이 100개 쌓여 새 실행을 차단한
  별도 문제였습니다. 최근 100개 목록과 완료 기록 보관을 분리하고, 보관된 작업 ID의 재실행과
  다른 명령으로의 재사용을 막았습니다. 동시 접수·101번째 이후 실행·재시작 후 중복 방지를 검사했습니다.
- 설치된 Windows에서 새 셸 명령을 실행한 뒤 기존 100개 기록을 해시로 비교해 보존을 확인했습니다.
  OpenMuse API와 공식 SDK를 거쳐 `WIN+r` → 검증용 파일을 메모장으로 열기 → 한글 입력 →
  Ctrl+S 저장을 실행하고 실제 파일 내용을 확인했습니다. 해당 검증 탭만 닫았으며 메인 채팅
  메시지의 해시가 바뀌지 않았습니다. 화면 보조 프로그램 업데이트도 활성 세션에서 검증했습니다.
- 전체 회귀 검사 389개 중 388개 통과, 기존 선택 검사 1개 건너뜀. 관련 검사 16개와
  서버/워커 타입 검사도 통과했습니다. 설치 시 실행 중인 Python을 먼저
  종료해 venv 파일 잠금을 풀고, 중첩 PowerShell의 CLIXML 출력 오류도 수정했습니다.

## OpenMuse / Host Agent 0.10.0 — 2026년 10월 8일

- 공식 Anthropic browser/computer toolset SDK 0.132.1의 실행 계층을 도입했습니다.
  모델 호출은 기존 Pi/모델 설정을 유지합니다. Anthropic API 키 없이 운영 OpenCodex의
  `gpt-6-luna`가 브라우저 DOM 읽기·스크린샷·탭 이동과 가상 데스크톱 GUI 입력을 완료했습니다.
  모델에 실제 이미지가 전달됐으며, 터미널에 입력한 검증 문자열을 후속 스크린샷으로 확인했습니다.
- 회귀 검사 386개 중 385개 통과, 기존 선택 검사 1개 건너뜀. 추가한 실행 취소 검사와 최종
  수정 관련 검사 17개도 통과했습니다. 서버/모바일/워커 타입 검사, 서버/웹/Host Agent 빌드,
  macOS 배포 검사 16개, 실제 Chromium 자동화/탭 검사 2개를 통과했습니다.
- 운영 웹앱의 별도 QA 대화에서 브라우저와 데스크톱의 실제 noVNC 캔버스 픽셀, 화면 열기,
  사용자 제어 가져오기/반환, 브라우저 탭 추가/닫기를 확인했습니다. JS 실행 오류는 없었습니다.
  검증용 대화와 화면 세션은 종료·삭제했으며 기존 사용자 대화에는 검증 메시지를 넣지 않았습니다.
- 이 Windows PC에서 전용 Tk 테스트 창의 클릭·좌표·한글 입력을 확인했습니다.
  로그인 사용자용 Desktop 보조 프로그램과 자동 시작 작업을 설치하고 반복 설치/재시작을
  검증했습니다. 운영 OpenMuse → Windows Host Agent → 사용자 보조 프로그램 경로로
  실제 화면 PNG를 수신했습니다. 이 마지막 연결 검사에서는 키보드/마우스 입력을 보내지 않았습니다.
- 맥미니 P41의 Docker 가상 데스크톱에서 GUI로 입력한 명령이 만든 파일과 화면을 확인했습니다.
  운영 서버/웹/Host Agent를 배포하고 기존 picker 메시지·노트와 연결 자격 증명의 해시를
  비교해 보존을 확인했습니다. 가상 데스크톱 이미지와 Colima 자동 시작도 설정했습니다.
- macOS 실제 화면과 Linux X11 실제 화면은 구현했지만 해당 OS의 로그인 화면에서 직접
  조작 검증하지 않았습니다. macOS는 화면 기록/손쉬운 사용 허용, Linux는 X11이 필요합니다.
  Windows 잠금/UAC 화면과 Linux Wayland는 지원하지 않습니다. 자세한 사용법과 환경 차이는
  [컴퓨터·브라우저 유즈](COMPUTER-USE.md)에 정리했습니다. 아래 구버전 검증 범위는 당시 기록입니다.

## OpenMuse / Host Agent 0.9.0 — 2026년 10월 7일

- `ba782770-72ba-4de3-b9ed-61b778d09e0d`의 저장된 오류를 확인했습니다. Pi의 병렬 도구 실행에서
  AG-UI 인수 스트림 종료를 실행 완료까지 미루던 것이 원인이었습니다. 인수 전달 직후
  `TOOL_CALL_END`를 보내고 결과는 실행 완료 시 전달하도록 수정했습니다. 실제 AG-UI 검증기를
  거친 병렬 시작/역순 완료와 같은 세션 후속 실행을 검사했습니다.
- 채팅 상단 세션 ID 복사, 팝업 내부 HTTP 복사와 수동 선택 대체 경로를 구현했습니다.
  Host Agent/CLI는 `--target "대화 이름"`과 `--thread-name`을 지원합니다.
  보관함을 포함한 소유자별 이름 중복을 DB 고유 인덱스로 막으며, 기존 중복 이름에는 접미사를
  붙입니다. 이름 충돌로 거부된 생성은 빈 대화를 남기지 않습니다. [사용법](HOST-EVENTS.md).
- 관련 검사 65개, 서버/모바일 타입 검사, 서버/Host Agent 빌드와 운영 웹 빌드를 확인했습니다.
  설치 검사 1개는 새 번들 빌드가 끝나기 전에 실행되어 503을 받았으며, 빌드 완료 후 설치 검사
  3개를 다시 통과했습니다. 변경 코드의 Biome 오류는 없으며 CLI의 기존 스타일 안내는 남아 있습니다.
- 실제 HTTP Chromium에서 클립보드 API가 없는 상태로 세션 ID와 알림 → 호스트 호출 명령을
  복사한 뒤 별도 localhost 보안 컨텍스트에서 클립보드 값을 읽어 일치함을 확인했습니다.
  복사 차단 시 수동 입력창, 이름 중복 UI 오류, 대화 목록의 `…` 메뉴도 확인했습니다.
  1440px/390px·다크/라이트에서 JS 오류와 문서 가로 넘침은 없었습니다.
  실제 iOS/Android 기기에서의 클립보드 검증은 수행하지 않았습니다.
- 같은 채팅에서 두 차례 응답/새로고침 시 새 대화 생성 요청은 0건이었습니다. 삭제된 ID를
  브라우저에 저장한 경우 기본 대화로 돌아가며 새 빈 대화를 만들지 않았습니다. 일반/보관함을
  페이지 자르기 전에 분리하여 보관된 항목이 일반 목록 페이지를 차지하지 않습니다.
- 기존 `picker` 세션에서 `runtime_status`와 `list_connectors`를 실제 호출하고 답변이 완료됐습니다.
  과거 메시지/ID는 유지됐습니다. 설치된 Windows CLI의 `--target picker` 보고는 같은 세션에
  `delivered`로 도착했고 해당 세션에 확인용 보고와 읽기 전용 검증 질문을 남겼습니다.
- 이전 검증에서 남은 활성 Acceptance/배포 점검 대화 3건은 보관 처리했습니다. 사용자 대화는
  보관하지 않았으며, 이번 UI 검사에서 만든 임시 대화는 검사 후 삭제했습니다.
- 맥미니와 Windows Host Agent/CLI를 0.9.0으로 업데이트했습니다. Windows SYSTEM/Highest 예약 작업과
  기존 연결 설정을 유지하고 서비스 실행을 확인했습니다. 맥 배포의 백업 경로 검사가 한 차례
  중단되어 실제 `DATA_DIR`의 `data/app/postgres`를 확인했으며, 정상 종료한 DB를 백업한 뒤
  새 API/웹/Host Agent를 시작해 정상 상태를 확인했습니다.
- 비공개 증거: P41 `verification/sessions-20261007`, 로컬 `artifacts/sessions-*`, Windows
  `C:\ProgramData\OpenMuseHostAgent\verification\sessions-20261007-142249`.

## OpenMuse 0.8.0 — 2026년 10월 6일

- 기본/별도 채팅의 카테고리·이슈·주요 메모와 Markdown 참고 문서를 구현했습니다.
  주요 메모/고정 문서는 매 응답에, 긴 비고정 문서는 해당 채팅에 한정된 읽기 도구로 전달합니다.
  생성한 작업과 팀 역할에는 생성 당시 사본을 전달합니다. [사용법과 제한](CHAT-NOTEBOOK.md).
- 신규 메모 검사 8개와 채팅·스킬·첨부·모델/팀·Pi/Jev 회귀 검사 55개를 확인했습니다.
  소유자/채팅 경계, 동시 최초 저장과 버전 충돌, 보관·복원·삭제, 내용/개수 제한,
  실제 표준 모델 프로토콜과 Pi의 최신 버전 전달, 작업 사본 및 상태 조회의 본문 제외를 검증했습니다.
  표준 모델 검사 픽스처의 키 설정 시점을 수정한 뒤 신규 검사 8개를 다시 통과했습니다.
  서버·모바일 타입 검사, 변경 코드 Biome 검사, 서버 빌드와 운영 웹 빌드가 통과했습니다.
  Biome에는 기존 `pi-tools.ts`의 non-null assertion 경고 1건이 남아 있습니다.
- 맥미니 운영 Chromium에서 작성·문서 고정·미리보기·저장·새로고침 복원,
  이슈 검색과 기본 대화 메모 창을 확인했습니다. 1440px/390px 및 다크/라이트 화면에
  페이지 JS 오류와 문서 가로 넘침은 없었습니다. 화면 크기 변경 직후의 전환 중 캡처는
  애니메이션 완료 후 다시 확인했습니다. 실제 iOS/Android 기기 검증은 수행하지 않았습니다.
- 실제 기본 모델 `oc-gpt-6-luna`/내장 Pi가 메모에만 저장한 IP·포트·확인 코드,
  고정 문서의 경로와 비고정 문서의 확인 코드를 정확히 읽었습니다. 이후 메모 변경과
  내용 전체 삭제를 다음 답변에 반영했고, 다른 채팅에서는 원래 채팅의 정보가 나오지 않았습니다.
  “이 채팅에서만 기억해 줘” 요청은 해당 채팅의 고정 문서로 저장됐습니다.
  확인용 대화는 `b79678fd-f8ff-44bd-8572-b0043eaa4902`와
  `6ff1a8da-b70f-432b-9e08-79b62afcdef9`이며 문서에는 테스트용 주소만 사용했습니다.
- 배포 시 기존 API의 열린 프록시 연결 때문에 종료가 지연됐습니다. 웹 프록시도 재시작하여
  연결을 닫고 기존 API 프로세스의 정상 종료를 확인한 뒤 새 API를 시작했습니다.
  운영 API/웹 상태, 기존 기본 모델, `.env` 및 Host Agent 설정 보존을 확인했습니다.
  Host Agent 바이너리는 0.6.0을 유지합니다.
- 비공개 증거: P41 `verification/notebook-20261006`, 로컬 `artifacts/notebook-*`.

## OpenMuse 0.7.0 — 2026년 10월 6일

- 채팅 이미지·다중 파일·폴더 첨부, 웹 클립보드 붙여넣기·드롭, 상대 경로 유지,
  이미지 미리보기·원본 다운로드·전송 전 제거를 구현했습니다. [사용법과 제한](ATTACHMENTS.md).
- 신규 첨부 검사 8개와 기존 채팅·Pi/Jev·스킬·모델 검사 42개를 확인했습니다.
  소유자/대화 경계, 서명 다운로드, 경로 탈출·변조·크기 제한, PDF 페이지 읽기,
  실제 모델 프로토콜의 이미지 바이트와 ID만 보관하는 대화 기록을 검증했습니다.
  PDF 폰트 경로의 Windows 구분자 문제를 검사에서 발견해 수정하고 첨부 검사를 다시 통과했습니다.
  서버·모바일 타입 검사, 변경 코드 Biome 검사, 서버 빌드와 운영 웹 빌드가 통과했습니다.
- 맥미니 운영 Chromium에서 파일/폴더 선택, 이미지 ClipboardEvent, 파일 DropEvent,
  일반 텍스트 붙여넣기 기본 동작 유지, 첨부 제거, 새로고침 후 복원, 이미지 미리보기,
  다운로드 원본 바이트 일치와 대화 삭제 후 파일 제거를 확인했습니다.
  1440px/390px 화면을 확인했으며 페이지 JS 오류와 문서 가로 넘침은 없었습니다.
  미리보기 닫기 검증의 버튼 이름 오류는 테스트 선택자를 수정해 완료했습니다.
- 실제 `oc-gpt-6-luna`/내장 Pi가 첨부 이미지의 초록색과 TXT/JSON/PDF/드롭 파일에만 있는
  네 값을 정확히 답했습니다. 새로고침 후 후속 질문도 기존 대화 변경 오류 없이 답했습니다.
  확인용 대화: `d6dc81aa-d225-4e5f-97f0-1b32fd067cc0`.
- 운영 서비스 교체 시 기존 서버가 20초 종료 제한을 넘었습니다. 이후 해당 프로세스가
  종료된 것을 확인하고 서비스를 시작했으며 API·웹 상태와 기본 모델 보존을 확인했습니다.
  Host Agent 바이너리는 0.6.0을 유지합니다. 실제 Windows/macOS 시스템 클립보드 조합 전체와
  iOS/Android 기기에서의 업로드 실행을 검증한 것은 아닙니다.
- 비공개 증거: P41 `verification/attachments-20261006`, 로컬 `artifacts/attachments-*`.

## OpenMuse 0.6.1 — 2026년 10월 6일

- Windows에 설치된 Host Agent의 `openmuse send`로 실제 테스트 메시지를 기본 대화에 전송했습니다.
  영수증은 `delivered`이며 저장된 대화에서 AI의 “테스트 메시지를 받았습니다.” 응답을 확인했습니다.
- 수정 전 실제 OpenCodex `/v1/models`는 130개, OpenMuse의 정적 목록은 80개였습니다.
  누락된 50개는 `opengateway/` 경로 모델이었습니다.
- 모델 동기화·모델/팀·OpenCodex 라우팅·설정 검사 25개와 pi/Jev 회귀 검사 23개가 통과했습니다.
  동시 요청 단일화, 60초 캐시, 100개 초과 목록, 기존 ID·기본값·비활성화 보존,
  삭제·재등장, 오류/재시작 복구, 인증, 리다이렉트 차단, 응답 크기 제한을 검증했습니다.
  서버와 모바일 타입 검사, 변경 파일 Biome 검사, 서버 빌드가 통과했습니다.
  한 차례 통합 검사에서 pi 검사가 멈춰 종료했으며 해당 검사 단독 실행 및 pi/Jev 전체 재실행은 통과했습니다.
- 맥미니 운영 배포 후 실제 모델 130개가 OpenCodex 목록과 일치하고 `oc-gpt-6-luna` 기본 선택이 유지됐습니다.
  운영 Chromium의 선택 팝업에서 새 `opengateway/anthropic/claude-opus-5-5` 검색과 수동 갱신을 검증했습니다.
  검증 브라우저를 닫고 65초 후 자동 갱신 시각이 전진한 것을 확인했습니다. 1440px/390px 화면에서
  페이지 오류와 가로 넘침은 없었습니다. `.env`와 Host Agent 설정은 변경하지 않았습니다.
  비공개 증거는 P41 `verification/model-discovery-20261006`와 로컬 `artifacts/model-discovery-*`에 있습니다.
- 동작과 운영 옵션: [모델 자동 갱신](MODEL-DISCOVERY.md). 실제 모든 모델의 추론 성공을 검증한 것은 아닙니다.

## OpenMuse / Host Agent 0.6.0 — 2026년 10월 5일

- 설치된 Host Agent의 로컬 CLI/API에서 완료·질문·문제·진행 보고를 서버로 직접 보냅니다.
  기본 대화/호스트별 대화/기존 대화 지정, UTF-8 파일·표준입력, 중복 방지 키, 전송 영수증,
  선택적인 AI 응답, 바쁜 대화의 순차 전달과 재시작 복구를 구현했습니다.
- 보고 경로에는 별도 Host Agent 인증을 적용했습니다. 워크스페이스 로그인 생략 상태에서도
  일반 세션·잘못된 키·교체한 키·삭제한 호스트·SSH 전용 연결은 호출할 수 없습니다.
  로컬 알림 API는 loopback에만 바인딩하며 브라우저/다른 Host 헤더 요청을 차단합니다.
- 관련 회귀 검사 78개가 통과했습니다. 서버·모바일 타입 검사, 서버·Host Agent 빌드와
  운영 웹 번들을 확인했습니다. 추가 동시 중복·토큰 교체 검사를 포함한 호출 검사 3개도
  다시 통과했습니다. GitHub Actions나 실제 Linux 설치의 성공을 주장하지 않습니다.
- 실제 Windows CLI 권한 검사에서 재귀 ACL 초기화가 파일 접근을 제거하는 문제를 발견해,
  설치 폴더에 권한을 지정하고 파일은 상속하도록 수정했습니다. 재설치 후 CLI 실행과
  Users 읽기·실행 권한을 확인했으며 Host Agent 비밀 설정은 공개하지 않았습니다.
- 맥미니와 Windows의 기존 연결 ID·토큰·설정을 보존하면서 Host Agent를 업데이트했습니다.
  Windows는 SYSTEM/Highest/부팅 트리거의 예약 작업으로 실행 중이고, 맥미니는 기존 사용자
  서비스 권한을 유지합니다. CLI와 127.0.0.1:8792의 실제 동작을 양쪽에서 확인했습니다.
- 운영 Chromium에서 맥미니·Windows CLI 보고가 새로고침 없이 표시되고, 실제 기본 모델이
  질문 보고에 답하며 중복 키는 메시지 1건만 남기는 것을 확인했습니다. 새로고침 후 기록도
  유지됐습니다. 보고 수신 과정에서 원격 작업 조회 요청은 0건, 페이지 JS 오류는 0건입니다.
  1440px/390px·다크/라이트와 모달 전환 후 레이아웃을 확인했습니다.
- 비공개 증거: P41 `verification/host-events-20261005`, Windows
  `C:\ProgramData\OpenMuseHostAgent\verification\host-events-20261005`, 로컬 `artifacts/host-events-*`.
  사용법과 전달 상태의 의미는 [호스트 호출](HOST-EVENTS.md)에 정리했습니다.

## OpenMuse 0.5.2 — 2026년 10월 5일

- 명시적인 `OPENMUSE_AUTH_MODE=none` 설정으로 웹앱 접속 키 입력을 생략합니다. 기존 기본값은
  `access-key`이며 live 모드에서 키가 누락되면 여전히 시작을 거부합니다. 내부 세션 검증,
  vault 키, 커넥터와 Host Agent 인증은 유지합니다.
- 맥미니 P41 운영 설정을 `none`으로 변경하고 접속 키 항목을 제거했습니다. API·웹을 빌드하고
  재시작했으며, 나머지 환경 설정·커넥터·기본 모델과 Host Agent 파일의 보존을 확인했습니다.
- API·설정 검사 14개, macOS 배포 검사 16개, 서버·모바일 타입 검사, 서버·웹 빌드가 통과했습니다.
  변경 파일의 Biome 검사와 diff 공백 검사도 완료했습니다. GitHub Actions의 결과를 뜻하지 않습니다.
- 운영 Chromium의 새 브라우저에서 키 없는 진입, 새로고침 시 기존 세션 재사용, 만료된 세션의
  자동 복구를 검증했습니다. 오래된 인증 실패 응답 3개를 지연 전달해도 세션 발급은 1회였습니다.
  연결 오류 후 키 입력 없이 재시도, 보호 모드의 키 입력 표시도 화면 응답 주입으로 검사했습니다.
- 1440px·390px 화면을 확인했고 가로 넘침과 페이지 JavaScript 오류가 없었습니다. 사용자 대화는
  전송하지 않았으며, 운영 증거는 P41 `verification/keyless-20261005`에 보관했습니다.

## OpenMuse 0.5.1 — 2026년 10월 5일

- Windows PowerShell 5.1의 기존 터미널에서 `irm | iex` 설치가 null 메서드 호출 오류로
  중단된 기록을 확인했습니다. 실패 당시 정확한 식은 기록되지 않아 원인을 단정하지 않습니다.
  동일 스크립트를 별도 `-NoProfile` 프로세스에서 실행해 실제 Windows 설치를 완료했습니다.
- 설치 진입 스크립트가 한글을 보존하는 BOM 파일을 만들고 독립 PowerShell에서 실행하도록
  변경했습니다. 체크섬·아키텍처의 null 값은 명시적으로 처리하고 설치 로그는 finally에서
  종료합니다. 관리자 인증 프로세스의 종료를 기다리며 실패를 원래 터미널에 전달합니다.
- 실제 Windows PowerShell 5.1에서 호출자의 Get-FileHash가 null을 반환해도 자식 설치기가
  정상 해시를 얻는지, 한글 파일·본문, 임시 파일 정리, 자식 종료 코드 실패 전달을 검사했습니다.
  설치·등록·만료 검사 3개와 호스트·지표 검사 13개, 서버 타입 검사와 빌드가 통과했습니다.
- 사용자 Windows PC를 기존 맥미니 OpenMuse에 등록했습니다. SYSTEM·최고 권한·부팅 트리거,
  CPU 16논리 코어·약 64GiB 메모리, 맥미니에서의 실제 리소스 조회, SYSTEM에서 Chromium으로
  공개 시험 페이지 열기·읽기를 확인했고 시험 브라우저 프로필을 삭제했습니다.
  재부팅 자체는 수행하지 않았습니다. Host Agent 런타임은 0.5.0을 그대로 사용합니다.
- 비공개 운영 증거: P41 `verification/windows-installer-20261005` 및 로컬 `artifacts/windows-*`.

## OpenMuse 0.5.0 — 2026년 10월 5일

- 원격 호스트 대시보드에 CPU·메모리·디스크 I/O·네트워크 그래프, 볼륨별 용량, 호스트 정보와
  배터리·지원 센서 전력을 추가했습니다. 인증된 Host Agent와 고정된 읽기 전용 SSH 명령을
  사용하며, 5초 수집·최근 30분/최대 360개 표본 보관·중복 요청 병합·오류 구간을 검사했습니다.
- Windows 회귀 검사 342개가 통과했습니다. 기존 noVNC 검사는 시간 초과로 중단되어 맥미니에서
  동일한 Raw/Tight JPEG 검사 2개를 별도 실행했고 모두 통과했습니다. POSIX 가짜 Docker를
  사용하는 기존 Windows 검사 1개는 건너뛰었습니다. 호스트·설치·권한 관련 검사 15개는 양쪽
  OS에서 통과했고, 마지막 Linux 카운터 정밀도 수정 후 호스트 지표 검사 4개도 통과했습니다.
- 서버/모바일 타입 검사, lint(기존 경고 포함), 서버·Host Agent 빌드, 웹·iOS·Android 번들 생성,
  macOS 배포 검사 15개가 성공했습니다. 실제 네이티브 모바일 기기 구동은 검증하지 않았습니다.
- Windows 실제 Host Agent와 CIM 조회, macOS 실제 Host Agent와 SSH 조회에서 CPU·메모리·
  디스크·네트워크 데이터를 확인했습니다. Linux SSH 형식은 고정 데이터로 검증했으며 이번
  환경에는 Linux 실행 호스트가 없어 실기동을 주장하지 않습니다.
- 맥미니 P41의 API·웹·Host Agent를 0.5.0으로 업데이트했습니다. 기존 접속 키·호스트 설정·
  커넥터·기본 모델은 유지하고 브라우저 워커는 재시작하지 않았습니다. 관리자 권한 승격도
  하지 않았습니다. 현재 맥미니의 일반 사용자 Host Agent에는 전력 측정 불가 사유가 표시됩니다.
- 운영 Chromium에서 M4·16GiB·P41 볼륨, 실제 연속 표본과 그래프, 5/30분 전환, 수집 정지·
  재개, 새로고침 후 기록 유지, 화면에만 주입한 연결 오류의 이전 값 안내를 검증했습니다.
  다크/라이트 및 1440px/390px 화면을 검토했고 좁은 화면 카드 넘침을 수정했습니다.
  페이지 JavaScript 오류는 없었습니다. 사용자 대화나 실제 연결 설정을 시험용으로 바꾸지 않았습니다.
- 비공개 운영 증거: P41 `verification/host-dashboard-20261005`. 이번 검사는 로컬과 맥미니에서
  실행했으며 GitHub Actions의 원격 검사 성공을 주장하지 않습니다.

## OpenMuse 0.4.0 — 2026년 10월 5일

- Markdown·스킬 폴더·ZIP/.skill·TAR/TAR.GZ/TGZ 업로드와 `/스킬이름` 선택을 구현했습니다.
  소유자별 DB 목록과 버전별 파일 보관, 명시적인 교체, 활성화·삭제, 상대 경로 참고 자료 읽기를
  검사했습니다. 경로 이탈·링크·중복·크기 초과·잘못된 YAML은 등록 전에 거부합니다.
- 341개 검사 중 340개 통과, 실패 0개입니다. Windows에서 POSIX 가짜 Docker 실행 파일을
  사용하는 기존 검사 1개는 건너뛰었습니다. 마지막 런타임 변경 후 스킬·팀·Jev/Pi 검사 36개도
  모두 통과했습니다. 서버/모바일 타입 검사, lint(기존 경고 포함), 서버 빌드 및 웹·iOS·Android
  번들 생성이 성공했습니다. 모바일 기기에서 네이티브 파일 선택기 실기동은 검증하지 않았습니다.
- 맥미니 P41에 API·웹을 재빌드·배포했고 기존 환경·커넥터·기본 모델 `oc-gpt-6-luna`·
  Host Agent 0.3.0 설정과 배포 파일을 보존했습니다. API·웹·브라우저 워커·Host Agent의
  상태 응답이 모두 정상입니다.
- 운영 웹의 실제 Chromium 화면에서 단일 파일·폴더·ZIP 업로드, 비활성화 상태의 본문 보기,
  활성화, 삭제, 새로고침 후 목록 유지, 슬래시 자동완성·Tab 선택을 확인했습니다. 1440px 및
  390px 화면을 검토했고 좁은 화면의 페이지 가로 넘침과 JavaScript 오류가 없었습니다.
- 실제 내장 Pi/OpenCodex 대화가 `/qa-folder-040`으로 선택한 지침에 따라 `read_skill_file`을
  호출하고 업로드한 참고 파일의 검증 문장을 응답했습니다. 이어지는 일반 메시지도 성공했고,
  DB 대화에는 확장 지침 대신 원래 슬래시 요청이 보존됐습니다. 시험용 스킬과 대화는 삭제했습니다.
- 비공개 배포·화면·이벤트 증거: P41 `verification/skills-20261005`. 테스트와 빌드는 로컬 및
  맥미니에서 실행했습니다. GitHub Actions의 원격 검사 성공을 주장하지 않습니다.

## OpenMuse 0.3.1 — 2026년 10월 5일

- `repo_update`는 CLI와 같은 `visibility` 필드를 사용합니다. 기존 `private` 인수는 호환
  변환하며 상충하는 두 값은 전송 전에 거부합니다. 현재 visibility·포크·관리 권한을 조회하고
  확인되지 않은 포크·권한은 null로 구분합니다. 과거 422 오류로 현재 상태를 단정하지 않습니다.
- PC의 gh와 맥미니의 기존 GitHub 커넥터가 모두 AppleFE 계정에서 ARTEX를 private=true,
  fork=false로 조회했습니다. 이미 비공개인 상태에 기존 private=true 및 새로운 visibility=private
  요청을 적용해 둘 다 성공했고 현재 상태를 유지했습니다. 과거 실패의 원인이 요청 필드 차이였다고
  단정하지 않습니다. 삭제·포크 분리·공개 전환은 하지 않았습니다.
- 관련 회귀 검사 22개, 서버·모바일 타입 검사와 서버 빌드가 통과했습니다. 맥미니에서 API·웹을
  다시 빌드·배포하고 환경 설정·커넥터·기본 모델·기존 Host Agent 0.3.0을 보존했습니다.
- 실제 Pi 대화가 test_connector와 query_connector를 사용해 ARTEX의 최신 비공개·포크 아님·
  관리 권한을 확인하고 과거 오류를 현재 사실로 취급하지 않았습니다. 이미 비공개이므로 추가
  변경을 준비하지 않았습니다. 원본 이벤트와 화면을 별도로 보존했습니다.
- 모델/승인 버튼과 사용량/속도 텍스트를 한 줄에 정렬했습니다. 실제 웹의 1440px·390px 화면에서
  네 항목의 세로 중심이 각각 820px·679px로 일치하고 페이지 가로 넘침이 없었습니다.
  사용량은 배경·모서리 장식 없는 텍스트이며 상세 팝업도 확인했습니다. 페이지 오류는 없었습니다.
  좁은 화면에서는 도구 줄만 가로로 이동합니다.
- 비공개 운영 증거는 P41 `verification/github-toolbar-20261005`에 보존했습니다.
  시험용 대화는 검증 후 보관·완전 삭제했고 사용자 대화의 승인 설정은 변경하지 않았습니다.

## OpenMuse 0.3 — 2026년 10월 5일

- 대화별 review/bypass 설정을 인증된 API와 UI로 저장합니다. 원본 대화 ID는 서버가 태스크에
  연결하며 모델 인수로 설정할 수 없습니다. 자동 실행은 기존 작업 검증·DB의 원자적 실행
  선점·영수증을 사용합니다. 소유자/대화 경계, 철회 경합, 중복 요청, 보관된 대화, 취소된 태스크와
  응답 중 설정 변경 거부를 검사했습니다.
- GitHub 공개 포크의 비공개 전환 거부를 한국어로 안내하고 repo 조회에 fork/parent 정보를
  포함합니다. 기존에 저장된 영문 오류도 표시할 때 설명합니다. SSH 서버 지문 입력은 고급 설정에
  옮겼으며 서버 주소 변경 시 이전 지문을 새 서버에 재사용하지 않습니다.
- 화면 수집을 입력 대기열에서 분리하고 Chromium 최신 JPEG→RFB Tight 전송을 추가했습니다.
  최신 프레임만 보관하고 변경 없는 프레임은 ETag로 생략합니다. 대기 중 마우스 이동은 합치되
  클릭·드래그 전환·키·HTTP 입력 경계는 유지합니다. 구버전 Host Agent의 PNG 방식도 지원합니다.
- 전체 회귀 검사 333개 통과·실패 0개·기존 선택형 1개 제외, 서버/모바일/워커 타입 검사와 서버
  빌드가 통과했습니다. 실제 noVNC의 Raw/Tight JPEG 표시와 영문/한글 입력, 포인터 순서,
  동일 화면 재전송 방지, 실제 Chromium의 입력·JPEG 변경 검사가 통과했습니다.
- 개선 전 Windows Chromium→Tailscale 웹 프록시→맥미니 Chromium의 키 입력 화면 반응은
  6회 측정에서 중앙값 274ms, 최대 289ms였습니다. 논리적 프레임 크기는 4,096,016바이트였습니다.
  이 값은 특정 시험 조건의 결과이며 네트워크 환경별 성능 보장은 아닙니다.
- 동일 경로·페이지·6회 측정에서 개선 후 중앙값 39ms, 최대 104ms,
  논리적 프레임 평균 53,923바이트를 확인했습니다. 실제 Tailscale WebSocket 프록시와
  맥미니 Chromium을 사용했고 페이지 오류는 없었습니다.
- 맥미니의 서버·웹·브라우저 워커·Host Agent를 재빌드·재시작하고 기존 활성 브라우저 1개를
  복원했습니다. DB 오프라인 백업과 `.env`/Host Agent config/커넥터/기본 모델 보존을 확인했습니다.
- 실제 UI에서 별도 채팅의 bypass 선택→새로고침→설정 유지→Pi의 `prepare_connector_action`
  호출→GitHub의 기존 private=true를 그대로 적용한 성공 영수증(`approvalMethod=session-bypass`)
  을 확인했습니다. 검토 방식으로 되돌리기와 다른 채팅의 기본 review도 확인했습니다.
  시험은 AppleFE/openmuse만 사용하며 ARTEX를 삭제·분리·변경하지 않았습니다.
- Host Agent 0.3.0 묶음을 Windows에서 별도로 풀고 npm ci로 설치해 실제 인증, 한글 셸,
  PNG와 새 JPEG 화면, 입력 후 변경된 프레임을 확인했습니다. 묶음의 SHA-256은
  `fee5e6358ade86fefaea12ffdf73456f137e3a6109ddd790c02cf121d1e18689`입니다.
  실제 Chromium 복원 검사와 iOS/Android 번들 내보내기도 통과했습니다.
  비공개 증거는 P41 `verification/browser-latency-20261005`에 저장했습니다.

## OpenMuse 0.2 — 2026년 10월 5일

- 구현·실제 실행 검증 코드: `e4967ae7cdbb16dc99384456cb5aa261deca2d37`.
  noVNC 공유 브라우저, GitHub 쓰기, 보관함 완전 삭제, 관리자 Host Agent 자동 설치,
  SSH 키 업로드·비밀번호, 사용량·tok/s·메시지 시각, 시간대 기반 AI 예약 작업을 추가했습니다.
  사용법은 [OpenMuse 0.2](WORKSPACE-0.2.md), [원격 호스트](REMOTE-HOSTS.md),
  [GitHub 커넥터](CONNECTORS.md)를 참고하세요.
- 전체 회귀 검사 328개 통과·실패 0개·기존 선택형 1개 제외. 최종 영문/한글 입력 순서 수정 후
  브라우저 관련 검사 20개와 서버 타입 검사를 다시 통과했습니다. 서버·모바일·워커·Host Agent
  타입 검사, 서버/독립 Host Agent 빌드, 실제 Chromium 재시작·프로필 복원 검사와 macOS
  배포 검사 15개가 통과했습니다.
- 맥미니 P41에서 DB를 오프라인 백업하고 API·웹·브라우저 워커·Host Agent 네 서비스를
  다시 시작했습니다. 후속 입력 순서 수정은 API만 재빌드·재시작했습니다. `.env`, Host Agent
  config, 기존 커넥터 설정·인증 정보와 기본 모델 `oc-gpt-6-luna`를 유지했습니다.
- `http://100.80.94.16:8081`에서 실제 noVNC/RFB 스트림과 웹 WebSocket 프록시를 확인했습니다.
  맥미니 Chromium의 example.com 링크를 화면에서 직접 클릭해 IANA 페이지로 이동했고,
  영문·한글 입력과 Enter의 순서, 사용자 제어 가져오기·반환을 검증했습니다. Google 검색은
  입력된 검색어를 확인하는 데 사용했으며 Google의 자동화 제한 화면은 우회하지 않았습니다.
- 저장된 GitHub 토큰으로 네이티브 검토→실행을 거쳐 이미 비공개인 OpenMuse 저장소에
  비공개 설정을 그대로 적용하고 임시 브랜치 생성→파일 커밋·푸시→파일 읽기→브랜치 삭제를
  검증했습니다. ARTEX 등 다른 저장소의 공개 여부는 변경하지 않았습니다.
- 실제 채팅에서 `create_schedule`로 미래의 일회성 예약을 만들었습니다. 서버 스케줄러가
  한 번만 태스크를 만들고 Pi가 맥미니 `host_status`를 조회한 뒤 `finish_task`로 완료했습니다.
  결과는 macOS/arm64, `aeonge` 일반 사용자 권한으로 확인됐습니다. 사용량은 해당 채팅의
  2회 호출·11,621토큰, 예약/작업을 포함한 39,336토큰을 실제 제공자 응답에서 기록했습니다.
  새 메시지 시각과 해당 채팅/전체 채팅 사용량 UI도 확인했습니다.
- 검증용 채팅을 보관한 뒤 UI의 두 단계 완전 삭제를 실행하고 재조회 404를 확인했습니다.
  검증용 예약은 제거했고 브라우저 일괄 삭제로 대상 프로필도 제거했습니다. 사용자 기록은
  이 검증에서 별도로 삭제하지 않았습니다. 웹 앱 페이지 오류와 외부 앱 서비스 요청은 없었습니다.
- 자동 설치의 만료·일회용 등록·암호화 저장을 실제 Host Agent로 검사하고 macOS/Linux 셸과
  Windows PowerShell 스크립트의 구문을 검사했습니다. 새 설치는 root/SYSTEM 서비스를 등록합니다.
  Windows/Linux 장비의 실제 관리자 서비스 설치·재부팅은 이 환경에서 검증하지 않았습니다.
  기존 맥미니는 비밀번호 없는 sudo가 없어 일반 사용자 서비스로 유지하며 앱에 실제 권한을 표시합니다.
- 배포 묶음 `openmuse-host-agent-0.2.0.tar.gz`의 SHA-256은
  `a5f6ec551077803f280d5dba600d7728ddd0a49fb0f043a011f6258e3b7aba49`입니다.
  묶음에는 컴파일된 호스트/워커 코드, 잠금 파일과 설치기만 포함하며 DB·토큰·node_modules는 제외합니다.
  비공개 운영 증거는 P41의 `verification/workspace-expansion-20261005`에 보관했습니다.
- 이 묶음을 Windows x64의 별도 디렉터리에 풀고 `npm ci`로 설치해 401 인증 차단,
  실제 한글 PowerShell 명령과 종료 코드 0, example.com 본문·스크롤·PNG 화면을 확인했습니다.
  이 검사는 임시 일반 사용자 프로세스이며 SYSTEM 서비스 등록·재부팅 검증과 구분합니다.
- 0.2.1에서는 새 체크아웃의 테스트가 독립 Host Agent 묶음을 먼저 준비하도록 하고,
  noVNC 통합 검사용 Playwright를 루트 의존성에 명시해 CI에서 Chromium을 설치합니다.
  최종 전체 검사 328개 통과·실패 0개·선택형 1개 제외, 서버/모바일/워커 타입 검사와
  전체 Biome 검사 오류 0개를 확인했습니다. 기존 비차단 lint 경고는 남아 있습니다.

## 원격 호스트 커넥터 — 2026년 10월 5일

- `remote_host`에 SSH와 독립 Host Agent 방식을 추가했습니다. Linux·Windows·macOS 설정,
  실제 OS 조회, 비동기 셸 작업·출력·입력·중지, SSH 호스트 키 고정과 PTY, 연결별 Pi 명령
  권한, 기존 네이티브 작업 검토, 공유 Chromium 세션과 사용자 제어권을 지원합니다.
- Windows에서 전체 테스트 318개 중 317개가 통과하고 POSIX 전용 1개를 건너뛰었습니다.
  최종 변경 후 호스트·권한·브라우저 회귀 28/28, macOS 런처 4/4가 통과했습니다.
  Windows PowerShell의 한글 명령과 표준 입력, 실제 SSH 서버 픽스처의 호스트 지문·PTY,
  재시작 시 명령 재실행 방지, 중복 요청·연결 변경·소유자 경계·사용자 제어를 검사했습니다.
- 서버·모바일·브라우저 워커 타입 검사, 서버 빌드와 독립 Host Agent 빌드가 통과했습니다.
  설치 방법과 권한·프로토콜은 [원격 호스트 문서](REMOTE-HOSTS.md)에 기록했습니다.
- 경계: Host Agent 셸은 파이프 입출력이며 PTY는 SSH 방식에서 제공합니다. 브라우저는
  기존 공개 HTTP(S) 페이지 제한을 유지합니다. 전체 데스크톱 제어·기존 사용자의 Chrome
  창 공유는 구현하지 않았습니다. Linux 실제 호스트 설치는 이 Windows 검증에 포함되지 않습니다.
- P41의 서버·기존 브라우저 워커·Host Agent는 소스 `4d5a3cd508664bba960d55e0729cdda9b6db4d8a`로
  빌드·재시작했습니다. Pi 응답 봉투를 처리하는 최종 웹 빌드는
  `621a500c2a7dc35a84f3daa17571f129ebb53a8b`입니다. 뒤따르는 문서 커밋은 앱 코드를 바꾸지 않습니다.
  새 `맥미니` 연결은 macOS/darwin·arm64·`/bin/sh`와 실제 셸·브라우저 지원을 반환합니다.
  기존 `.env`·커넥터 설정·자격 증명 존재 여부와 기본 모델 `oc-gpt-6-luna`를 보존했습니다.
- 실제 맥미니 명령에서 한글 출력·P41 작업 경로·Darwin·arm64·종료 코드 0과 같은 요청의
  중복 실행 방지를 확인했습니다. 사용자 화면에서 example.com의 링크를 클릭해 IANA로
  이동하고 제어권을 반환했습니다. 실서비스 OpenCodex 모델과 내장 Pi의 대화
  `2389bb0b-ae24-4e69-9ad8-338874572a4b`가 `run_host_command`, `host_job` 조회,
  `open_host_browser`, `read_browser`를 호출했습니다. 작업
  `c311c3f7-af16-4e51-9edd-f8046a0b20ce`의 출력은 `PI-HOST-391`, P41 경로,
  Darwin, arm64이며 종료 코드는 0입니다.
- 저장된 Pi 대화의 브라우저 카드·실제 미리 보기·오른쪽 패널·패널 옆 초안 입력을
  검증했습니다. 사용자 제어권은 웹 새로고침 후에도 유지됐고 반환 버튼으로 해제했습니다.
  390×844 웹 화면도 캡처했으며 페이지 오류와 앱의 외부 호스트 요청은 없었습니다.
  마지막 결과 해석 수정의 모바일 타입 검사와 관련 3/3 테스트도 통과했습니다.
- 독립 배포 압축을 Windows x64에서 풀고 `npm ci`로 설치해 실제 Host Agent 인증,
  한글 셸 명령·종료 코드 0, Chromium 본문·요소 조회·스크롤·PNG를 확인했습니다.
  실제 Chromium의 실패 프로필 정리·재시작 후 상태 복원 테스트도 1/1 통과했습니다.
  [Host Agent 0.1.0](https://github.com/AppleFE/openmuse/releases/tag/host-agent-v0.1.0)를
  비공개 저장소에 게시했으며, 릴리스에서 다시 내려받은 파일의 SHA256은
  `06b3dd5ce72c3eec42af82b06ea787ac5d2e6e31a164f475fd818296e5cf6237`로 로컬 패키지와 같습니다.
  증빙은 P41의 `verification/remote-host-20261005`에 보관합니다.

September 16, 2026 · Capybara and distinct mobile/web demos, following the agent browser release · local fictional workspace. This records exercised behavior and its limits; it does not establish that every planned capability is complete.

## Integration review — September 29, 2026

Independent review of the model catalog, agent teams, infrastructure connectors, embedded pi runtime, Jev policy layer, and theme work on the final integrated HEAD.

- **Root suite passes with no failures: 261 tests + 1 POSIX-only platform skip (of 262)**, run by the runtime owner on the final core after all worker commits landed. Coverage exercises per-request model resolution, cleared-selection snapshots, OpenCodex routing, team validation/ordering/failure propagation, sequential and parallel role DAGs, restart recovery that retries only interrupted roles, and role-labelled thread messages.
- **Focused Jev/pi and real pi-protocol tests pass: 17/17**, using the real `@typesafe-ai/sdk` and `@earendil-works/pi-coding-agent` SDK contracts — actual `createAgentSession` task/chat protocol, Jev `choice` decisions, host-tool exclusion, durable session/checkpoint behavior, cancellation, and `closed`/`local-budget` fail modes.
- **Connector suite: 21 tests pass** covering provider contracts with mocked responses (auth headers, response mapping, malformed payloads, timeouts, secret redaction), owner isolation, AES-256-GCM encrypted storage verified at rest, Headscale modern/legacy fallback, WireGuard fixed argv with no shell and no key output, multiple independent Proxmox identities, rejection of credential-bearing URLs with legacy-view sanitization, health checks fenced to the credential set that produced them, and caller cancellation aborting provider I/O.
- **Auth and secrets re-audited**: session tokens remain hashed and timing-safe, owner scoping applies to model settings, teams, connectors, and runtime settings, and no connector view, tool response, or error path returns credentials. Jev API keys are encrypted with the same vault and never echoed.
- **Dynamic model behavior verified**: `forwardedProps.modelId` is resolved through the server catalog per request; the owner's saved selection is snapshotted immutably per run, including inside pi sessions.
- **Pi runtime is genuinely invoked**: configured coding-capable profiles route team `coder` roles, delegated agent/plan tasks, and conversational tool work through the embedded pi SDK with `noTools: "builtin"` (no host shell/filesystem tools), OpenMuse-only tools, bounded iteration and per-tool budgets, durable JSONL sessions and SQL checkpoints, and combined caller/runtime cancellation. Jev is optional and off by default; pi is on by default for coding profiles and owner-disableable.
- **Light/dark web UI verified**: system/light/dark preference persists in localStorage and applies `colorScheme`/canvas styles to the document; native persistence uses a document file. Web and native settings exports include the Jev/pi runtime settings screen with write-only credential entry.
- **Browser worker lifecycle test re-verified on real Chromium** (1 test): failed-profile cleanup, saved-UUID reopen, 100KB read truncation, and localStorage persistence across restart. The fixture was updated because example.com's body copy changed upstream.
- **Builds**: server build and web export pass on the final HEAD; browser-worker typecheck passes. Root typecheck passes. Biome lint passes on all changed files; committed tree is LF-clean (local Windows checkout shows CRLF diffs only).
- **Boundaries**: all connector provider coverage is mocked — no live GitHub/Tailscale/Headscale/WireGuard/Proxmox credentials were supplied, and no live TypeSafe.ai, model-provider, or Docker credential was exercised by repository tests. Live provider acceptance remains open on the roadmap. Docker-based computer checks and the browser-container acceptance were not run on this Windows host (no Docker daemon); their prior Linux evidence stands.

## Self-hosted Mac deployment — September 30, 2026

The P41 application runtime was built and activated from independently reviewed source candidate `5ad66e1fe6ad8c426515a135660452c70c81cde4` at `/Volumes/p41-1tb/openmuse/repo`. This is the tested application SHA; a later docs-only commit advances repository refs without changing or rebuilding application code. The P41 source tree was clean at candidate deployment. The deployment uses Ollama `0.34.4` on loopback and `AGENT_BACKEND=model`; no CopilotKit project key, cloud-model API key, sample credential, license, or dummy value is needed. The canonical `.env` is mode `600`; its pre-change mode-600 backup is `/Volumes/p41-1tb/openmuse/backups/env.pre-fe4d91c0.20260930T070412Z`. The backup is outside source control.

- **Candidate checks**: independent review accepted exact candidate `5ad66e1fe6ad8c426515a135660452c70c81cde4`; its final same-batch parallel-completion regression passed 1/1, and root typecheck, server build, and Biome passed on that exact SHA. Focused runtime/computer checks passed 35/35 on its parent with the same runtime code. The author-run 253-test suite plus one POSIX-only skip was on earlier ancestor `532f4824a08d024f34a2ac6ce04955ab2879465d`; those results are not being attributed to the final candidate.

- **Local model catalog**: `local-coder` maps to `ollama/qwen3:4b`; `local-coder-8b` maps to `ollama/qwen3:8b` and remains selected for new owner work. `MODEL=ollama/qwen3:4b` is the fallback. After the accepted candidate was deployed, authenticated model settings reported both profiles available and preserved the 8B selection. The Ollama 8B digest is `500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41`; the existing 4B model remains installed.
- **Real local inference**: the final browser/API capture exercised real Qwen3:8B chat through the API stream and same-origin web proxy and displayed the completed plan and successful result. The model also returned `start_computer`, `run_computer_command`, and `computer_status` tool calls from the production-sized 25-tool payload at 8,192 context / 1,024 output tokens with thinking disabled. The final API-backed Pi acceptance task `4a3231f4-9276-492c-887f-8892704a5fe0` succeeded on exact candidate `5ad66e1fe6ad8c426515a135660452c70c81cde4`; its task-scoped command receipt `32e108b4c58f50f1a162ca12a5d9587b60bc9d04193bdf7463fb2db475d14c8f` exited 0 with exact trimmed output `391`. An authenticated pre-cleanup file read returned exactly `391`; finish event `294b6551-7f51-4d73-b694-5b45bd9a5ab6` persisted `PI-TOOL-391 / 391` and report artifact `d432b7b3b16bc712986f6d8ae8ca15e7fe9ae33b6189cdfd388535d761392f8b`. Cleanup receipt `f4446ab2-5fc3-4b86-8e50-ba683a3d9f3c` succeeded and removed the disposable fixture. The independent restart-mode manifest check at 10:19:02 UTC on API PID 76048 confirmed that the Pi task and its accepted result remained persisted; no inference or mutation occurred during that check. Independent QA exercised sequential and parallel teams and confirmed three distinct role/model messages persisted. It also inspected the shared context and native Pi JSONL inputs: sequential Coder received Planner output; sequential Reviewer received Planner and Coder output; parallel Reviewer received both outputs; independent parallel roles had no dependency. Role cards showed the expected roles. Both successful teams and role speaker/model metadata also survived API restart. The model still missed exact marker/citation output instructions in team runs, so delivery of role prompts and dependency inputs is verified while exact instruction compliance is not.
- **Earlier failure that motivated the accepted fix**: a prior 8B task was persisted as succeeded even though its only command receipt failed and the requested file was absent. Review also found a pending-scope-link race and a same-message `finish_task`/computer-command race because Pi can execute tools in parallel. The accepted source adds receipt-gated completion and a shared queue for computer operations and task completion. The earlier 4B five-tool probe made no tool calls in three bounded 1,024-token attempts; prompt sizes were 1,087, 2,175, and 3,263 tokens, all below 8K context.
- **Memory fit**: Qwen3:8B is a 5.2 GB Q4_K_M artifact. During the 8K single-request probe, `ollama ps` reported 6.2 GB loaded on GPU and the runner reached 6,080,400 KB RSS. On the 16 GiB host, available memory fell to 19–21%, then recovered to 23%; swapout count did not change over the measured post-request minute. Keep inference serialized and check host memory when other workloads are active. See the [Ollama Qwen3 model page](https://ollama.com/library/qwen3), [tool-calling support](https://ollama.com/blog/streaming-tool), [context memory notes](https://github.com/ollama/ollama/blob/main/docs/context-length.mdx), and [official Qwen3-8B card](https://huggingface.co/Qwen/Qwen3-8B), which lists tool calling and Apache-2.0.
- **Build, activation, and services**: the server build passed on P41 after bundle fast-forward to the candidate. Two serialized `infra/macos/install-launch-agents.sh` cycles had already verified the valid owner configuration; after candidate deployment, only `com.openmuse.server` was stopped and reloaded through the existing restricted localhost SSH command. API `8787`, same-origin web proxy `/api/health` on `8081`, web `/healthz` on `8081`, browser worker `/health` on `8790`, and Ollama `/api/tags` on `11434` returned HTTP 200. The first candidate API listener was PID 74829; after the authorized persistence-check restart it was PID 76048, the sole loopback API listener. `server.err.log` remained empty. Invalid owner key returned 401, owner sign-in returned 200, both Ollama profiles reported available, `local-coder-8b` remained selected, and the computer service reported `running` with network `disabled`.
- **Login boundary**: the per-user LaunchAgents start after `aeonge` logs in. A full host-reboot test was not authorized or performed. The deployment uses sample workspace data because no live Google credentials were supplied. The separate P41 operator guide records owner login and service checks without storing or printing secrets.

## OpenCodex 모델 전환 — 2026년 9월 30일

- 사용자 요청으로 P41에 설치했던 `qwen3:4b`, `qwen3:8b`를 Ollama 삭제 API로 제거했습니다.
  설치 모델 목록이 비었고 모델 저장 디렉터리의 파일 크기 합계가 0바이트임을 확인했습니다.
  전용 `com.openmuse.ollama` 프로세스를 중지하고 자동 시작을 해제했습니다.
- 제공된 LAN·Tailscale OpenCodex `/v1/models` 주소가 모두 인증 후 HTTP 200을 반환했습니다.
  사용 가능한 모델 ID 80개를 서버 카탈로그에 등록하고 기본 모델을 `gpt-6-sol`로 선택했습니다.
  기존 팀 4개의 로컬 모델 연결도 OpenCodex 모델로 전환했습니다. 이 확인은 모델 목록·설정
  검증이며 모든 모델 80개의 실제 추론을 실행했다는 의미는 아닙니다.
- 인증 키는 맥미니의 기존 `service-api-token`에서 서버 `.env`로만 복사했습니다. `.env`는
  mode 600으로 유지하며 변경 전 설정은 P41의 `private-backups/pre-opencodex-*`에 보관합니다.
  서버 설정 검증과 재시작 후 `/api/health`가 정상 응답했고, 소유자 API에서 등록된 모델 80개가
  모두 OpenCodex이며 기본 선택이 `oc-gpt-6-sol`임을 확인했습니다. 과거 대화·작업은 유지합니다.

## 한국어 UI와 OpenCodex 실사용 확인 — 2026년 9월 30일

- 로그인, 대화, 활동, 아이디어, 목표, 앱, 모델·팀·런타임 설정, 커넥터, 컴퓨터,
  메일·일정·문서 화면의 안내·버튼·오류와 접근성 라벨을 한국어로 전환했습니다.
  화면의 상태·기본 역할·작업 단계·타임라인 문구와 날짜·시간 표시는 `ko-KR`을 사용합니다.
  모델 ID, 프로토콜 값과 기존 사용자 작성 내용은 보존합니다. Enter 전송과 PDF 체크박스의
  내부 값은 번역 대상에서 제외했습니다.
- 로컬 타입 검사·변경 파일 Biome 검사·웹 빌드가 통과했습니다. 모바일와 OpenCodex 라우팅
  관련 테스트 28/28, macOS 배포 테스트 14/14가 통과했습니다. P41에서도 새 웹 빌드를
  생성했습니다. 백엔드 구현은 기존 승인 소스 그대로이며 서버의 모델 설정만 변경했습니다.
- 실제 P41 브라우저에서 한국어 로그인·잘못된 접속 키 안내, 5개 탭, 팀 편집 화면,
  기본 모델 변경의 HTTP 200과 저장된 선택값을 확인했습니다. `oc-gpt-6-luna`로
  “17 곱하기 23을 계산하고 결과 숫자만 답해 주세요.”를 Enter로 전송해 `391` 응답을
  받았습니다. 대화 `fab2046b-4c2f-4846-9ec5-6fee6b67a5bb`는 새로고침 후에도 복원됐습니다.
  이 브라우저 확인에서 페이지 오류와 외부 브라우저 요청은 없었습니다. 확인 후 기본 선택을
  `oc-gpt-6-sol`로 복원했습니다.
- `oc-gpt-6-sol`의 실제 Pi 작업 `af0bead9-27c3-45a5-aac5-c34b2c9d4566`이 성공했습니다.
  컴퓨터 도구를 통해 테스트 파일을 작성하고 읽었으며 실행 기록
  `865c7146526d9b19ca4140cd93b88ce5443146192c38cbc76e0a96f88c3cb437`의 종료 코드 0,
  stdout `391`, 별도 파일 읽기의 `391`, 저장된 완료 이벤트와 보고서를 확인했습니다.
  정리 실행 `c3e47516-b611-440c-aa97-3ba40a2f7a2e`로 해당 테스트 파일·디렉터리를 제거했습니다.
- 서버 인증 키와 소유자 접속 키는 맥미니 내부에서만 읽었습니다. 브라우저에는 모델 서비스의
  API 키를 전달하지 않습니다. 증빙과 스크린샷은 P41의
  `verification/opencodex-ko-20260930`에 보관합니다. OpenMuse·DB·브라우저·Pi는 자체 호스팅이며,
  모델 추론은 사용자가 지정한 OpenCodex 게이트웨이 및 그 게이트웨이의 제공자를 사용합니다.
  CopilotKit 프로젝트 키는 필요하지 않습니다. 모델 80개 전체의 추론을 검증한 것은 아닙니다.

## GitHub 저장·모델 선택·Pi 환경 안내 수정 — 2026년 9월 30일

- P41 서버의 `TOKEN_ENCRYPTION_KEY`가 32바이트를 표현하는 정규 Base64 형식이 아니어서
  GitHub PAT 저장이 제공자 요청 전에 실패했습니다. 당시 연결 레코드는 없었고 Jev 인증 정보도
  설정되지 않았음을 확인한 뒤, 맥미니 내부에서 새 키를 생성하고 `.env` 권한 600을 유지했습니다.
  이전 설정은 `private-backups/pre-vault-fix-20260930T124716Z/.env`에 권한 600으로 보관합니다.
  설정 로더와 macOS 배포 검사는 sample 모드에서도 지정된 암호화 키를 검증하며,
  연결 저장의 설정 오류와 일반 요청 오류는 한국어로 안내합니다. 이전 실패에서는 PAT가
  저장되지 않았으므로 사용자가 다시 입력해야 합니다.
- 상시 모델 목록을 검색 가능한 팝업으로 바꿨습니다. 대화의 모델 버튼은 해당 대화만 변경하고,
  앱 설정의 기본 모델 버튼은 새 대화와 작업의 기본값을 저장합니다. 역할별 모델도 팝업에서
  선택합니다. 웹 입력창은 브라우저의 자동 outline 스타일을 명시적으로 덮어써 안쪽 사각
  테두리를 제거하며, 바깥의 둥근 포커스 표시는 유지합니다.
- 대화에 `runtime_status` 서버 도구를 추가했습니다. 실제 서버 플랫폼과 내장 Pi의 활성 상태,
  선택된 모델, 격리 컴퓨터 상태만 반환하며 인증 정보와 호스트 경로는 반환하지 않습니다.
  대화·위임 작업·팀 Pi 프롬프트는 macOS 애플리케이션 서버와 Docker Linux 컴퓨터를 구분합니다.
  컨테이너에서 `pi` 실행 파일을 찾지 못해도 서버의 내장 SDK가 없다고 답하지 않도록 했습니다.
- 설정·커넥터 회귀 테스트 15/15, macOS 배포 검사 15/15, 모델·팀 테스트 7/7,
  실제 내장 SDK의 Pi 프로토콜 테스트 3/3이 통과했습니다. 타입 검사, 변경 파일 Biome 검사와
  서버 빌드가 통과했습니다. 맥미니에서 서버·웹을 빌드했고, 활성 작업과 대화가 없는 상태에서
  API만 재시작했습니다. 최종 UI 소스는 `c4a8392badc54a082f0505f096f09b962d80cd2c`이며,
  그 뒤 문서만 변경합니다. API·웹·브라우저의 네 가지 상태 확인은 HTTP 200입니다.
- 배포된 실제 브라우저에서 팝업 검색·대화 모델 변경·기본 모델 저장을 확인했습니다.
  대화 변경은 서버 기본값에 영향을 주지 않았고, 임시로 변경한 기본값은 기존
  `oc-gpt-6-sol`로 복원했습니다. 포커스된 입력창의 outline/border 폭은 0px이고 자동 outline이
  없음을 스크린샷으로 확인했습니다. 임시 루프백 GitHub 호환 서버를 통해 UI 연결 생성 201,
  인증 정보 복호화, 연결 검사 성공과 토큰 미반환을 확인했고 테스트 연결은 삭제했습니다.
  실제 사용자 GitHub PAT로 계정·저장소 접근을 검증한 것은 아닙니다.
- 실제 OpenCodex `oc-gpt-6-luna` 대화가 `runtime_status`를 호출했습니다. 서버는
  `darwin`/`arm64`, Pi는 내장·활성·현재 실행에서 사용 중, 컴퓨터는 네트워크가 비활성화된
  실행 중 Docker Linux 컨테이너로 확인됐습니다. 한국어 답변도 이 구분과 별도 Pi CLI 설치나
  활성화 문구가 필요 없음을 설명했습니다. 브라우저 페이지 오류와 외부 브라우저 요청은 없었습니다.
  JSON 증빙과 스크린샷은 P41의 `verification/followup-20260930`에 보관합니다.

## Pi 후속 대화 기록 오류 복구 — 2026년 9월 30일

- 실제 P41 브라우저에서 `runtime_status`를 사용한 첫 답변 뒤 후속 질문을 보내면
  `Stored conversation history cannot be modified by the client`가 발생함을 재현했습니다.
  서버의 이벤트 압축은 완료된 도구 호출을 부모 텍스트 시작보다 앞에 배치할 수 있는데,
  메시지 저장 처리가 그 텍스트 시작에서 도구 호출 정보를 지우고 있었습니다.
  서버가 저장한 답변의 `toolCalls`가 없어 실제 CopilotKit 클라이언트의 기록과 달랐습니다.
- 텍스트를 재구성할 때 기존 도구 호출을 보존하고, 완료된 SDK 메시지의 인수에 이벤트 인수를
  중복해서 덧붙이지 않도록 수정했습니다. 도구만 먼저 발언하는 경우에도 부모 메시지를
  생성합니다. 서버 시작 시 원본 이벤트로 기존 저장 기록을 복구하며, 보관된 대화의 ID·순서와
  메타데이터를 유지합니다. 중단된 실행도 체크포인트의 사용자 메시지·부분 답변·도구 호출을
  복구합니다. 클라이언트의 기록 변조 차단은 유지하며 해당 오류의 UI 표시는 한국어입니다.
- 실제 Pi SDK와 CopilotKit Core/HttpAgent를 함께 사용하는 세 번의 연속 대화 회귀 테스트는
  수정 전 실패하고 수정 후 통과했습니다. 기존 기록·중단 복구, 원본 이벤트 보존, 반복 복구의
  동일 결과, 다른 소유자 격리와 위조 차단을 포함한 관련 테스트 28/28이 통과했습니다.
  타입 검사, 변경 파일 Biome 검사, 서버 빌드가 통과했습니다.
- 애플리케이션 소스 `6886c9c521c2d42f699c6f4a60861206541f4a53`를 P41에서 서버·웹 빌드 후
  활성 작업·대화가 없는 상태에서 API만 재시작했습니다. 대화 28개/메시지 60개를 먼저
  `private-backups/history-repair-20260930T145014549Z/threads.json`에 권한 600으로 백업했습니다.
  재시작 뒤 대화 5개에서 누락된 도구 호출 6건을 복구했고, 전체 메시지의 ID·순서·본문과
  원본 이벤트가 변경되지 않았음을 인증된 API로 비교했습니다. 기본 모델은 그대로 유지했습니다.
- 오류를 재현했던 기존 대화 `28dab016-171b-408a-97a9-722b79b5e03f`를 실제 화면에서 다시 열어
  OpenCodex `oc-gpt-6-luna`로 도구 사용 후 연속 질문과 새로고침 후 질문이 성공함을 확인했습니다.
  브라우저에서 일시적 연결 오류를 한 번만 주입한 뒤 **답변 다시 시도**도 성공했으며,
  동일 사용자 메시지가 정확히 한 번 저장됐습니다. 기존 메시지는 그대로 유지됐고 Pi는
  macOS 서버에서 활성 상태였습니다. 대화 기록 불일치·페이지 오류·외부 브라우저 요청은 0건,
  API·웹·브라우저 상태 확인 네 가지는 HTTP 200입니다. 증빙은
  `verification/history-20260930`에 보관합니다. 추가 재연결 개선은 아래에 기록합니다.

## 대화 새로고침 복원 보완 — 2026년 10월 1일

- 실제 화면을 확인하면서 새로고침 때 사용자 질문이 빠지는 별도 문제를 발견했습니다.
  질문은 DB에 저장되어 있었지만 재연결이 모델의 출력 이벤트만 재생하고 있었습니다.
  재연결은 서버의 전체 메시지·상태를 유효한 AG-UI 시작/스냅샷/완료 순서로 복원하도록
  수정했습니다. 실행 중인 대화는 검증된 입력 메시지를 먼저 복원하고 현재 실행의 이벤트만
  이어 받아, 새로운 사용자 질문이 보이고 부분 답변이 중복되지 않도록 합니다.
  이 복원은 모델 추론이나 과거 도구 실행을 다시 수행하지 않습니다.
- SDK를 통한 완료된 대화·실행 중인 대화 재연결 회귀 테스트가 통과했습니다.
  최종 관련 대화 테스트 13/13, 실제 Pi 프로토콜·CopilotKit 오류 처리 테스트 5/5가 통과했고,
  타입 검사·Biome·서버 빌드도 통과했습니다. 소스
  `941f6bd2d94677bff1cb9aecc5ca3057d83f7403`를 맥미니에서 서버 빌드 후 API에 적용했습니다.
  웹 소스는 변경하지 않아 이전 웹 빌드를 유지했습니다.
- 두 번째 적용 전에 대화 28개/메시지 69개를
  `private-backups/history-repair-20260930T150816354Z/threads.json`에 권한 600으로 백업했습니다.
  활성 작업과 대화가 없는 상태에서 API만 재시작했고, 기존 본문·ID·순서·원본 이벤트가
  그대로 유지됐습니다. 반복 복구에서 추가로 바뀐 대화는 0개였습니다.
- 같은 실제 OpenCodex/Pi 테스트 대화에서 이전 사용자 질문 5개가 모두 화면에 보였고,
  추가 답변 뒤 새로고침했을 때 질문 6개가 모두 복원됐습니다. 이후 Pi 상태 도구 호출과
  후속 질문도 성공했고 새 확인에서 페이지 오류와 외부 브라우저 요청은 없었습니다.
  기본 모델은 `oc-gpt-6-sol`로 유지됐습니다. 서버·웹·브라우저 상태 확인 네 가지는 HTTP 200이며,
  최종 API PID는 83767입니다. 추가 JSON·스크린샷은 같은 증빙 디렉터리의
  `reconnect-ui-report.json`, `reconnect-deployment.json`, `04-*`, `05-*`에 보관합니다.
  이후 문서만 반영하며 앱을 다시 재시작하지 않습니다.

## Proxmox 인증서 연결 진단 — 2026년 10월 1일

- 실제 연결 `https://10.0.0.2:8006/`은 TLS 검증이 켜져 있지만 CA가 비어 있었습니다.
  맥미니에서 공개 인증서만 확인한 결과 Proxmox 클러스터 CA가 서명한 인증서를 사용하며,
  해당 IP는 인증서의 SAN에 포함되고 유효 기간 안에 있었습니다. 실패 원인은
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`로, HTTP 토큰 인증에 도달하기 전의 신뢰 체인 오류입니다.
  기존 SSH 키로 Proxmox에 로그인되지 않아 CA를 직접 읽지 못했습니다. 사용자에게 서버
  콘솔의 `cat /etc/pve/pve-root-ca.pem` 결과를 요청했으며, 실제 연결은 CA 등록 대기 상태입니다.
  실제 토큰의 유효성이나 접근 권한은 아직 검증되지 않았습니다. TLS 검증을 임의로 끄지 않았습니다.
- 인증서 신뢰·호스트 불일치·만료 오류를 구분하고, 기존에 저장된 영문 오류도 UI에서 한국어로
  표시하도록 수정했습니다. CA 입력 안내에 공개 CA를 얻는 명령과 PEM 형식을 설명했고,
  TLS 스위치의 웹 접근성 상태와 입력 예시를 보완했습니다. 연결 테스트는 공개될 수 있는
  `/version` 외에 인증이 필요한 `/nodes`도 확인하므로 토큰 거부를 성공으로 표시하지 않습니다.
- 실제 HTTPS 테스트 서버로 CA 누락 시 인증 정보를 보내지 않고 실패하는지, 연결별 CA를
  등록하면 TLS 검증을 유지한 채 성공하는지, 신뢰 설정이 다른 연결로 번지지 않는지,
  사용자 지정 CA로도 호스트 검증을 하는지, 공개 버전 API 뒤의 토큰 거부를 탐지하는지
  검증했습니다. 관련 커넥터 테스트 25/25, 서버·모바일 타입 검사, Biome, 서버 빌드가 통과했습니다.
- 서버 소스 `25d533cbabadd508f0db09aab0f6d0be0879120c`와 웹 소스
  `cffde2c82348fbcd42818eb544be6057e0b5b0a9`를 P41에서 빌드·적용했습니다. 활성 작업과
  대화가 없는 상태에서 API만 한 번 재시작했고, 기존 연결 설정·인증 정보 존재 여부·환경 파일과
  사용자가 지정한 기본 모델 `oc-gpt-6-luna`를 유지했습니다. API PID는 96361이며,
  서버·웹·브라우저 상태 확인 네 가지가 HTTP 200입니다.
- 실제 웹 화면의 임시 HTTPS 커넥터로 CA를 입력·저장하고 기존 토큰을 비워 유지한 뒤,
  인증된 연결 테스트와 노드 조회가 성공함을 확인했습니다. 자격 증명은 응답에 포함되지 않고
  페이지 오류와 외부 브라우저 요청은 0건입니다. 임시 커넥터는 삭제했습니다. 실제 Proxmox
  카드에는 CA 등록 필요가 한국어로 표시됩니다. JSON·스크린샷 증빙은 P41의
  `verification/proxmox-20261001`에 보관합니다. 이후 문서 반영은 앱을 재시작하지 않습니다.

## Proxmox 관리 기능 확장 — 2026년 10월 1일

- 노드별 스토리지 용량·상태·내용물과 설정, VM/LXC 상태·설정·스냅샷,
  노드 네트워크·디스크, 작업 상태·로그와 토큰의 실제 접근 권한을 조회합니다.
  조회 19종과 변경 16종의 메타데이터·매개변수 스키마를 제공합니다. 전원 제어,
  설정 변경, 생성·복제·이전·삭제, 스냅샷, 백업·복원, 스토리지 등록·설정·삭제와
  ISO/템플릿 다운로드는 기존 네이티브 검토 절차로 실행합니다. 조회 API로는 실행할 수 없습니다.
- 작업 검토는 연결·TLS 설정·인증 정보와 기존 대상의 설정 버전에 묶입니다.
  승인 전 변경되면 실행하지 않으며 같은 승인은 한 번만 전송됩니다. 전송 후 연결이
  끊기면 결과 불명으로 기록하고 자동 재실행하지 않습니다. UPID는 작업 접수이며,
  종료 상태 `stopped`와 `exitstatus: OK`로 비동기 완료를 확인합니다.
  Proxmox 9.2의 스토리지 등록·설정 변경은 객체 형태의 동기 완료 응답도 처리하며,
  생성된 설정의 비밀값은 반환하지 않습니다. 이 계약은 실제 서버의 API 명세와
  [공식 스토리지 API 소스](https://raw.githubusercontent.com/proxmox/pve-storage/master/src/PVE/API2/Storage/Config.pm)를 확인했습니다.
- 대화와 위임 작업의 Pi가 변경 작업을 준비할 수 있지만 모델이 승인할 수는 없습니다.
  위임 작업은 승인을 기다린 뒤 승인된 결과를 입력 상태로 받으며 작업 상태를 확인합니다.
  실제 Pi 결과 봉투를 대화의 검토 카드가 읽도록 보완했습니다. 팀 Pi는 현재 조회만 제공합니다.
- 기능 소스 `8fdf6d7beea3f6a77af9ff1868d0906fb888ffc2`의 전체 검사 301개 중
  300개가 통과했고 POSIX CLI 테스트 1개는 Windows에서 제외됐습니다. 후속 권한 조회 수정은
  커넥터 테스트 30/30과 서버·모바일 타입 검사로, Pi 검토 카드 보완은 회귀 테스트 2/2와
  모바일 타입 검사로 확인했습니다. 최종 스토리지 완료 응답 수정에서도 Proxmox/Pi/모바일
  검사 7/7과 서버·모바일 타입 검사가 통과했습니다. 변경 파일 Biome 검사는 통과합니다.
  Windows 전체 Biome 검사는 변경 밖의 기존 CRLF 형식 차이로 실패하므로 전체 lint 통과로 기록하지 않습니다.
- 최종 앱 소스 `cc0ea0d11333cc6e27e4026bf329e9877087047d`를 P41에서 서버·웹으로
  빌드했습니다. 활성 작업·대화가 없을 때 API만 재시작했고, 기존 연결·인증 정보 존재 여부,
  환경 파일과 기본 모델 `oc-gpt-6-luna`를 보존했습니다. API·웹·브라우저 상태 확인 네 가지는
  HTTP 200입니다. GitHub 저장소는 private이며 소스 변경은 main에 커밋·푸시했습니다.
- 실제 `10.0.0.2:8006`, `10.0.0.3:8006`은 이제 각 CA가 등록돼 TLS 검증을 켠 상태로
  Proxmox 9.2.2 연결 검사와 노드 조회가 성공합니다. 두 연결의 노드 이름은 모두 `reforged`지만
  서로 다른 연결 ID로 조회합니다. 현재 두 토큰의 `/access/permissions`는 빈 맵이며,
  스토리지·VM 목록은 권한 필터 때문에 비어 있고 노드 상세는 403입니다. 실제 스토리지가
  없다는 뜻은 아닙니다. Proxmox에서 토큰 ACL을 부여해야 실제 조회·변경을 사용할 수 있습니다.
  앱 관리 화면은 이 원인과 PVEAuditor/PVEAdmin 설정 경로를 안내합니다.
- 배포된 데스크톱·휴대폰 웹에서 실제 두 연결의 권한 안내를 확인했습니다. 임시 루프백
  Proxmox 호환 제공자로 스토리지 용량·ISO 내용물, VM 설정, 승인 전 미실행, 승인 후 한 번
  전송, 중복 승인 미실행과 UPID 상태·로그의 완료 결과를 확인했습니다. 페이지 오류와 외부
  브라우저 요청은 없었고 테스트 커넥터는 삭제했습니다. 실제 운영 VM은 변경하지 않았습니다.
  증빙은 P41의 `verification/proxmox-management-20261001`에 보관합니다.
- 실제 OpenCodex `oc-gpt-6-luna`와 내장 Pi의 세 차례 연속 대화도 확인했습니다.
  두 실제 연결에 각각 스토리지·권한 도구를 호출했고, 테스트 연결의 정확한 VM 시작 요청을
  준비했습니다. 첫 요청의 `type`/`kind` 매개변수 오류는 실행 전에 거부됐으며 모델이 수정했습니다.
  대화의 검토 카드에서 승인한 뒤 모델은 저장된 승인 결과, 작업 상태와 로그를 읽어
  `stopped`/`OK`를 확인했습니다. 시작 요청은 승인 전 미전송·승인 후 한 번만 전송했고
  후속 대화가 다시 실행하지 않았습니다. 대화 `c32efd38-8387-47a3-ad09-1843a370072f`의
  세 완료 이벤트가 API 재시작 후에도 저장돼 있고 실행 오류 이벤트는 없습니다. 이 브라우저
  확인은 `dd46f9c`의 UI에서 수행했으며 최종 `cc0ea0d`의 웹 번들 해시는 동일합니다.
  최종 API에서도 결과 복원·테스트 연결 삭제·미승인 테스트 작업 없음과 설정 보존을 확인했습니다.

## Proxmox token diagnosis and refresh (2026-10-02)

- Added the configured public token ID to `permissions` results and the management
  screen, without returning the token secret. Permission reads now run again when
  the user refreshes the node data. The screen treats a defined privilege with
  propagation flag `0` as granted, matching the
  [official ACL implementation](https://raw.githubusercontent.com/proxmox/pve-access-control/master/src/PVE/RPCEnvironment.pm).
- Proxmox/Pi, connector and mobile regression tests passed 21/21; server/mobile
  type checks and changed-file Biome checks passed. Source
  `a10069d9f4c4c60305df0dad912f70ac24381669` was committed and pushed to the private
  repository, then built on P41 as server and web. The API restarted only after
  confirming no active tasks or conversations. Existing connection configurations,
  environment file and default model `oc-gpt-6-luna` were preserved; all four
  service health endpoints returned HTTP 200.
- At 2026-10-02 01:51 UTC, both actual servers (`10.0.0.2:8006` and `10.0.0.3:8006`)
  were using `root@pam!openmuse` and still returned `{}` from the effective
  permissions endpoint. Their node storage lists were empty. The correct token
  and URLs are now confirmed; the saved Proxmox ACL still needs investigation.
- Real Chromium confirmed token IDs on both actual connection screens. A
  disposable loopback provider confirmed that refresh observes a new
  non-propagated privilege, displays storage, and observes subsequent revocation
  without reopening the screen. Desktop and phone views had no page errors and
  did not display the private token value. The fixture connector was deleted;
  actual Proxmox resources were never modified. Evidence is on P41 under
  `verification/proxmox-acl-20261002` (`deployment.json`, `acceptance.json` and
  screenshots).

## GitHub private source inspection (2026-10-02)

- Added six authenticated reads (`repo`, `branches`, `contents`, `tree`, `file`,
  `commits`) alongside the existing repository/issue/PR lists. Operation discovery
  publishes exact input schemas and Korean labels. Lists support pagination;
  files decode UTF-8 and support bounded character sections and continuation.
  Commit SHAs can pin inspection to one revision. Binary files and files above
  1 MiB return explicit unavailable metadata, and truncated tree responses remain
  marked incomplete. Stored PAT values and external download links are excluded
  from tool results. GitHub Enterprise API prefixes and encoded branch/file paths
  are preserved. Contracts follow the official GitHub APIs linked in
  [CONNECTORS.md](CONNECTORS.md#github-source-inspection).
- Updated shared connector and embedded Pi instructions to use authenticated
  GitHub source tools for private repositories and to inspect actual files before
  making claims about dependency usage. The GitHub setup description is Korean
  and now includes source/branch reads and Contents read permission requirements.
- Connector/Pi/Proxmox/mobile regression checks passed 39/39; server/mobile type
  checks and changed-file Biome checks passed. Source
  `d92f02c06910db07fca7568caba80e9f93b23f2d` was committed, pushed to private main
  and built as server/web on P41. API restart happened with no active tasks or
  conversations; environment, existing connections and default `oc-gpt-6-luna`
  were preserved. All four service health endpoints returned HTTP 200.
- The existing stored GitHub token authenticated as AppleFE. Actual private
  `AppleFE/openmuse` reads returned its main branch SHA, 23 root entries,
  283 recursive tree entries, three recent commits, decoded README.md and
  package.json. The newly paginated repository list returned 146 accessible
  repositories. `AppleFE/PPAI` returned 404 with this token and was absent from
  that list; its existence or code contents are not claimed as verified.
- The user corrected the intended repository name to `AppleFE/PBAI`. With the
  same stored GitHub connection, the private repository and default branch
  `master` were successfully read at commit
  `08341f8ab9b220c9daff3dad8ab2515a6c0ee9d9`. The connector returned 39 branches,
  19 root entries, a complete recursive tree of 549 entries, three recent commits,
  and decoded README.md, package.json and Cargo.toml. The earlier PPAI 404 was
  for the incorrect name; PBAI does not require reconnecting this token. Evidence
  is `verification/github-source-20261002/pbai-live-reads.json` on P41.
- Real Chromium verified the Korean GitHub setup text and an OpenCodex
  `oc-gpt-6-luna` conversation using embedded Pi. The model discovered operations,
  read repo/branches/contents, then read README.md and package.json using the same
  branch commit SHA. The finished conversation is named
  `검증: GitHub 비공개 소스 조회` (thread
  `c1bbc5b8-7ccd-4014-8f98-545885f82ff2`). There were no page errors, browser requests
  to other hosts or external writes. Evidence is on P41 under
  `verification/github-source-20261002` (`deployment.json`, `live-reads.json`,
  `repo-discovery.json`, `pi-acceptance.json` and screenshots).
- A contemporaneous Proxmox check confirmed that the user's ACL changes now
  provide effective permissions on both existing connections. Connection 2
  returned five node storages; connection 3 returned two. The prior empty-token
  ACL findings above are historical; no operational Proxmox write was performed.

## Earlier automated checks

- **154 tests pass**, with no failures or skipped tests, across the API, task engine, integrations, computer lifecycle, Docker runner, conversation queue, browser address handling, domain, and native date handling. Five new checks cover email search/read ownership, disconnected mail, evidence-based demo replies, and exhibit extraction without navigation noise.
- Biome formatting/lint, server/mobile/browser-worker TypeScript checks, and the server build pass.
- Expo exports web, iOS Hermes, and Android Hermes bundles. These exports do not produce signed native binaries.
- The **real Chromium lifecycle test passes**: public page navigation/read, failed profile cleanup, same-UUID reopen, text truncation, and localStorage/profile persistence after restart.
- The **real Docker computer smoke test passes** against the isolated `colima-openmuse` context: local image build, nonroot commands, read-only system files, disabled network, capped output, text editing, symlink rejection, PDF byte-preserving import/export, stop/start file persistence, and interruption of an actually running command. Its disposable container and volume are removed after the test.
- CI now includes a separate computer-container build/smoke job. Its YAML parses with unique keys and valid workflow triggers. The existing browser-container CI job was not rerun locally for this release; remote CI results remain separate from these local checks.

## Agent browser verification

- September 16: fresh native iPhone capture exercised Hacker News → CopilotKit → takeover and scrolling. A separate desktop capture exercised actual mailbox search/read → full email viewer → Monterey Bay Aquarium research → takeover. Browser results came from real Chromium; email came from the isolated fictional mailbox. The web capture reported no page errors. Live model and Google-account acceptance remain outside this recording.
- September 16: the new capybara bundles on web, iOS and Android. Both final recordings and covers were visually inspected, and MP4/GIF dimensions, durations, and decoding were checked. All 154 tests, lint, typecheck, server build, and three platform exports pass locally. Worker/container implementation is unchanged; the earlier smoke-test evidence below is historical.

- Actual CopilotKit BuiltInAgent streams `browse_web` calls and results. Tests cover successive reads, honest worker failures, cancellation, owner isolation, concurrent navigation/read pairing, and persistent per-thread profile reuse.
- Native iPhone acceptance: ask for Hacker News highlights → fully terminate and relaunch the app → summarize CopilotKit → open **Take control**. Both page reads returned the same session ID, and the console displayed the live CopilotKit page. Local chat now has a stable routed CopilotKit thread identity across app launches.
- Inline cards show reading progress, the source title, a real browser preview, and takeover. A historical source does not display a different page after that browser moves on. Pending calls show paused status after a stopped run; takeover waits until the active chat run finishes.
- The [AI Mock runner](DEMO.md#run-the-agent-browser-demo) drives the actual model/tool loop against a separate real Chromium worker. Its three tests verify prompt routing, current-turn tool results, failures, and model-protocol execution. Recorded responses are scripted page excerpts, not live-model reasoning.
- Full formatting/lint, server/mobile/worker types, all 149 tests, server build, all three Expo exports, frozen lockfile validation, and the real Chromium lifecycle test passed for this change. The Docker implementation and runtime dependencies did not change; its prior smoke evidence remains below.

## Feature acceptance matrix

| Area | Evidence | Boundary |
| --- | --- | --- |
| CopilotKit chat | Real runtime streams AG-UI events; actual BuiltInAgent/TanStack AI run against a local model-protocol fixture, call server tools including a computer command, persist its receipt, save a plan, prepare an event, wait for approval, and resume from the receipt. | Live model quality and provider-account acceptance are pending. |
| Durable work | Real PGlite restart, two-worker lease races, expired-lease recovery, cancellation, pause/resume, missing inputs, approval fairness, and saved outcomes are tested. | The server host must remain running. PGlite cannot be shared across processes; use PostgreSQL for a separate worker. |
| Document job | Background import → field input → new PDF → action review → sample sent receipt is tested without a client. The iPhone viewer displays the saved names and checkbox on a real two-page PDF. | Supported AcroForms only. OCR/scanned forms and some field types are not supported. |
| Reviews | Ownership/hash/version binding, expiry, account changes, disconnects, concurrent decisions, uncertain writes, and cancellation are tested. | An already dispatched provider request may finish after cancellation. |
| Gmail / Calendar | Real adapter code with controlled HTTP fixtures covers OAuth state races, scopes, complete MIME/threads/attachments, CRLF sends, calendar discovery, event CRUD, ETags, time zones, DST gaps, and unsupported recurrence. | No live Google credentials were supplied. A real-account acceptance run remains required. |
| Browser | Actual Chromium screenshots and console displayed on iPhone and web. Hacker News and CopilotKit navigation were exercised through both clients and updated the worker's page. Ownership, authorization, URL/DNS/egress checks, failed downloads, and recovery have automated coverage. | A separate Chromium worker; no automatic booking/payment or hostile-tenant isolation. |
| Linux computer | Native Terminal created `today.md`; Files read/save and PDF import/export/view were exercised. The real Docker smoke verifies isolation and persistence. Regressions cover owner binding, literal host argv, output caps, timeout/stop failures, stale-executor restart fencing, retryable Stop, and interrupted recovery without replay. | One owner, noninteractive commands, no terminal network, graphical desktop, or full VM. Persistent volumes have no portable per-volume disk quota. |
| Ideas | Evidence/accept/edit/dismiss and acceptance races are tested. Regression coverage retires completed document suggestions and excludes sent replies while preserving unfinished incoming requests. | Rules-based suggestions; broader model-derived personalization remains future work. |
| Goals / Tracking | Milestone validation, goal/task pausing, sample observation baseline/change/deduplication, failure backoff, and automatic pause are tested. A real public-page watch previously saved actual text. | Device push and adaptive long-term planning are not implemented. |
| Finance | CSV parsing, exact cents, invalid/ambiguous input, and persisted artifacts are tested. A new task delegated from the iPhone menu produced income 4,200.00, spending 110.99, and remaining 4,089.01 from four sample transactions. | Imported CSV only; no bank connection. |
| Identity / memory | Edit, persist, and forget paths are tested through the authenticated API. | Single owner per deployment. |
| Self-hosted threads | Local database and CopilotKit runtime tests cover authenticated owner scoping, stable main/side thread IDs, pagination, rename, archive/restore/delete, rich tool and role-labelled history, SSE replay, provider failures, cancellation, and restart recovery. A CopilotKit Core failure verifies that queued messages pause when the SDK emits an error but resolves its promise. | Integrated native/web acceptance should still exercise cross-device use and interruption against the deployed local runtime. |
| OpenBot | Disabled adapter has protocol and identity contract tests against a pinned public revision, including computer gateway, takeover, refusal, and uncertain outcomes. | No live identity, routine, or computer backend bridge yet. |
| Native / web UI | iPhone simulator and web preview have been exercised. Native acceptance covers actual task/results navigation, PDF pages, browser navigation, Linux Terminal and Files, finance, and goals. | Android is bundle-validated, not installed on a device/emulator. |

## Release fixes and interface polish

- The composer remains available during replies. Send changes to Stop in the same input pill, with a visible follow-up queue, retained drafts while navigating, and a control for returning to the latest message.
- The composer browser acceptance check verified the shared button position, enabled Stop with an empty draft, draft retention after stopping, immediate sending afterward with no held follow-ups, and reset to Send on natural completion. It reported no runtime errors. The iPhone simulator recording also shows the inline stop control. All seven [CI jobs for this change](https://github.com/CopilotKit/openmuse/actions/runs/35021854345) passed.
- The refreshed [mobile and web demos](DEMO.md) run 38 and 42 seconds at 1920 × 1080, with matching animated previews. Both feature the capybara; the web story combines email and aquarium research. The removed model/browser footer captions and web headline remain absent.
- The avatar opens activity and approvals. Name, tone, avatar color, and background-update preferences persist. Sheets adapt to narrow screens; icon targets, text contrast, and message spacing are refined.
- Computer separates Browser, Terminal, and Files. Command receipts remain visible, **New command** reopens the input, and an explicit straight-quote correction handles pasted smart quotes. Command and file drafts persist across sheet navigation; late file responses cannot overwrite a newer editor.
- Browser takeover uses a light console with live connection state, keyboard controls, retained text after errors, and visibility-aware previews. Regression tests verify edited-address reopen, signed-link renewal after 16 minutes, and owner boundaries. The console was inspected on web and the iPhone simulator.

- Ideas no longer proposes processing a sent reply or repeating a completed matching document task. The reproduction failed before the fix; both regression checks now pass.
- Guided chat delegation now emits actual AG-UI tool-call results linked to persisted task IDs. The runtime regression test verifies the task reference and original source email.
- Refined the composer focus state, spacing, send/attachment targets, and removable attachment chips. Older results expand on demand. Repeated “sample” labels were removed from product copy; Apps retains explicit local-data status and reviews explain local actions.
- The menu now retains **Delegate task** after chat has history. Creating a new finance task from this entry was exercised on iPhone and produced its saved artifact.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm lint
pnpm typecheck
pnpm --dir apps/worker typecheck
pnpm exec playwright install chromium
pnpm test
pnpm build:server
pnpm --dir apps/mobile exec expo export --platform all --output-dir dist/release
pnpm --dir apps/worker exec playwright install chromium
pnpm test:browser
# Requires a responsive Docker daemon; use DOCKER_CONTEXT if needed:
docker build -t openmuse-computer:local apps/computer
pnpm test:computer
# Separate browser-container acceptance (not run locally for this release):
pnpm --dir apps/worker test:docker
```

The [demo guide](DEMO.md) describes the native walkthrough. The CI workflow defines these validation categories for a fresh Linux environment. See [GitHub Actions](https://github.com/AppleFE/openmuse/actions/workflows/ci.yml) for remote CI results. No real mail was sent, purchase made, or private Google account connected during release verification.

## Still outside this release

Health, bank, social, and WhatsApp connectors; a managed generated-tool registry; voice/media generation; automatic purchases/reservations; mobile push; multi-tenant identity; and full desktop VM isolation. See the [roadmap](../ROADMAP.md).
