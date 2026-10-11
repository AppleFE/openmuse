# Windows 설치 앱

Windows 10/11 x64에서 `OpenMuse-Setup-0.12.0-x64.exe`를 실행하고 설치 위치를 선택합니다. 시작 메뉴 또는 바탕화면의 OpenMuse를 열면 자체 서버와 데이터베이스가 함께 시작됩니다. Node.js, Docker 또는 다른 사람의 OpenCodex 서버를 설치하거나 연결할 필요가 없습니다.

## ChatGPT 연결

1. **Continue with ChatGPT**를 누릅니다.
2. 기본 브라우저에서 본인의 ChatGPT 계정으로 로그인하고 OpenMuse의 요금제 사용을 허용합니다.
3. OpenMuse로 돌아오면 해당 계정에서 제공하는 모델 목록을 불러옵니다. 앱과 설정에서 기본 모델을 선택할 수 있습니다.

ChatGPT 요금제 사용을 지원하는 계정과 앱 사용 권한이 필요합니다. 단순히 계정에 로그인한 것만으로 모든 요금제에 모델 사용 권한이 생기는 것은 아닙니다. 한도와 이용 가능 여부는 ChatGPT에서 결정하며, **사용량 관리 (Manage usage)** 버튼으로 확인할 수 있습니다. 이 연결은 별도의 Platform API 키를 사용하지 않습니다.

앱과 설정의 **ChatGPT 계정**에서 계정을 추가하거나 전환하고 로그아웃할 수 있습니다. 계정마다 별도의 등록과 인증 정보를 유지합니다. 계정을 바꾸면 진행 중인 모델 요청을 중단하고 모델 목록을 갱신합니다. 대화 데이터는 같은 Windows 워크스페이스에 유지되므로, 서로 다른 사람이 사용하는 PC에서는 별도의 Windows 사용자 계정을 사용합니다.

공식 프로토콜: [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source), [Responses 제한](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## 데이터와 실행

- 데이터는 `%APPDATA%\OpenMuse` 아래에 보관합니다. 암호화된 계정 파일과 워크스페이스 키는 해당 Windows 사용자에게 묶입니다. 다른 PC로 인증 파일을 복사하지 말고 다시 로그인하세요.
- 설치 파일에는 개발자의 서버 주소, OpenCodex 키, 기존 대화나 계정 정보가 포함되지 않습니다.
- 앱 종료 시 로컬 서버도 종료됩니다. 예약 작업을 실행하려면 앱을 켜 두어야 합니다.
- 원격 호스트와 외부 커넥터는 사용자가 직접 연결해야 합니다. Docker 컴퓨터나 Host Agent, 브라우저 드라이버를 자동으로 설치하거나 관리자 권한을 부여하지 않습니다. 로컬 서버는 127.0.0.1에만 바인딩하므로 다른 PC에서 접속하는 서버 용도로는 기존 서버 배포를 사용하세요.
- 업그레이드와 제거 시 사용자 데이터를 자동 삭제하지 않습니다. 앱을 종료한 상태에서 데이터를 백업할 수 있습니다.
- 현재 설치 파일에는 코드 서명이 없습니다. Windows가 게시자를 확인하지 못했다는 알림을 표시할 수 있습니다.

## 개발 및 배포

```powershell
pnpm install --frozen-lockfile
pnpm test:desktop
pnpm typecheck
pnpm build:windows
pnpm test:desktop:app
```

결과는 `dist/windows/OpenMuse-Setup-0.12.0-x64.exe`에 생성됩니다. `pnpm build:windows --dir`는 설치 프로그램 대신 실행 폴더만 생성합니다. Electron에는 Node.js 런타임이 포함되며, 별도의 프로세스에서 API와 PGlite를 실행합니다. 개발 환경의 `.env`와 API 키는 이 프로세스에 전달하지 않습니다.

ChatGPT 로그인은 공개된 OAuth 프로토콜에 따라 직접 구현했습니다. DevKit 코드를 포함하지 않습니다. PKCE, state/nonce, JWKS 서명·issuer·audience·subject 검사, 암호화 저장, 회전 토큰의 직렬 갱신 및 취소 처리를 포함합니다. 실사용 OAuth 승인은 사용자의 기본 브라우저에서만 이루어집니다.
