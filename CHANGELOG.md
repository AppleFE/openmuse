# Changelog

## 0.12.6 — 2026-10-13

- Show retry for waiting-input tasks, and add rerun buttons to schedule execution history for failed/waiting-input/paused tasks.
- Expose control_task in chat so an explicit request can requeue the existing task without creating a replacement schedule/job or changing timing. Pending approvals and owner boundaries remain enforced.
- Give explicit retries a new Pi run generation while keeping the same task/session and saved evidence. Reuse of the prior completed waiting-input checkpoint no longer prevents re-execution; untouched runs retain their original keys.

## 0.12.5 — 2026-10-13

- Extend Windows update downloads from five to thirty minutes. Retry interrupted transfers up to three times and resume saved partial downloads with validated HTTP Range responses.
- Stream SHA-256 verification without loading the whole installer into memory. Distinguish network/HTTP, timeout, disk-space, file-permission, range and checksum failures and expose download retry/verification state in settings.
- Verify real v0.12.3 → v0.12.4 download success. The originally reported intermittent failure cannot be classified from the older generic error message.

## 0.12.4 — 2026-10-13

- Accept a recorded task terminal-tool receipt when embedded Pi returns no trailing assistant text. Use the actual saved completion/question/approval outcome instead of marking completed tool work failed.
- Continue tool-only turns in the same durable session within the original iteration, tool and time limits. Empty turns with no tools and runs without a terminal task outcome still fail; no external actions are replayed or claimed complete.

## 0.12.3 — 2026-10-13

- Give scheduled/delegated tasks the same shared browser and native desktop tools as chat, with task cancellation, ordered execution, write approvals and durable failure evidence. Reject formal completion after an unresolved screen-action failure.
- Preserve the origin chat, its knowledge and approval mode for new AI-created schedules. Existing schedules remain valid and use review when no origin is available.
- Reattach closed native desktop helpers for screenshots/zoom on the same owned host, without replaying input or taking user control.
- Add Windows updates from the public GitHub release: automatic checks/downloads and install on exit, plus manual check/download/install in settings. Verify stable version, upstream asset, byte length and SHA-256 before execution; retain user data.

## 0.12.2 — 2026-10-12

- Allow public secure WebSockets in shared Chromium sessions through the same validated, IP-pinned HTTPS proxy. Previously every WebSocket was closed, preventing Discord QR authentication and breaking other real-time applications.
- Keep proxy tunnels alive while a browser session is open, including quiet login/QR sessions. Private networks, credentials in URLs, insecure WebSockets and nonstandard ports remain blocked.
- Include the fix in the Windows browser worker and Host Agent 0.10.4. Verify Discord QR generation without signing into a user's account.

## 0.12.1 — 2026-10-12

- Bundle a loopback browser worker and matching Chromium in the Windows installer. Shared browser viewing, control and browser-use tools work without Docker or a separate worker installation.
- Add Google Desktop OAuth JSON import to the Google connection screen, with encrypted per-workspace storage, PKCE and system-browser login. Google Cloud registration and enabled Gmail/Calendar APIs are still required.
- Persist the desktop API port across restarts so enrolled Host Agent callbacks keep the same address.
- Connect locally installed Host Agents over loopback, and separate copied PowerShell commands to prevent accidental `iexirm` concatenation. Ship Host Agent 0.10.3.

## 0.12.0 — 2026-10-11

- Add a Windows x64 installer with an embedded local server, database and web interface; no external Node.js or shared OpenCodex service is required.
- Add per-installation Sign in with ChatGPT using the official public-client OAuth flow, account selection, renewal, logout and account-specific model discovery.
- Encrypt account credentials and the workspace encryption key using Windows DPAPI. Keep OAuth tokens in the main process and bind internal services to loopback with private credentials.
- Preserve Responses tool calls, image input, streaming output and usage through a local ChatGPT plan adapter. Keep existing server/OpenCodex deployments supported.
- Package from a runtime allowlist and the production dependency lockfile, excluding developer configuration, credentials and conversations.

## 0.10.6 — 2026-10-08

- Add “모두 확인” to the chat update banner and notification list, with unread/all filters and Korean task-error titles. Bulk reads use explicit notification IDs so later arrivals remain unread.
- Add task deletion with stop-then-delete for active work. Remove associated run history and notifications after the worker finishes publishing; retain generated files, action receipts and schedule registrations.
- Expose schedule management from Activity and scheduled-task details, with active/all filters and bounded prompt previews.
- Prevent scheduled occurrences from creating or modifying schedule registrations. Skip pending retries after their registration is paused, changed or deleted.
- Recover native screenshot/zoom observations after a helper loses its session, using the same owned host. Never replay screen input or take user control.
- Guide desktop retries toward fresh native observations instead of stale vision refusals or SYSTEM-shell UIAutomation workarounds.
- Server/web update; existing Host Agent and desktop helper 0.10.2 remain compatible.

## 0.10.4 — 2026-10-08

- Return image dimensions and an explicit image-to-screen coordinate mapping with each computer-use zoom result, keeping separate mappings for multiple crops.
- Add observation-time guidance for tab search, narrow crops on wide desktops, and recovering from ineffective clicks.
- Require a fresh active-page check after selecting a tab so search-result domains are not mistaken for the page behind the popup.
- Verified a real Windows Chrome lookup with `gpt-6-sol`; `gpt-6-luna` still failed the same lookup in testing. This patch does not establish reliable computer use for every vision model.
- Server-only patch; Host Agent and desktop helper 0.10.2 remain compatible.

## 0.10.3 — 2026-10-08

- Show assistant answers after their tool cards so the final response stays at the bottom of long computer-use turns, including existing conversations.
- Collapse background task updates by default so a long notification does not push the latest chat answer offscreen; expand to see the full update and existing task controls.
- Describe and validate zoom rectangles as left/top/right/bottom, with corrective errors for inverted corners and guidance for unreadable browser tabs.
- Server/web patch; Host Agent and desktop helper 0.10.2 remain compatible.

## 0.10.2 — 2026-10-08

- Reattach the same desktop after the logged-in helper restarts, even when the Host Agent still considers it active. Reopening does not replay input or take user control.

## 0.10.1 — 2026-10-08

- Accept `Win`/`WIN`/`Windows` shortcuts in computer use and report unsupported keys as input errors instead of generic browser failures.
- Archive completed Host Agent shell receipts after 100 recent jobs so new commands continue to run. Archived operation IDs remain readable and cannot execute twice, including after restart.
- Report specific host command validation/state errors without exposing internal failures.
- Stop the logged-in desktop helper before updating its Python environment; use plain PowerShell output during installation.

## 0.10.0 — 2026-10-08

- Integrate the official Anthropic browser/computer toolset SDK as a provider-neutral execution layer; keep model routing in embedded Pi and support OpenCodex/OpenAI-compatible vision models.
- Add browser DOM references, screenshots, forms, keys and shared tabs, with expired/cross-tab reference rejection and fail-stop batches.
- Add shared native Windows/macOS/X11 desktops and isolated Docker virtual desktops, including mouse, keyboard, Unicode input, original-resolution zoom and JPEG live views.
- Ship an optional logged-in desktop helper with automatic startup, loopback authentication and explicit OS permission/availability reporting.
- Apply conversation review/bypass and user control ownership to screen input. Send real images to models while keeping image bytes out of UI/activity receipts.
- Repair the Mac mini Colima launcher and add desktop setup documentation. Host Agent/CLI 0.10.0 is required for the new remote capabilities.

## 0.9.3 — 2026-10-07

- Restore server message order when reconnecting or replying from another client, including intervening Host Agent reports.
- Synchronize authoritative history before streaming a new reply without duplicating full snapshots in stored run logs.
- Require fresh remote terminal targets and distinguish retired diagnostic panes from the user's original task when retrying.
- Existing Host Agent/CLI 0.9.0 installations remain compatible.

## 0.9.2 — 2026-10-07

- Distinguish OpenMuse's external remote-host shell from Herdr's in-pane skill workflow so a missing `HERDR_ENV` does not falsely block explicitly requested remote control.
- Require discovered session and pane/agent targets, preserve actual permission and blocked-state handling, and distinguish idle agents from absent processes.
- Server-only patch; existing Host Agent/CLI 0.9.0 installations remain compatible.

## 0.9.1 — 2026-10-07

- Import report-only Host Agent messages into the next embedded Pi turn, including reports previously missing from existing sessions.
- Persist report identities to avoid duplicate context on restart; preserve conversation boundaries and label reports as external task data.
- Clarify Windows SYSTEM versus interactive-user CLI paths so command lookup failures are not mistaken for account permission failures.
- Server-only patch; Host Agent and CLI 0.9.0 remain compatible and do not require reinstalling.

## 0.9.0 — 2026-10-07

- Fix parallel Pi tool calls by ending AG-UI argument streams before tool execution results arrive.
- Copy session IDs directly from chat; reliably copy host commands inside modals on HTTP hosts and offer manual selection if copying is blocked.
- Send Host Agent reports to a unique conversation name with `--target NAME` or `--thread-name NAME`.
- Enforce owner-scoped normalized name uniqueness, including archived chats, with atomic database constraints and a legacy duplicate-name migration.
- Separate active/archive pagination, compact conversation rows into an overflow menu, and prevent stale saved selections or approval reads from creating empty conversations.

## 0.8.0 — 2026-10-06

- Add separate notebooks to main and side conversations: categories, issues, persistent key notes, editable Markdown documents and pins.
- Reapply current notes and pinned documents to every model turn; provide scoped tools for long reference documents and snapshot context into delegated/team tasks.
- Default newly requested memories to the current conversation; retain explicitly shared workspace memory.
- Search conversations by name/category/issue, reject conflicting edits, and preserve notebooks across archive/restore and restart.

## 0.7.0 — 2026-10-06

- Attach images, multiple files and folders to chat; preserve folder paths and support web clipboard paste and drag/drop.
- Preview images, remove drafts and download originals; retain attachment references across reconnects and remove files with deleted conversations.
- Send actual image input through embedded Pi and standard model transports; read text/code/CSV/JSON and paginated PDF text with conversation-scoped tools.
- Discover image support for existing OpenCodex profiles, validate upload limits and ownership, and isolate PDF parsing in bounded workers.

## 0.6.1 — 2026-10-06

- Discover OpenCodex models at startup and every minute, with manual refresh and sync status in model selection and settings.
- Preserve existing profile IDs, default/team selections, disabled models and other providers; persist the last successful catalog for outage recovery.
- Verify a real Windows Host Agent test report in the main conversation and its OpenMuse AI acknowledgement.

## Unreleased

- Selectable model catalog (`OPENMUSE_MODELS`) across OpenAI, Anthropic, Google, and an OpenCodex data-plane proxy, with per-request model selection replacing the single `MODEL` setting.
- Durable multi-role agent teams: sequential or parallel dependency execution, role-labelled messages, dependency failure propagation, and restart recovery that resumes only interrupted roles.
- Authenticated infrastructure connectors for GitHub, Tailscale, Headscale, WireGuard, and multiple Proxmox identities — AES-256-GCM-encrypted credentials, write-only secrets, persisted health checks, settings UI, and read-only agent tools.
- Persisted system/light/dark theme with semantic palettes on iOS, Android, and web.
- Embedded pi coding runtime: configured coding-capable profiles route team `coder` roles, delegated agent/plan tasks, and conversational tool work through the official pi SDK with durable sessions, task-snapshotted models, bounded iterations/tool-call budgets, and cancellation-aware OpenMuse tools — host shell and filesystem tools are never registered.
- Optional TypeSafe.ai Jev policy layer (`TYPESAFE_*` or owner-saved key) with allow/block preflight, context-profile selection, per-tool guards, and `closed`/`local-budget` fail modes. Owner-scoped runtime settings API and settings UI.
- Connector hardening: URL config fields reject embedded credentials, health checks are bound to the credential set that produced them, and caller cancellation aborts provider I/O.
- Fixed the browser-worker lifecycle test to match current example.com page copy.

## 0.1.0-alpha — 2026-09-15

Initial public OpenMuse alpha.

- Native/web interface using CopilotKit React Native and AG-UI.
- Persistent browser computer, inline PDFs, structured artifacts, and optional Rich Threads integration.
- Durable delegated tasks, reviews/receipts, Ideas, Goals, Tracking, and editable memory.
- Google adapters, supported PDF workflows, and CSV spending summaries.
- Disabled, contract-tested OpenBot adapter for future backend integration.
- Native walkthrough recording, contributor docs, and CI for tests, builds, and real Chromium.
- Fixed Ideas suggesting sent replies or already completed matching work; restored task delegation in the persistent menu.

See [verification](docs/VERIFICATION.md) for actual coverage and [roadmap](ROADMAP.md) for incomplete integrations.
