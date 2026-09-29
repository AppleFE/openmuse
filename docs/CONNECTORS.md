# Connectors

Connectors are owner-scoped, read-only integrations with external
infrastructure providers: GitHub, Tailscale, Headscale, WireGuard and Proxmox
VE. They are managed through a small JSON API, store credentials encrypted at
rest, and expose their read operations to the agent as tools.

| Provider   | Operations                              | Credentials                       |
| ---------- | --------------------------------------- | --------------------------------- |
| `github`   | `repos`, `issues`, `pulls`              | `token` (PAT)                     |
| `tailscale`| `devices`                               | `apiKey`                          |
| `headscale`| `devices`                               | `apiKey`                          |
| `wireguard`| `status`                                | none (local `wg` binary)          |
| `proxmox`  | `nodes`, `vms`, `containers`, `resources` | `tokenId`, `tokenSecret` (API token) |

Multiple connections per provider are supported — for example several Proxmox
clusters or GitHub Enterprise instances, each with its own credentials.

## Management API

Mounted by the server under `/api/connectors`; every route requires the session
Bearer token like the rest of `/api/*`. All responses are redacted views —
secrets are write-only and never returned.

```
GET    /api/connectors/providers          static provider contract (config/secret fields, operations)
GET    /api/connectors                    list connections for the owner
POST   /api/connectors                    create  { provider, name, config, secrets? }  → 201
GET    /api/connectors/:id                one connection view
PATCH  /api/connectors/:id                update { name?, config?, secrets? }  (secrets:null clears)
DELETE /api/connectors/:id                remove connection and its secrets
POST   /api/connectors/:id/test           live credential check → { ok, detail, checkedAt }
POST   /api/connectors/:id/query          run a read operation { operation, params } → { data }
```

### Create payloads

```jsonc
// GitHub
{ "provider": "github", "name": "Work",
  "config": { "baseUrl": "https://api.github.com" },          // optional; set for GHES
  "secrets": { "token": "github_pat_…" } }

// Tailscale
{ "provider": "tailscale", "name": "Tailnet",
  "config": { "tailnet": "example.com" },                     // or "-" for the key's default
  "secrets": { "apiKey": "tskey-api-…" } }

// Headscale
{ "provider": "headscale", "name": "Self-hosted",
  "config": { "baseUrl": "https://headscale.example.com" },
  "secrets": { "apiKey": "…" } }                              // `headscale apikeys create`
// URL fields reject embedded userinfo — credentials belong in `secrets`.

// WireGuard (no secrets; runs the local wg binary)
{ "provider": "wireguard", "name": "Host VPN",
  "config": { "interface": "wg0", "wgPath": "/usr/bin/wg" } } // both optional

// Proxmox VE
{ "provider": "proxmox", "name": "Cluster A",
  "config": { "baseUrl": "https://pve.example.com:8006",
              "verifyTls": true, "ca": "<PEM, optional>" },
  "secrets": { "tokenId": "monitoring@pve!openmuse", "tokenSecret": "<uuid>" } }
```

`POST /:id/test` performs a live read (`/user`, device list, `wg show`,
`/version`) and persists the result on the connection as `check`.

### Query operations

`POST /:id/query` with `{ "operation": string, "params": {} }`:

- `github` — `repos` (token-visible repositories, updated first),
  `issues`/`pulls` with `params.repo` `"owner/name"`, optional `state`
  (`open`|`closed`|`all`) and `limit` (1–100, default 30). Issues returned by
  GitHub that are actually pull requests are filtered out.
- `tailscale` — `devices` lists tailnet devices (`fields=all`).
- `headscale` — `devices` lists nodes; falls back to the legacy
  `/api/v1/machine` endpoint when `/api/v1/node` is not found (Headscale ≤ 0.22).
- `wireguard` — `status` runs `wg show <iface|all> dump` and returns interfaces
  and peers. **Private keys and preshared keys are parsed out and never
  returned.**
- `proxmox` — `nodes` lists cluster nodes; `vms`/`containers` list QEMU/LXC
  guests cluster-wide (`params.node` limits to one node); `resources` lists
  `/cluster/resources` with optional `params.type` (`vm`|`node`|`storage`|
  `sdn`|`pool`).

Unknown operations return `422`; provider failures surface as `502` with the
upstream detail redacted.

## Security invariants

- **Encrypted at rest.** Secrets are stored AES-256-GCM encrypted
  (`packages/integrations/src/vault.ts`) under `TOKEN_ENCRYPTION_KEY`; in sample
  mode a random key is generated in the data directory like the session signing
  key. Records hold only the `v1.…` envelope.
- **Redaction.** Every provider error message is scrubbed of stored secret
  values (raw and URL-encoded) before it reaches a response, log or check
  record. API views contain `hasSecret`, never secret material.
- **No shell for WireGuard.** The adapter shells nothing: it invokes the local
  `wg` executable with a fixed argv (`show all dump`, or `show <iface> dump`
  with a schema-validated interface name) via `execFile`.
- **Timeouts & caps.** Provider calls use a 15s timeout (configurable via
  service deps) and a 4 MB response cap.
- **Read-only.** Adapters only issue GETs (or the `wg` read command); there are
  no write paths. Provider 401/403 responses map to a credentials error.
- **Owner isolation.** All records live under the session owner; other users
  cannot see or exercise a connection.
- **Proxmox TLS.** `verifyTls: false` or a custom PEM `ca` supports self-signed
  lab endpoints; verification stays on by default.
- **No credentials in URLs.** URL config fields reject embedded
  `user:password@` userinfo at validation; any such record written before this
  invariant is still stripped in views.
- **Checks are credential-bound.** A `test` result only persists while the
  config and secrets that produced it are still stored; editing either clears
  a stale check, and a concurrent result cannot overwrite the edit.
- **Cancellation aborts I/O.** Caller abort signals (request disconnect, task
  cancellation, pi timeout) propagate into provider HTTP requests and the `wg`
  child process.

## Agent tools

`connectorTools(service, owner)` in `apps/server/src/connector-tools.ts`
exports three tools for the model runtime, plus `connectorInstructions`:

- `list_connectors` — redacted connection list
- `test_connector` — `{ connectorId }` live check
- `query_connector` — `{ connectorId, operation, params }` read

`connectorRoutes(service)` mounts the management API and
`service.connections(owner)` returns `Connection`-shaped entries
(`connector:<id>`) for the workspace snapshot.

## Storage

Connections persist in the `records` table under kind `connectors`, one row per
connection, keyed by `(owner, id)` — so PGlite and Postgres behave identically.

## Official API references

- GitHub REST API: https://docs.github.com/en/rest (`/user`, `/user/repos`,
  `/repos/{owner}/{repo}/issues`, `/repos/{owner}/{repo}/pulls`; headers
  `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`)
- Tailscale API: https://github.com/tailscale/tailscale/blob/main/api.md
  (`GET /api/v2/tailnet/{tailnet}/devices`, Bearer API key)
- Headscale API: https://github.com/juanfont/headscale/blob/main/docs/ref/api.md
  (`GET /api/v1/node`, Bearer API key; legacy `/api/v1/machine` fallback)
- WireGuard `wg(8)`: https://git.zx2c4.com/wireguard-tools/about/src/man/wg.8
  (`wg show all dump` tab-separated output)
- Proxmox VE API: https://pve.proxmox.com/wiki/Proxmox_VE_API
  (`Authorization: PVEAPIToken=USER@REALM!TOKENID=UUID`, `/api2/json/version`,
  `/api2/json/nodes`, `/api2/json/cluster/resources`)

## Testing

`tests/connectors.test.ts` covers adapter contracts against local mock
providers (auth headers, response mapping, malformed JSON, timeouts, secret
redaction, the Headscale legacy fallback and `wg` argv).
`tests/connectors-api.test.ts` covers the authenticated CRUD/test/query
routes, encrypted storage, owner isolation, embedded-URL credential rejection,
stale-check fencing, abort propagation, field-type metadata, and multiple
simultaneous Proxmox connections.
