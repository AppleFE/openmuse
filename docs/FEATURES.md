# OpenMuse feature inventory

The native and web agent core runs locally. This inventory describes the current implementation and remaining extensions. Live providers and optional infrastructure require separate configuration and validation.

## Implemented coverage

| Area | Current implementation | Remaining extension |
| --- | --- | --- |
| Chat / delegated work | Native CopilotKit chat, server tools, durable tasks and confirmed outcomes | Live model/provider acceptance testing |
| Ideas / personal context | Source-backed mail/goal rules, accept/edit/dismiss, identity, editable/forgettable memories | Broader model-derived cross-connector suggestions |
| Goals / Tracking | Milestones, recurring watches, observations, retry/backoff, pause and cancellation | Adaptive long-term planning and calendar-driven reminders |
| Browser | Persistent Chromium, public page reads, snapshots, console takeover, PDF downloads | Autonomous interactive booking and per-person VM orchestration |
| Linux computer | Nonroot Docker container, bounded bash/Python/Node/git commands, saved output and exit receipts, persistent workspace files, text editing, PDF import/export | Interactive terminal, desktop apps, controlled egress, disk quotas and stronger VM isolation |
| Gmail / Calendar | Google OAuth; complete threads; saved drafts; calendar/event CRUD with reviewed versions | Live Google acceptance, recurrence editing, other connectors |
| Models / Teams | Server-owned model catalog (local Ollama, OpenAI, Anthropic, Google, OpenCodex), per-request model selection, durable multi-role agent teams with sequential or parallel dependency execution, role-labelled messages, and restart recovery | Live hosted-provider acceptance, richer role capability routing |
| Jev / Pi runtime | Embedded pi executes configured coding-capable profiles for team `coder` roles, delegated agent/plan tasks, and conversational tool work — durable sessions, bounded iterations/tool calls, OpenMuse-only tools (no host shell/filesystem), combined cancellation. Optional TypeSafe.ai Jev policy layer gates preflight, context selection, per-tool guards, and termination with owner-configured fail modes | Live TypeSafe.ai and coding-model acceptance; richer policy profiles |
| Theme | Persisted system/light/dark preference with semantic palettes across native and web | None currently planned |
| PDF job | Durable import, typed input request, filled-copy preview, reviewed reply, receipt | OCR/scanned forms and additional PDF field types |
| Generated results | Plans/reports/comparisons, finance CSV metrics, and scripts in the private Linux workspace | Managed tool installation/versioning and image/audio generation |
| Notifications | Durable in-app inbox, source-linked change alerts, restart reconciliation | APNs/FCM/device push delivery |
| Connectors | Searchable catalogue, encrypted credentials, health checks and agent reads for GitHub/Tailscale/Headscale/WireGuard/Proxmox; Proxmox node storage/content and guest/snapshot/job management, plus 16 reviewed write operations in the UI and conversation/delegated Pi tools | Plaid, health, Instagram, WhatsApp and partner APIs; writes for other infrastructure providers and team Pi roles |
| OpenBot | Disabled adapter with pinned protocol/identity tests | Live session bridge, routines and computer backend wiring |

The Linux computer is disabled until configured on the server and has no network access. It is a single-owner container with a persistent `/workspace`, separate from the browser worker; see [computer setup and limits](COMPUTER.md). It is not a graphical desktop or a full OS VM.

The implementation and validation details are in [VERIFICATION.md](VERIFICATION.md). Planned extensions are not claims of current support. Priorities are tracked in the [roadmap](../ROADMAP.md).
