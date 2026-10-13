# Windows 설치 앱

Windows 10/11 x64에서 `OpenMuse-Setup-0.12.4-x64.exe`를 실행하고 설치 위치를 선택합니다. 시작 메뉴 또는 바탕화면의 OpenMuse를 열면 자체 서버와 데이터베이스, 브라우저 워커가 함께 시작됩니다. Node.js, Docker 또는 다른 사람의 OpenCodex 서버를 설치하거나 연결할 필요가 없습니다.

## ChatGPT 연결

1. **Continue with ChatGPT**를 누릅니다.
2. 기본 브라우저에서 본인의 ChatGPT 계정으로 로그인하고 OpenMuse의 요금제 사용을 허용합니다.
3. OpenMuse로 돌아오면 해당 계정에서 제공하는 모델 목록을 불러옵니다. 앱과 설정에서 기본 모델을 선택할 수 있습니다.

ChatGPT 요금제 사용을 지원하는 계정과 앱 사용 권한이 필요합니다. 단순히 계정에 로그인한 것만으로 모든 요금제에 모델 사용 권한이 생기는 것은 아닙니다. 한도와 이용 가능 여부는 ChatGPT에서 결정하며, **사용량 관리 (Manage usage)** 버튼으로 확인할 수 있습니다. 이 연결은 별도의 Platform API 키를 사용하지 않습니다.

앱과 설정의 **ChatGPT 계정**에서 계정을 추가하거나 전환하고 로그아웃할 수 있습니다. 계정마다 별도의 등록과 인증 정보를 유지합니다. 계정을 바꾸면 진행 중인 모델 요청을 중단하고 모델 목록을 갱신합니다. 대화 데이터는 같은 Windows 워크스페이스에 유지되므로, 서로 다른 사람이 사용하는 PC에서는 별도의 Windows 사용자 계정을 사용합니다.

공식 프로토콜: [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source), [Responses 제한](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## 데이터와 실행

### Gmail · Google 캘린더

Google Cloud에서 OAuth 클라이언트를 **데스크톱 앱** 유형으로 만들고 JSON 파일을 다운로드합니다. 같은 프로젝트에 Gmail API와 Google Calendar API를 활성화하고 OAuth 동의 화면을 설정합니다. 테스트 상태라면 로그인할 계정을 테스트 사용자에 추가하세요.

OpenMuse의 연결 → Gmail 또는 Google 캘린더 → **OAuth JSON 파일 등록**에서 파일을 선택하고 **Google 연결**을 누릅니다. 기본 브라우저에서 권한을 승인한 뒤 OpenMuse에서 **연결 새로고침**을 누릅니다. JSON 파일과 액세스·갱신 토큰은 이 PC의 워크스페이스에 암호화 저장됩니다. 웹 애플리케이션용 OAuth 파일은 사용할 수 없습니다. JSON에 포함된 redirect URI 목록 대신 데스크톱 앱에서 지원하는 로컬 루프백 주소와 PKCE를 사용합니다.

배포자용 Google OAuth 클라이언트는 아직 등록되어 있지 않으므로 모든 사용자가 설정 없이 Google에 로그인하는 방식은 제공하지 않습니다. 공개 배포용 Gmail 권한은 Google의 검증 대상입니다. [Google 데스크톱 OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [제한된 범위 검증](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

### 내장 공유 브라우저 · Host Agent

에이전트 컴퓨터에서 OpenMuse 서버를 선택해 브라우저 세션을 열거나 채팅에서 브라우저를 열어 달라고 요청하세요. Chromium과 브라우저 워커가 설치 파일에 포함되어 앱과 함께 시작·종료합니다. 사용자는 공유 화면을 보거나 제어권을 전환할 수 있습니다. Windows 데스크톱 전체 제어에는 별도 Host Agent와 로그인 사용자용 Desktop 보조 프로그램이 필요합니다.

설치 앱에서 만든 Host Agent 명령은 **이 PC**에서 실행합니다. 로컬 서비스는 127.0.0.1로 연결됩니다. 설치 완료 메시지가 나오면 다시 실행할 필요가 없으며, 사용한 초대 링크는 재사용할 수 없습니다. `iexirm` 오류는 명령 두 개를 공백이나 줄바꿈 없이 붙여 넣었을 때 발생합니다. 재설치할 때 새 명령을 한 번만 붙여 넣으세요.

0.12.1부터 API 포트를 워크스페이스에 저장하므로 앱 재실행 후에도 Host Agent 알림 주소가 유지됩니다. 0.12.0에서 이미 설치한 Host Agent는 업데이트 후 새 설치 명령으로 다시 연결해야 합니다. 기존 로컬 설치의 포트 변경은 재설치 시 자동 반영하며, 다른 서버에 연결된 설치는 자동 덮어쓰지 않습니다. 설치 앱이 꺼져 있는 동안에는 OpenMuse로 호출할 수 없습니다.

- 데이터는 `%APPDATA%\OpenMuse` 아래에 보관합니다. 암호화된 계정 파일과 워크스페이스 키는 해당 Windows 사용자에게 묶입니다. 다른 PC로 인증 파일을 복사하지 말고 다시 로그인하세요.
- 설치 파일에는 개발자의 서버 주소, OpenCodex 키, 기존 대화나 계정 정보가 포함되지 않습니다.
- 앱 종료 시 로컬 서버도 종료됩니다. 예약 작업을 실행하려면 앱을 켜 두어야 합니다.
- 원격 호스트와 외부 커넥터는 사용자가 직접 연결해야 합니다. Docker 컴퓨터나 Host Agent를 자동으로 설치하거나 관리자 권한을 부여하지 않습니다. 로컬 서버는 127.0.0.1에만 바인딩하므로 다른 PC에서 접속하는 서버 용도로는 기존 서버 배포를 사용하세요.
- 업그레이드와 제거 시 사용자 데이터를 자동 삭제하지 않습니다. 앱을 종료한 상태에서 데이터를 백업할 수 있습니다.
- 현재 설치 파일에는 코드 서명이 없습니다. Windows가 게시자를 확인하지 못했다는 알림을 표시할 수 있습니다.

## 개발 및 배포

### 앱 업데이트

앱과 설정의 **OpenMuse 업데이트**에서 현재 버전과 업데이트 상태를 확인합니다.
자동 업데이트는 기본으로 켜져 있으며 시작 시와 4시간마다 GitHub의 최신 정식 릴리스를 확인합니다.
새 Windows x64 설치 파일을 다운로드하고 SHA-256을 검증한 뒤 앱을 종료할 때 설치합니다.
앱을 다시 열면 새 버전으로 실행됩니다. 업데이트 중에는 채팅·계정·워크스페이스 데이터를 삭제하지 않습니다.

자동 업데이트를 끄면 **업데이트 확인 → 다운로드 → 앱 종료 후 업데이트 설치**로 수동 갱신합니다.
0.12.2 이하에는 업데이트 기능이 없으므로 0.12.3 설치 파일로 한 번 직접 업데이트해야 합니다.
GitHub 접속 실패나 설치 파일 검증 실패 시 기존 버전을 유지하고 오류를 표시합니다.
다운로드 대상은 AppleFE/openmuse의 정식 릴리스이며 사전 릴리스·이전 버전은 설치하지 않습니다.

```powershell
pnpm install --frozen-lockfile
pnpm test:desktop
pnpm typecheck
pnpm build:windows
pnpm test:desktop:app
```

결과는 `dist/windows/OpenMuse-Setup-0.12.4-x64.exe`에 생성됩니다. `pnpm build:windows --dir`는 설치 프로그램 대신 실행 폴더만 생성합니다. Electron에는 Node.js 런타임이 포함되며, 별도의 프로세스에서 API와 PGlite를 실행합니다. 개발 환경의 `.env`와 API 키는 이 프로세스에 전달하지 않습니다.

ChatGPT 로그인은 공개된 OAuth 프로토콜에 따라 직접 구현했습니다. DevKit 코드를 포함하지 않습니다. PKCE, state/nonce, JWKS 서명·issuer·audience·subject 검사, 암호화 저장, 회전 토큰의 직렬 갱신 및 취소 처리를 포함합니다. 실사용 OAuth 승인은 사용자의 기본 브라우저에서만 이루어집니다.
