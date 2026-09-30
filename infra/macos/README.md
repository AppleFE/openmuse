# macOS production deployment

This directory supports a single-owner OpenMuse installation on Apple silicon with its source,
runtime, data, caches, browser profiles, and logs on `/Volumes/p41-1tb`. It does not install Node,
change Tailscale, touch unrelated launchd jobs, or contain credentials.

For the active P41 installation, owner sign-in and the verified model/service state are recorded
in the private host file `/Volumes/p41-1tb/openmuse/README-DEPLOY.md`. It contains no secret values;
use the private `.env` only on the Mac when an owner key is needed.

## Runtime layout

| Path | Purpose |
| --- | --- |
| `/Volumes/p41-1tb/openmuse/repo` | Git checkout or verified bundle extraction |
| `/Volumes/p41-1tb/openmuse/runtime/node-v24…-darwin-arm64` | Externally verified official Node 24 archive |
| `/Volumes/p41-1tb/openmuse/runtime/node-current` | Symlink selected by `deploy.sh` |
| `/Volumes/p41-1tb/openmuse/data/app` | PGlite database, documents, signing key, and pi sessions |
| `/Volumes/p41-1tb/openmuse/data/browser-profiles` | Persistent Chromium state and downloads |
| `/Volumes/p41-1tb/openmuse/caches` | pnpm store and Playwright Chromium |
| `/Volumes/p41-1tb/openmuse/logs` | launchd stdout/stderr |
| `/Volumes/p41-1tb/openmuse/runtime/ollama` | Verified Ollama CLI in its app bundle; the desktop app is not launched |
| `/Volumes/p41-1tb/openmuse/runtime/ollama-download` | Pinned official Ollama archive used to install the local CLI |
| `/Volumes/p41-1tb/openmuse/data/models/ollama` | Downloaded local inference models |
| `/Volumes/p41-1tb/openmuse/data/ollama-home` | Ollama server state, separate from the user's home directory |

The API listens only on `127.0.0.1:8787` and starts the task worker in that same process. Do not
start `start:worker` or set `DATABASE_URL`: a second process cannot open the embedded PGlite store.
The browser worker listens only on `127.0.0.1:8790`. The small Node web service serves the Expo
export and proxies every `/api` request to the loopback API, preserving authorization, Origin,
streaming responses, signed query strings, and cancellation.

The web service may bind loopback plus the Mac's specific Tailnet address. It rejects wildcard
binds in deployment validation. It does not provide TLS or internet-edge hardening: use only the
encrypted Tailnet or an SSH tunnel, and do not alter an existing Tailscale Serve configuration.

## Required configuration

Copy `env.production.example` to the checkout's `.env`, keep it mode `600`, and replace the
placeholders. `validate-env.mjs` reports names and requirements only; it never prints values.

| Setting | Initial sample/model deployment | Live Gmail/Calendar deployment |
| --- | --- | --- |
| `OPENMUSE_ACCESS_KEY` | Required here because the sample workspace is proxied; 24+ random characters | Required |
| `MODEL` or `OPENMUSE_MODELS` | Required with at least one enabled model | Required |
| OpenCodex gateway | `MODEL=opencodex/gpt-6-sol`, `OPENCODEX_BASE_URL` and server-only `OPENCODEX_API_KEY` | Same |
| Cloud model credential | Only required when a cloud provider model is selected | Same |
| `WORKER_TOKEN` | Required in API and browser worker; 32+ random characters | Same |
| `TOKEN_ENCRYPTION_KEY` | Optional shared connector/Jev vault key; if set, exactly 32 random bytes encoded as base64. Otherwise private vault keys are generated. | Required; exactly 32 random bytes encoded as base64 |
| Google OAuth client | Not used; fictional mail/calendar remain available | Required to connect Gmail/Calendar |

For Google, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, enable Gmail and Calendar APIs, and
register `${PUBLIC_API_URL}/api/google/callback` exactly. Start with `WORKSPACE_MODE=sample` and
`AGENT_BACKEND=model` until live OAuth credentials are intentionally supplied.

`EXPO_PUBLIC_API_URL` is compiled into public JavaScript, so it must contain only the public
origin—never an owner, provider, worker, or Google credential. It must equal
`PUBLIC_API_URL`, and that origin must appear exactly in `ALLOWED_ORIGINS`. Changing any of these
three values requires rebuilding the web export with `deploy.sh`.

The normal sample mode is unauthenticated. This deployment configures `OPENMUSE_ACCESS_KEY`, which
now opts sample mode into the same owner-key session gate as live mode. The UI first tries the local
session, then presents its existing key form after the protected server rejects that attempt.

현재 P41 설치는 맥미니의 OpenCodex 게이트웨이를 사용합니다. 로컬 Qwen3 4B·8B 모델은
사용자 요청으로 삭제했으며 Ollama 실행과 자동 시작도 중지했습니다. 모델 파일은 남아 있지
않습니다. Ollama 설치 도구는 선택 기능으로만 유지되며 일반 배포가 모델을 다시 설치하지 않습니다.
인증 정보를 제외한 현재 설정은 다음과 같습니다.

```dotenv
AGENT_BACKEND=model
MODEL=opencodex/gpt-6-sol
OPENCODEX_BASE_URL=http://100.80.94.16:20100/v1
```

`OPENCODEX_API_KEY`는 Mac의 `/Volumes/p41-1tb/opencodex-p41/state/service-api-token`에서
읽어 서버의 mode-600 `.env`에만 설정합니다. 웹 번들·저장소·로그에 키를 넣지 않습니다.
LAN에서 게이트웨이를 이용할 때는 `http://192.168.0.206:20100/v1`도 사용할 수 있습니다.

인증된 `/v1/models`가 제공한 모델 80개를 `OPENMUSE_MODELS`에 등록했습니다. 웹에서 새 대화의
기본 모델과 팀 역할별 모델을 선택할 수 있습니다. 기본 선택은 `oc-gpt-6-sol`이며 실제 요청에는
`gpt-6-sol`을 전송합니다. 공급자별 접두사가 있는 모델 ID도 그대로 전송합니다. 기존 팀의 로컬
모델 연결은 OpenCodex 모델로 전환했으며 과거 작업·대화 기록은 보존했습니다.

OpenMuse의 앱·DB·Pi 도구는 맥미니에서 실행됩니다. 모델 추론은 OpenCodex가 연결한 모델
공급자가 처리합니다. CopilotKit 프로젝트 키는 필요하지 않으며 `OPENMUSE_ACCESS_KEY`는
워크스페이스 로그인용으로 별도 유지합니다.

## Install or update

1. Put the clean checkout at `/Volumes/p41-1tb/openmuse/repo`. Preserve the private `.env` across
   updates and verify that no secret is tracked with `git status --short --ignored`.
2. Unpack a verified official arm64 Node 24 archive below `openmuse/runtime`. This repository does
   not duplicate that supply-chain step.
3. On first install, run the command below with the actual unpacked directory. On later updates,
   `OPENMUSE_NODE_DIR` may be omitted because `node-current` already exists.

   ```sh
   cd /Volumes/p41-1tb/openmuse/repo
   OPENMUSE_NODE_DIR=/Volumes/p41-1tb/openmuse/runtime/node-v24.x.y-darwin-arm64 \
     ./infra/macos/deploy.sh
   ```

4. If the script created `.env`, populate the non-secret layout fields and locally generated owner
   and worker tokens, then rerun. The default local Ollama model does not require an API key.
5. Install or refresh only OpenMuse's three LaunchAgents:

   ```sh
   ./infra/macos/install-launch-agents.sh
   ```

6. Install the pinned Ollama runtime and its dedicated login LaunchAgent. These commands touch only
   `com.openmuse.ollama`; they do not replace the web, browser-worker, server, Colima, or other
   LaunchAgents. The runtime zip is checksum-verified and remains under P41, and this installs the
   CLI app bundle without opening its desktop app:

   ```sh
   ./infra/macos/install-ollama-runtime.sh
   ./infra/macos/install-ollama-launch-agent.sh
   ./infra/macos/setup-ollama-model.sh
   ```

   The Ollama service binds only to `127.0.0.1:11434`, stores its model and state under
   `/Volumes/p41-1tb/openmuse`, and sets `OLLAMA_NO_CLOUD=1`. `qwen3:4b` is a 4B Q4 model listed at
   approximately 2.5 GB; it supports agent tool use and fits the Mac mini's 16 GB shared memory
   better than larger models. Keep requests on the server side; do not expose Ollama on Tailnet or
   directly to browsers.

`deploy.sh` uses the lockfile, the pinned package-manager version in `package.json`, the P41 pnpm
store, and the configured P41 Playwright cache. It builds the server, compiles the Expo web origin,
and installs matching Chromium. Package lifecycle/build commands receive only the one public Expo
origin or Playwright cache variable they need, not owner/provider credentials.
`install-launch-agents.sh` validates first, replaces only
`com.openmuse.server`, `com.openmuse.browser-worker`, and `com.openmuse.web`, and leaves all unrelated
services alone. When API configuration is invalid, it installs browser and web but explicitly
removes/omits the API LaunchAgent. After correcting configuration, rerun both scripts; full
validation then permits API installation. It never kills an arbitrary process merely because it
holds one of the expected ports. Before replacing a job, the restricted launcher stops only the PID
it recorded and only after its complete command line and owner match that service; a mismatched
ownership record fails closed. Installation relies on each plist's `RunAtLoad` instead of forcibly
restarting a newly bootstrapped SSH job. Together, these prevent an SSH-backed Node child from
surviving a LaunchAgent restart and blocking the replacement listener. A separately managed
`com.openmuse.colima` job remains ops-owned; this installer neither replaces nor restarts it.

On this host, macOS privacy controls deny ordinary background launchd children access to the
removable P41 volume even though an interactive login can read it. The installer therefore creates
a dedicated localhost-only Ed25519 key and a forced-command entry that accepts exactly `server`,
`browser-worker`, or `web`. The LaunchAgents disable forwarding, PTYs, ambient identities, and permissive
host-key handling. The forced dispatcher uses an exact `case` statement (no `eval`) and redirects
service logs on P41. Existing unrelated `authorized_keys` entries are preserved. Remote Login must
be enabled, but the dedicated key is restricted to source address `127.0.0.1` and cannot open an
arbitrary shell.

These are per-user LaunchAgents: they start after `aeonge` logs in, not before login. That login
boundary is intentional because it is what grants the external-volume access used by the
localhost `sshd` child. A future system-daemon design would need a separately reviewed macOS
privacy entitlement rather than weakening this bridge.

The LaunchAgents use `PathState` for `/Volumes/p41-1tb`, and the runner independently waits at most
30 seconds for the expected mount. If the disk is absent, it exits without creating fallback data
on the system disk; launchd waits for the volume path instead of continuously respawning it.

## Verify

Check service state and loopback health without displaying configuration:

```sh
launchctl print gui/$(id -u)/com.openmuse.server
launchctl print gui/$(id -u)/com.openmuse.browser-worker
launchctl print gui/$(id -u)/com.openmuse.web
curl --fail http://127.0.0.1:8787/api/health
curl --fail http://127.0.0.1:8790/health
curl --fail http://127.0.0.1:8081/healthz
```

Then open `PUBLIC_API_URL`, enter the owner access key, and verify model chat plus a public-page
browser task. A browser worker `/health` response proves only the Node service is up; the real task
also verifies Chromium, token wiring, proxy streaming, and profiles on P41.

Run repository checks before shipping a support change:

```sh
pnpm test:macos-deploy
pnpm exec tsx --test tests/api.test.ts tests/config.test.ts
pnpm typecheck
```

Logs are under `/Volumes/p41-1tb/openmuse/logs`. Back up `data/app` and `data/browser-profiles` with
owner-only permissions; both may contain private content. Never attach `.env`, PGlite files,
browser profiles, pi sessions, or unredacted logs to an issue.

## Optional scoped computer

The initial deployment leaves `COMPUTER_ENABLED=false`. To enable the Linux workspace, first create
a dedicated Colima/Docker context, build `apps/computer` into that context, and set
`DOCKER_CONTEXT`, `COMPUTER_IMAGE`, and a stable `COMPUTER_DEPLOYMENT_ID` in `.env`. Validation
requires the explicit context when the feature is enabled, preventing accidental use of an
unrelated default Docker engine. Do not mount the host checkout, `.env`, or Docker socket into the
computer container beyond the application's documented Docker control boundary.

## Rollback and removal

Before a code rollback, stop only the three OpenMuse jobs, back up P41 data, switch the clean
checkout to the reviewed commit, rerun `deploy.sh`, and reinstall the LaunchAgents. Database
compatibility across arbitrary old commits is not guaranteed, so retain the backup.

To stop these jobs without deleting data:

```sh
for label in com.openmuse.server com.openmuse.browser-worker com.openmuse.web; do
  launchctl bootout "gui/$(id -u)/$label" || true
done
```

Removing plist files or P41 data is intentionally not automated.
