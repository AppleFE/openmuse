# 브라우저 유즈와 컴퓨터 유즈 (0.10.0)

OpenMuse는 Anthropic의 [Browser Use SDK](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-sdk)와 [TypeScript toolset helpers](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/browser-toolset.md)를 **도구 실행 계층**으로 사용합니다. 모델 호출은 기존 embedded Pi와 선택한 공급자를 사용합니다. Claude API 키나 Claude 모델을 요구하지 않으며 OpenCodex/OpenAI 호환 모델도 같은 도구를 사용합니다. 이미지 관찰에는 `vision` capability가 있는 모델이 필요합니다. 이미지 없는 모델은 브라우저 DOM 참조와 텍스트를 사용할 수 있습니다.

## 사용

- “브라우저를 열고 이 페이지의 양식에 입력해 줘.” — `open_host_browser` → `browser_use`.
- “이 PC의 화면을 보고 조작해 줘.” — `computer_use_status` → `open_computer_desktop(mode: native, connectorId)` → `computer_use`.
- “가상 데스크톱을 열어 줘.” — `open_computer_desktop(mode: virtual)`.
- 앱의 **에이전트 컴퓨터 → 브라우저 / 데스크톱**에서 같은 화면을 볼 수 있습니다. **화면 제어 가져오기**로 직접 조작하고 끝나면 에이전트에게 반환합니다. 브라우저의 새 탭/전환/닫기도 지원합니다.
- 입력·클릭은 기존 대화별 승인/자동 승인 설정을 따릅니다. 검토 중에는 실행되지 않습니다. 사용자 제어 중에는 AI가 입력하거나 탭을 바꾸지 못합니다.

브라우저 도구는 DOM 참조, 텍스트 조회, 화면 캡처, 양식 입력, 클릭, 키, 스크롤, 탐색, 탭을 지원합니다. 참조는 페이지/탭 사이에 공유되지 않으며 새로 읽거나 탐색하면 만료됩니다. 임의 JavaScript, 파일 업로드, 네트워크/콘솔 로그 등 아직 구현하지 않은 SDK 멤버는 비활성화되어 있습니다. 기존 브라우저의 공개 HTTP(S) 목적지 제한과 다운로드 정책을 유지합니다.

컴퓨터 도구는 캡처, 원본 해상도 부분 확대, 클릭·드래그, 키·한글 입력, 스크롤을 지원합니다. 캡처와 입력 좌표는 1280×800이며 화면 비율에 따라 검은 여백이 생깁니다. 확대는 원본 화면에서 잘라 글자를 읽기 위한 기능이고, 클릭 좌표는 전체 캡처 기준입니다. 현재 기본 디스플레이만 지원합니다. 모니터 크기가 바뀌면 새 캡처 전까지 입력을 거부합니다.

한 번에 최대 8개의 동작을 순서대로 실행하며 하나가 실패하면 이후 동작을 건너뜁니다. 타임아웃 후 자동 재실행하지 않습니다. 모델용 이미지는 Pi에 전달하며 앱 활동/승인 기록에는 이미지 바이트를 중복 저장하지 않습니다.

## 원격 PC의 실제 화면

Host Agent 0.10.0 이상과 **로그인 사용자용 OpenMuse Desktop**이 필요합니다. SSH나 SYSTEM/root 서비스만 설치한 상태로는 실제 사용자 화면에 접근하지 못합니다. Host Agent 배포 폴더에서 로그인한 사용자로 실행하세요.

```sh
node install-desktop.mjs /absolute/path/to/host-agent/config.json
```

Windows 기본 설치 경로에서는 해당 사용자의 **관리자 PowerShell**에서:

```powershell
& 'C:\ProgramData\OpenMuseHostAgent\node-v24.21.0-win-x64\node.exe' 'C:\ProgramData\OpenMuseHostAgent\host-agent\install-desktop.mjs' 'C:\ProgramData\OpenMuseHostAgent\config.json'
```

- Python 3.10 이상이 필요합니다. Windows: `winget install Python.Python.3.12`, macOS: `brew install python`, Ubuntu/Debian X11: `sudo apt install python3-venv python3-tk scrot xclip`.
- 설치 스크립트는 사용자 디렉터리에 venv를 만들고 Python 의존성을 설치합니다. Windows는 로그인 시 Highest 예약 작업, macOS는 LaunchAgent, Linux는 graphical-session의 systemd 사용자 서비스를 등록합니다.
- 화면 보조 프로그램은 `127.0.0.1:8793`에서만 듣고 별도 무작위 토큰으로 Host Agent를 인증합니다. 외부 VNC 포트를 열지 않습니다. Host Agent는 설치된 보조 프로그램 설정을 자동으로 읽습니다.
- Windows는 로그인된 사용자 세션과 해당 사용자의 권한으로 동작합니다. 잠금/UAC/보안 화면은 조작하지 않습니다. macOS는 안내된 venv Python에 **화면 기록·손쉬운 사용**을 허용해야 합니다. Linux는 X11이 필요하며 Wayland/로그인 없는 서버에서는 가상 데스크톱을 사용합니다. macOS/Linux 사용자 서비스가 root 권한을 자동 취득하지는 않습니다.
- 실제 화면에서는 PyAutoGUI 모서리 비상 중단 기능을 유지합니다. 화면을 공유해도 기존 앱/파일은 종료 시 삭제되지 않습니다.

## 별도 가상 데스크톱

Docker를 실행하는 브라우저 워커 또는 Host Agent 호스트에서:

```sh
docker build -t openmuse-desktop:0.10.0 infra/desktop
# 브라우저 워커 환경에 설정한 뒤 재시작
OPENMUSE_DESKTOP_IMAGE=openmuse-desktop:0.10.0
```

Host Agent는 `config.json`의 `desktopImage`로도 설정할 수 있습니다(서비스 재시작 필요). 기본 이미지는 Debian X11, Openbox와 터미널을 제공합니다. 각 세션은 네트워크 없이, 읽기 전용 루트와 임시 홈, CPU/메모리/PID 제한, 호스트 볼륨 마운트 없이 실행됩니다. **세션을 닫으면 임시 파일이 초기화됩니다.** 기존 `/workspace` 셸 컴퓨터와는 별도의 환경입니다. 웹 탐색은 브라우저 유즈를 사용하세요.

화면을 보고 있거나 동작하는 동안 유지되며 30분 동안 접근하지 않으면 세션을 닫습니다. 워커 재시작 시 이전 가상 세션의 컨테이너를 정리합니다. 실제 화면과 가상 화면을 구분하여 표시하고, 실행 파일/이미지/OS 권한을 확인한 뒤 사용 가능 상태를 보여 줍니다.

## 검증

`tests/automation.test.ts`는 실제 toolset SDK와 OpenAI 호환 Pi 프로토콜, 이미지 전송, 승인, 사용자 제어권, 실패 후 중단을 검증합니다. `apps/worker/tests/automation.test.ts`는 실제 Chromium으로 DOM·양식·탭을 검증합니다. 로그인된 실제 화면 테스트는 `python infra/desktop/smoke.py <결과 디렉터리>`로 실행하며 전용 Tk 테스트 창에만 입력합니다. macOS 화면 권한과 Linux 데스크톱 환경은 설치한 호스트에서 별도로 확인해야 합니다.
