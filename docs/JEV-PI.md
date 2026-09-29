# Jev policy and embedded pi coding runtime

OpenMuse can run team `coder` roles through the official embedded Pi SDK and use TypeSafe.ai Jev as a constrained policy decision layer. Both features are owner-scoped and disabled by default. A normal model/team deployment behaves as before until an authenticated owner enables them.

The pinned integrations are `@typesafe-ai/sdk` 0.6.0 and `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` 0.87.1. Pi 0.87.1 requires Node 22.19 or newer; OpenMuse recommends Node 24 LTS.

## Setup

Set a provider key for every allowlisted coding model that Pi may run. OpenAI, Anthropic, and Google use their normal server environment variables. OpenCodex uses its data-plane key and a base URL ending in `/v1`:

```dotenv
OPENMUSE_MODELS=[{"id":"coder","label":"Coder","model":"openai/gpt-5.2-codex","capabilities":["chat","coding","tools"],"enabled":true}]
OPENAI_API_KEY=...

# Or an OpenCodex-routed model:
# OPENMUSE_MODELS=[{"id":"coder","label":"Coder","model":"opencodex/provider/coder","capabilities":["coding","tools"],"enabled":true}]
# OPENCODEX_BASE_URL=https://your-data-plane.example/v1
# OPENCODEX_API_KEY=...

TYPESAFE_API_KEY=...
TYPESAFE_DEFAULT_MODEL=jev-latest
# TYPESAFE_BASE_URL=https://api.typesafe.ai
```

`TYPESAFE_API_KEY` is optional when an owner saves a Jev key through the API. In live mode it is encrypted with `TOKEN_ENCRYPTION_KEY`; sample mode creates a private installation key under `DATA_DIR`. Keys are write-only and never appear in API responses. OpenMuse does not perform a speculative credential check when saving a key: the first real policy request validates it.

Use the authenticated agent API to read and update settings:

```http
GET /api/agent/runtime-settings

PATCH /api/agent/runtime-settings
Content-Type: application/json

{
  "jev": {
    "enabled": true,
    "apiKey": "...",
    "model": "jev-latest",
    "failMode": "closed",
    "timeoutMs": 10000
  },
  "pi": {
    "enabled": true,
    "maxIterations": 3,
    "timeoutMs": 300000
  }
}
```

The response is secret-free:

```json
{
  "id": "runtime",
  "jev": {
    "enabled": true,
    "configured": true,
    "model": "jev-latest",
    "failMode": "closed",
    "timeoutMs": 10000
  },
  "pi": { "enabled": true, "maxIterations": 3, "timeoutMs": 300000 },
  "updatedAt": "2026-09-29T00:00:00.000Z"
}
```

Send `{"jev":{"apiKey":null}}` to remove a saved owner override. An environment key remains configured and takes precedence over an owner override.

## Execution contract

For an enabled team run, the server applies these stages:

1. Jev decides `allow` or `block` before each role model operation. Low-confidence decisions (below 0.55) fail closed.
2. For a `coder` role, Jev chooses the smallest context profile: task only, bounded dependencies, or bounded full dependencies. Task context is capped at 6–12 KB and dependency context at 0–24 KB.
3. Pi receives the task-snapshotted, server-allowlisted model. It cannot choose a different model.
4. Pi runs with `noTools: "all"`, an empty resource loader, and custom OpenMuse tools only. Each tool call is separately checked by Jev.
5. When a Pi prompt settles, Jev decides `complete`, `continue`, or `block`. `continue` starts another bounded prompt in the same durable session; `block` fails the role.

The server caps owner settings at eight prompt-level iterations, 15 minutes, and 128 KiB of final output. A normal Pi run allows at most 32 OpenMuse tool calls; local fallback allows four. The isolated computer separately limits each command to 30 seconds and persists its receipt.

Jev receives bounded task text for the preflight decision, role/model metadata for context selection, completed Pi output for termination, and only tool name plus argument-key names for tool guards. Tool argument values, connector credentials, provider keys, and environment values are never sent to Jev by the runtime.

### Failure mode

`closed` is the default. Any Jev transport, timeout, authentication, or response failure stops the role; it is never treated as an allow decision.

`local-budget` is an explicit availability tradeoff. A Jev failure admits one Pi prompt with the minimal context profile, at most four isolated/read-only tool calls, and the configured timeout. The durable/user-visible result includes a runtime note saying the fallback was used. Caller cancellation is never converted into fallback.

## Isolation, approval, and cancellation

Pi's own documentation warns that a working directory is not a sandbox. OpenMuse therefore does not register Pi's host `bash`, `read`, `write`, or `edit` tools and does not load project extensions, skills, prompt templates, or context files. Its host `cwd` is an empty private directory under `DATA_DIR`.

Coding tools call the existing owner-scoped Docker computer. That container is non-root, has no host mounts or credentials, has networking disabled, and uses the existing path, lease, timeout, cancellation, idempotency, and receipt checks. Connector tools are read-only and use the existing encrypted connector service. Reviewed Gmail/Calendar writes are deliberately not exposed inside Pi: those operations must continue through OpenMuse's stored proposal and approval lifecycle.

The task abort signal is combined with Pi/tool cancellation. A cancelled or timed-out prompt calls `session.abort()`, while an isolated command receives the same signal. No new model/tool turn begins after cancellation.

## Persistence and recovery

Pi session JSONL is stored under `DATA_DIR/pi/sessions/<owner-hash>/<task>/<role>`. A secret-free checkpoint in the SQL store records the session path, last completed prompt iteration, tool-call count, output, and status. A process restart or explicit task retry resumes the interrupted role from that session and completed iteration. A succeeded checkpoint returns its stored output without rerunning tools.

Pi tool operation IDs include the task and role, so an exact retried computer command reuses the existing durable receipt. As with all agent automation, inspect workspace state after a command whose outcome is reported as interrupted or unknown.

## Current limits

- Embedded Pi currently claims multi-model team roles whose kind is `coder`; ordinary chat, standalone model tasks, and planner/reviewer roles keep their existing execution path.
- Jev's `choice` decisions are policy controls, not a proof that arbitrary generated code is safe. Docker isolation and the existing approval boundary remain authoritative.
- OpenCodex is configured as an OpenAI Responses-compatible Pi provider. The configured data plane must actually implement that protocol.
- No live TypeSafe.ai, model-provider, Docker, or connector credential was exercised by repository tests. Tests use the real SDK contracts with local transports/mocks and verify actual team-path invocation, persistence, retry, cancellation, and policy behavior.

## Official references

- TypeSafe.ai quickstart and System One API: <https://docs.typesafe.ai/introduction/quickstart>
- TypeSafe.ai JavaScript SDK: <https://docs.typesafe.ai/sdk/javascript>
- Official TypeSafe SDK source: <https://github.com/typesafe-ai/typesafe-sdk-js>
- Pi SDK: <https://pi.dev/docs/latest/sdk>
- Pi model configuration: <https://pi.dev/docs/latest/models>
- Pi provider authentication: <https://pi.dev/docs/latest/providers>
- Pi security boundary: <https://pi.dev/docs/latest/security>
- Official Pi source: <https://github.com/earendil-works/pi>
