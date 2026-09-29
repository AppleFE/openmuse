# Changelog

## Unreleased

- Selectable model catalog (`OPENMUSE_MODELS`) across OpenAI, Anthropic, Google, and an OpenCodex data-plane proxy, with per-request model selection replacing the single `MODEL` setting.
- Durable multi-role agent teams: sequential or parallel dependency execution, role-labelled messages, dependency failure propagation, and restart recovery that resumes only interrupted roles.
- Authenticated infrastructure connectors for GitHub, Tailscale, Headscale, WireGuard, and multiple Proxmox identities — AES-256-GCM-encrypted credentials, write-only secrets, persisted health checks, settings UI, and read-only agent tools.
- Persisted system/light/dark theme with semantic palettes on iOS, Android, and web.
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
