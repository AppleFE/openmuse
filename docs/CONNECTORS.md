# Connectors

Connectors are owner-scoped integrations with external
infrastructure providers: GitHub, Tailscale, Headscale, WireGuard and Proxmox
VE. They are managed through a small JSON API, store credentials encrypted at
rest, and expose their operations to the agent as tools. Proxmox also supports
changes through the existing persisted action review; other providers remain read-only.

| Provider   | Operations                              | Credentials                       |
| ---------- | --------------------------------------- | --------------------------------- |
| `github`   | `repos`, `issues`, `pulls`              | `token` (PAT)                     |
| `tailscale`| `devices`                               | `apiKey`                          |
| `headscale`| `devices`                               | `apiKey`                          |
| `wireguard`| `status`                                | none (local `wg` binary)          |
| `proxmox`  | 18 reads and 16 reviewed writes (below) | `tokenId`, `tokenSecret` (API token) |

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
GET    /api/connectors/:id/operations     read/write metadata and parameter JSON schemas
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
- **Separate reads and writes.** The query route only permits reads. Proxmox
  POST/PUT/DELETE operations run through `/api/actions` and the native review
  workflow. Provider 401/403 responses report authentication or missing permissions.
- **Reviewed target binding.** Proxmox reviews bind the connector ID, URL, TLS
  config and encrypted credentials. Existing guest and storage-config targets
  also bind the provider configuration digest; changed targets fail before dispatch.
  Config updates send that digest to Proxmox for its own concurrency check.
  Atomic action claiming permits one dispatch per review. A lost connection
  after dispatch records `outcome_unknown`, without automatically repeating the write.
- **Owner isolation.** All records live under the session owner; other users
  cannot see or exercise a connection.
- **Proxmox TLS.** `verifyTls: false` or a custom PEM `ca` supports self-signed
  lab endpoints; verification stays on by default.
  For the default Proxmox cluster certificate, read the public CA on the
  Proxmox host with `cat /etc/pve/pve-root-ca.pem` and paste its complete PEM
  contents into **CA 인증서(PEM)** in the connection editor. Keep **TLS 인증서
  검증** enabled. This trusts only this connection's CA; hostname and validity
  checks still apply. CA certificates are separate from API token secrets.
  Obtain the CA through a trusted server console or authenticated SSH, rather
  than trusting an unauthenticated certificate download automatically. See
  [Proxmox certificate management](https://pve.proxmox.com/wiki/Certificate_Management).
  The connection test requests both `/version` and authenticated `/nodes`, so
  a publicly readable version endpoint cannot conceal a rejected API token.
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
exports read tools for the model runtime, plus `connectorInstructions`:

- `list_connectors` — redacted connection list
- `test_connector` — `{ connectorId }` live check
- `query_connector` — `{ connectorId, operation, params }` read
- `connector_operations` — `{ connectorId }` operation and parameter discovery

Conversation and delegated-task runtimes also register `prepare_connector_action`
and `connector_action_status`. Preparing a write creates an exact persisted review;
the model has no approve/execute tool. Delegated tasks wait for native approval,
then resume with the stored receipt. Team Pi roles currently expose read tools only.

## Proxmox management

Open **앱 → 연결된 Proxmox → 관리**. Each connection has its own node selection,
storage capacity/contents, VM/LXC controls and settings/snapshots, and job logs.
**전체 작업** exposes all supported operations with metadata-driven forms.
Identical node names in different clusters remain isolated by connector ID.

| Reads | Parameters |
| --- | --- |
| `nodes`, `vms`, `containers`, `resources` | Optional node; resources can filter type |
| `node_status`, `node_network`, `node_disks` | Node |
| `storages` | Optional node and content filter; omitted node aggregates online nodes with per-node errors |
| `storage_config` | Optional storage ID |
| `storage_status`, `storage_content` | Node, storage ID; content filter optional |
| `guest_status`, `guest_config`, `snapshots` | Node, kind (`qemu`/`lxc`), VMID |
| `tasks` | Node, optional VMID, start/limit and source |
| `task_status`, `task_log` | Node, raw provider UPID; log supports start/limit |
| `next_id` | No parameters |

Reviewed writes: `guest_power` (start/shutdown/reboot/stop/suspend/resume),
`guest_config_update`, `guest_create`, `guest_clone`, `guest_migrate`, `guest_delete`,
`snapshot_create`, `snapshot_delete`, `snapshot_rollback`, `backup`, `restore`,
`storage_config_update`, `storage_content_delete`, `storage_download`,
`storage_create` (dir/lvmthin/zfspool/nfs), and `storage_delete` (remove configuration).
Guest settings support common CPU/memory/boot/disk/network fields; arbitrary
host QEMU arguments, hooks, and password settings are excluded. Backups preserve
existing archives; URL downloads verify upstream TLS and optionally SHA-256.

For example, prepare a start request, review its returned hash, and approve through
the app's existing action route:

```json
{
  "kind": "connector.write",
  "data": {
    "connectorId": "<connection-id>",
    "operation": "guest_power",
    "params": { "node": "pve1", "kind": "qemu", "vmid": 100, "action": "start" }
  }
}
```

`POST /api/actions` creates the review. `POST /api/actions/:id/decide` accepts
`{ "hash": "<review-hash>", "decision": "approve" }` from the authenticated app.
A successful dispatch with a UPID means **submitted**, not finished. Query
`task_status`; only `status: "stopped"` and `exitstatus: "OK"` confirms job success.
The review screen can fetch that status and its log. Synchronous null receipts
are reported as completed. Never blindly retry an uncertain result.

The provider token must have the underlying endpoint's privileges. Typical
reads require `Datastore.Audit`/`VM.Audit`/`Sys.Audit`; changes need corresponding
`VM.PowerMgmt`, `VM.Config.*`, `VM.Allocate`, `VM.Clone`, `VM.Migrate`, `VM.Backup`
or `Datastore.Allocate*` privileges. Privilege-separated tokens are restricted
by both user and token ACLs. Operation support does not bypass Proxmox ACLs.
Contracts were checked against the deployed Proxmox 9.2.2 API viewer schema;
the complete per-endpoint rules are in the
[official API viewer](https://pve.proxmox.com/pve-docs/api-viewer/).

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
`tests/proxmox-management.test.ts` covers storage/config/job reads, all reviewed
write mappings and form encoding, native review/owner/version/duplicate guards,
uncertain transport outcomes, and real embedded Pi pause/resume with job verification.
