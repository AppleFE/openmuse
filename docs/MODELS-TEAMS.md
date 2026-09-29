# Models, OpenCodex, and multi-model teams

OpenMuse keeps provider credentials on the server while letting each user select from an explicit model allowlist. A selected model affects both new chat runs and new durable tasks; changing the default does not rewrite a task or team run already in progress.

## Configure models

`OPENMUSE_MODELS` is a JSON array of public, secret-free profiles. Each `id` is a stable app/API value and each `model` is an execution adapter string:

```dotenv
AGENT_BACKEND=model
OPENMUSE_MODELS=[{"id":"fast","label":"Fast","model":"openai/gpt-example","capabilities":["chat","tools"],"enabled":true},{"id":"review","label":"Review","model":"anthropic/claude-example","capabilities":["chat","coding"],"enabled":true}]
OPENAI_API_KEY=server-only
ANTHROPIC_API_KEY=server-only
```

Supported providers are `openai`, `anthropic`, `google`, and `opencodex`. The older `MODEL=provider/model` setting remains a backward-compatible one-profile catalog with ID `default`. Duplicate IDs, unsupported providers, and malformed catalogs stop server configuration rather than silently accepting an unusable override.

The API never returns credentials:

- `GET /api/agent/models` returns the configured `ModelProfile[]`.
- `GET /api/agent/model-settings` returns the saved default.
- `PUT`, `POST`, or `PATCH /api/agent/model-settings` with `{ "modelId": "fast" }` changes the default. `null` clears it.
- Unknown or disabled model IDs return HTTP 422.
- `POST /api/agent/tasks` accepts either `modelId` or `teamId`, not both. The resolved model or team revision is copied into the task before it is queued.
- A CopilotKit run may carry `forwardedProps.modelId`; the server checks the same allowlist and uses that model for the actual adapter invocation. Without it, the saved default is resolved once when the run starts.

Provider SDK retries remain bounded by `MODEL_MAX_RETRIES`; task leases, cancellation, action review, and idempotency boundaries are unchanged.

## OpenCodex

OpenMuse talks to OpenCodex through its native OpenAI Responses-compatible data plane. Configure a base URL ending in `/v1`, a data-plane admission key, and one or more routed public model IDs:

```dotenv
AGENT_BACKEND=model
OPENCODEX_BASE_URL=http://127.0.0.1:8788/v1
OPENCODEX_API_KEY=server-only-data-key
OPENMUSE_MODELS=[{"id":"ocx-coder","label":"OpenCodex coder","model":"opencodex/my-provider/my-model","capabilities":["chat","tools","coding"],"enabled":true}]
```

Use either `opencodex/<routed-model-id>` or `opencodex:<routed-model-id>`; the portion after the first separator is sent unchanged as the OpenCodex `model`. The key is sent as a Bearer credential only to the configured base URL. Embedded credentials and non-HTTP(S) base URLs are rejected.

OpenCodex documents `POST /v1/responses` as its native data-plane request and `GET /v1/models` as discovery. OpenMuse deliberately does not call the management API or accept a management/provider key through its client API. See the official [Proxy API Formats](https://opencodex.me/reference/proxy-formats/), [Adapters](https://opencodex.me/reference/adapters/), and [Management API](https://opencodex.me/reference/management-api/) references.

## Teams and role DAGs

Team definitions are owner-scoped durable records:

```json
{
  "name": "Delivery team",
  "execution": "parallel",
  "roles": [
    {
      "id": "planner",
      "label": "Planner",
      "kind": "planner",
      "modelId": "review",
      "systemPrompt": "Produce an implementation plan.",
      "dependsOn": []
    },
    {
      "id": "coder",
      "label": "Coder",
      "kind": "coder",
      "modelId": "fast",
      "systemPrompt": "Implement the approved plan.",
      "dependsOn": ["planner"]
    },
    {
      "id": "reviewer",
      "label": "Reviewer",
      "kind": "reviewer",
      "modelId": "review",
      "systemPrompt": "Review the implementation and tests.",
      "dependsOn": ["coder"]
    }
  ]
}
```

Use `GET/POST /api/agent/teams` and `GET/PATCH/DELETE /api/agent/teams/:id`. Role IDs must be unique, every dependency must exist, cycles are rejected, and every role model must be enabled. `parallel` runs every currently-ready DAG frontier concurrently; `sequential` runs the same ready frontier one role at a time in declaration order. A dependent role becomes ready only after all predecessors have durable `succeeded` checkpoints.

Each task snapshots the full role definition and team revision. Per-role status, attempts, output, error, and the dependency-ordered `sharedContext` are stored with the task. Completed branches are never rerun after restart. Interrupted branches return to pending, failed dependencies cancel only their downstream roles, and retry preserves succeeded outputs while reopening failed/cancelled roles. Cancelling the task cancels pending/running roles and keeps completed history.

`GET /api/agent/tasks/:id` returns role-labelled `events` and `messages` in addition to task artifacts. These records survive server restart and are intended for the same task thread UI, not hidden diagnostics.

## Coding runtime handoff

The core role engine calls `RuntimeHookPipeline` before its default model executor. A real coding runtime can claim a role through `CodingRuntimeHook.execute`, with `guard` and `prepare` owning its permission checks and context. Only one runtime may claim a role. This is the injection point reserved for embedded pi and Jev; this release does not pretend those integrations exist, and model-only coder roles must not claim they used coding tools.
