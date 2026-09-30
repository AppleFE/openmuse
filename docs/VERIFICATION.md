# Release verification

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
