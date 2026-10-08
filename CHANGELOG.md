# Changelog

## 0.10.4 — 2026-10-08

- Return image dimensions and an explicit image-to-screen coordinate mapping with each computer-use zoom result, keeping separate mappings for multiple crops.
- Add observation-time guidance for tab search, narrow crops on wide desktops, and recovering from ineffective clicks.
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
