# Open Intelligent UI in OpenMuse

OpenMuse 0.11 adds interactive visual answers inspired by [CopilotKit Open Intelligent UI](https://github.com/CopilotKit/OpenIntelligentUI) and its [Open Generative UI contract](https://docs.copilotkit.ai/generative-ui/open-generative-ui).

## 사용 방법

기본 채팅이나 별도 채팅에서 평소처럼 요청합니다. 예를 들어:

- “이 비용들을 비교하는 대화형 그래프를 만들어줘.”
- “이율과 기간을 바꿀 수 있는 복리 계산기로 설명해줘.”
- “정렬 알고리즘이 작동하는 과정을 단계별 애니메이션으로 보여줘.”
- “회전시켜 볼 수 있는 3D 도형으로 설명해줘.”

AI는 설명에 도움이 되는 경우 그래프, 도표, 계산기, 시뮬레이션 등을 대화 안에 만듭니다. 일반 설명과 간단한 표는 텍스트로 답할 수 있습니다. 라이브 데이터가 필요한 요청은 먼저 기존 도구로 데이터를 조회해야 합니다. 생성된 화면 자체가 원격 호스트의 실시간 모니터링 연결을 얻는 것은 아닙니다.

생성 중에는 정적 미리보기가 나타나고, 도구 인수 검증이 끝나면 조작할 수 있습니다. **HTML 다운로드**, **화면 접기**, **크게 보기**, **초기화**를 제공합니다. 화면에서 추가 질문을 요청하면 채팅에 초안이 나타납니다. **채팅에 보내기**를 눌러 해당 대화에서 이어갑니다. 생성된 코드가 자동으로 메시지를 보내거나 도구 실행을 승인하지 않습니다.

대화 기록에 코드가 보존되어 다시 열면 복원됩니다. 슬라이더 등 로컬 조작 상태는 새로고침·초기화·재열기 시 초기값으로 돌아갑니다. 내려받은 HTML도 초기 상태의 화면입니다. 내려받은 파일에서는 OpenMuse로 질문을 보내지 않고 질문 내용을 표시합니다.

## 모델 및 구현

- 특정 모델 API에 종속되지 않습니다. 기존 OpenCodex·Pi·TanStack 모델 경로와 도구 호출을 사용합니다. 별도 OpenAI/Claude/TypeSafe 키를 요구하지 않습니다.
- `generateSandboxedUi`는 원본과 같은 CSS-first 인수 순서를 사용합니다: `initialHeight`, `placeholderMessages`, `css`, `html`, `jsFunctions`, `jsExpressions`. OpenMuse는 `title`, `libraries`를 추가합니다.
- React Native headless 채팅과 기존 SQL 기록을 유지하기 위해 activity 메시지 대신 기존 AG-UI tool call과 `useRenderTool`에 연결했습니다. Pi에서는 이 도구의 인수 델타만 조기에 전달하고, 실행 시 시작 이벤트를 중복시키지 않습니다. 전체 모델 응답이 한 번에 도착하는 제공자는 미리보기 역시 한 번에 표시됩니다.
- 코드와 결과는 소유자별 대화 기록에 저장합니다. 대화 삭제·접근 통제를 그대로 따르며, 별도의 공개 코드 저장소나 웹사이트를 만들지 않습니다.
- SVG/Canvas와 일반 DOM은 외부 라이브러리 없이 동작합니다. 선택적으로 Chart.js 4.4.7, D3 7.9.0, Three.js 0.160.0, GSAP 3.12.5의 고정 CDN 경로만 로드합니다. 이 경우 라이브러리를 받기 위한 인터넷 연결이 필요합니다. 지도 타일·임의 사진 URL·React JSX는 기본 지원하지 않습니다.
- 전체 코드 합계 160,000자와 필드별 제한이 있습니다. 렌더링 품질과 복잡한 시뮬레이션의 정확성은 생성한 모델과 브라우저에 따라 다릅니다. 도구의 `accepted` 결과는 코드 접수를 의미하며 실제 화면의 성공을 보장하는 검증 결과가 아닙니다.

## 실행 경계

생성된 HTML/CSS/JS는 서버에서 실행하지 않습니다. 웹은 `sandbox="allow-scripts"`의 opaque-origin iframe, 네이티브는 WebView 안의 동일한 iframe을 사용합니다. 다운로드한 HTML도 이 경계를 유지합니다. 부모 DOM·쿠키·저장소·인증 토큰·파일·셸을 제공하지 않으며, CSP로 fetch, 객체, 하위 프레임, 폼 전송과 허용하지 않은 리소스를 차단합니다. HTML의 스크립트, 이벤트 속성, 탐색용 태그를 제거하고 생성 JavaScript는 검증 완료 후 실행합니다.

`postMessage`는 프레임 출처와 채널 및 메시지 스키마를 검증합니다. 높이는 제한하며 추가 질문은 4,000자 이하의 초안만 허용합니다. 이 경계는 별도 VM이나 CPU/메모리 격리가 아니며 임의 코드의 무한 반복까지 방지하지는 않습니다. 브라우저의 iframe 자체 탐색 제약도 완전한 네트워크 방화벽은 아닙니다. 자격 증명이나 불필요한 민감 정보를 생성 코드에 포함시키지 않습니다.

## 검증

`tests/generative-ui.test.ts`는 Chromium에서 계산 조작, 초안 브리지, 정적 미리보기, 독립 HTML 실행, 부모 쿠키/저장소 접근 차단과 네트워크 요청 차단을 검사합니다. `tests/pi-protocol.test.ts`는 실제 Pi SDK의 조각난 Responses tool call, 이벤트 순서, 저장된 코드 복원, 소유자 격리를 검사합니다. 네이티브 번들 검사와 네이티브 기기 실제 실행 검사는 별개입니다. 최신 확인 결과는 [검증 기록](VERIFICATION.md)을 참고하세요.
