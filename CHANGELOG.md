# Changelog

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
