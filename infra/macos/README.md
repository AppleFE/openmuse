# macOS production deployment

This directory supports a single-owner OpenMuse installation on Apple silicon with its source,
runtime, data, caches, browser profiles, and logs on `/Volumes/p41-1tb`. It does not install Node,
change Tailscale, touch unrelated launchd jobs, or contain credentials.

## Runtime layout

| Path | Purpose |
| --- | --- |
| `/Volumes/p41-1tb/openmuse/repo` | Git checkout or verified bundle extraction |
| `/Volumes/p41-1tb/openmuse/runtime/node-v24…-darwin-arm64` | Externally verified official Node 24 archive |
| `/Volumes/p41-1tb/openmuse/runtime/node-current` | Symlink selected by `deploy.sh` |
| `/Volumes/p41-1tb/openmuse/data/app` | PGlite database, documents, signing key, and pi sessions |
| `/Volumes/p41-1tb/openmuse/data/browser-profiles` | Persistent Chromium state and downloads |
| `/Volumes/p41-1tb/openmuse/caches` | pnpm store and Playwright Chromium |
| `/Volumes/p41-1tb/openmuse/logs` | launchd stdout/stderr |

The API listens only on `127.0.0.1:8787` and starts the task worker in that same process. Do not
start `start:worker` or set `DATABASE_URL`: a second process cannot open the embedded PGlite store.
The browser worker listens only on `127.0.0.1:8790`. The small Node web service serves the Expo
export and proxies every `/api` request to the loopback API, preserving authorization, Origin,
streaming responses, signed query strings, and cancellation.

The web service may bind loopback plus the Mac's specific Tailnet address. It rejects wildcard
binds in deployment validation. It does not provide TLS or internet-edge hardening: use only the
encrypted Tailnet or an SSH tunnel, and do not alter an existing Tailscale Serve configuration.

## Required configuration

Copy `env.production.example` to the checkout's `.env`, keep it mode `600`, and replace the
placeholders. `validate-env.mjs` reports names and requirements only; it never prints values.

| Setting | Initial sample/model deployment | Live Gmail/Calendar deployment |
| --- | --- | --- |
| `CPK_INTELLIGENCE_API_KEY` | Required; there is no offline bypass | Required |
| `OPENMUSE_ACCESS_KEY` | Required here because the sample workspace is proxied; 24+ random characters | Required |
| `MODEL` or `OPENMUSE_MODELS` | Required with at least one enabled model | Required |
| Matching model credential | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, a supported Google key, or both OpenCodex settings | Same |
| `WORKER_TOKEN` | Required in API and browser worker; 32+ random characters | Same |
| `TOKEN_ENCRYPTION_KEY` | Not used | Required; exactly 32 random bytes encoded as base64 |
| Google OAuth client | Not used; fictional mail/calendar remain available | Required to connect Gmail/Calendar |

For Google, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, enable Gmail and Calendar APIs, and
register `${PUBLIC_API_URL}/api/google/callback` exactly. Start with `WORKSPACE_MODE=sample` and
`AGENT_BACKEND=model` until those live credentials are intentionally supplied.

`EXPO_PUBLIC_API_URL` is compiled into public JavaScript, so it must contain only the public
origin—never an owner, provider, CPK, worker, or Google credential. It must equal
`PUBLIC_API_URL`, and that origin must appear exactly in `ALLOWED_ORIGINS`. Changing any of these
three values requires rebuilding the web export with `deploy.sh`.

The normal sample mode is unauthenticated. This deployment configures `OPENMUSE_ACCESS_KEY`, which
now opts sample mode into the same owner-key session gate as live mode. The UI first tries the local
session, then presents its existing key form after the protected server rejects that attempt.

At the time this support was prepared, the target had no CPK or model-provider credential names.
That blocks only API launch, not credential-free dependency/build/browser/web preparation. The
validator reports each missing name as `API BLOCKED`; the scripts do not fabricate or bypass it.

## Install or update

1. Put the clean checkout at `/Volumes/p41-1tb/openmuse/repo`. Preserve the private `.env` across
   updates and verify that no secret is tracked with `git status --short --ignored`.
2. Unpack a verified official arm64 Node 24 archive below `openmuse/runtime`. This repository does
   not duplicate that supply-chain step.
3. On first install, run the command below with the actual unpacked directory. On later updates,
   `OPENMUSE_NODE_DIR` may be omitted because `node-current` already exists.

   ```sh
   cd /Volumes/p41-1tb/openmuse/repo
   OPENMUSE_NODE_DIR=/Volumes/p41-1tb/openmuse/runtime/node-v24.x.y-darwin-arm64 \
     ./infra/macos/deploy.sh
   ```

4. If the script created `.env`, populate the non-secret layout fields and locally generated owner
   and worker tokens, then rerun. Dependency installation and builds may proceed while external CPK
   or model credentials are pending, but the validator labels the API blocked.
5. Install or refresh only OpenMuse's three LaunchAgents:

   ```sh
   ./infra/macos/install-launch-agents.sh
   ```

`deploy.sh` uses the lockfile, the pinned package-manager version in `package.json`, the P41 pnpm
store, and the configured P41 Playwright cache. It builds the server, compiles the Expo web origin,
and installs matching Chromium. Package lifecycle/build commands receive only the one public Expo
origin or Playwright cache variable they need, not owner/provider/CPK credentials.
`install-launch-agents.sh` validates first, replaces only
`com.openmuse.server`, `com.openmuse.browser-worker`, and `com.openmuse.web`, and leaves all unrelated
services alone. When genuine CPK/model credentials are incomplete, it installs browser and web but
explicitly removes/omits the API LaunchAgent. After credentials arrive, rerun both scripts; full
validation then permits API installation. It never kills an arbitrary process merely because it
holds one of the expected ports. A separately managed `com.openmuse.colima` job remains ops-owned;
this installer neither replaces nor restarts it.

On this host, macOS privacy controls deny ordinary background launchd children access to the
removable P41 volume even though an interactive login can read it. The installer therefore creates
a dedicated localhost-only Ed25519 key and a forced-command entry that accepts exactly `server`,
`browser-worker`, or `web`. The LaunchAgents disable forwarding, PTYs, ambient identities, and permissive
host-key handling. The forced dispatcher uses an exact `case` statement (no `eval`) and redirects
service logs on P41. Existing unrelated `authorized_keys` entries are preserved. Remote Login must
be enabled, but the dedicated key is restricted to source address `127.0.0.1` and cannot open an
arbitrary shell.

These are per-user LaunchAgents: they start after `aeonge` logs in, not before login. That login
boundary is intentional because it is what grants the external-volume access used by the
localhost `sshd` child. A future system-daemon design would need a separately reviewed macOS
privacy entitlement rather than weakening this bridge.

The LaunchAgents use `PathState` for `/Volumes/p41-1tb`, and the runner independently waits at most
30 seconds for the expected mount. If the disk is absent, it exits without creating fallback data
on the system disk; launchd waits for the volume path instead of continuously respawning it.

## Verify

Check service state and loopback health without displaying configuration:

```sh
launchctl print gui/$(id -u)/com.openmuse.server
launchctl print gui/$(id -u)/com.openmuse.browser-worker
launchctl print gui/$(id -u)/com.openmuse.web
curl --fail http://127.0.0.1:8787/api/health
curl --fail http://127.0.0.1:8790/health
curl --fail http://127.0.0.1:8081/healthz
```

Then open `PUBLIC_API_URL`, enter the owner access key, and verify model chat plus a public-page
browser task. A browser worker `/health` response proves only the Node service is up; the real task
also verifies Chromium, token wiring, proxy streaming, and profiles on P41.

Run repository checks before shipping a support change:

```sh
pnpm test:macos-deploy
pnpm exec tsx --test tests/api.test.ts tests/config.test.ts
pnpm typecheck
```

Logs are under `/Volumes/p41-1tb/openmuse/logs`. Back up `data/app` and `data/browser-profiles` with
owner-only permissions; both may contain private content. Never attach `.env`, PGlite files,
browser profiles, pi sessions, or unredacted logs to an issue.

## Optional scoped computer

The initial deployment leaves `COMPUTER_ENABLED=false`. To enable the Linux workspace, first create
a dedicated Colima/Docker context, build `apps/computer` into that context, and set
`DOCKER_CONTEXT`, `COMPUTER_IMAGE`, and a stable `COMPUTER_DEPLOYMENT_ID` in `.env`. Validation
requires the explicit context when the feature is enabled, preventing accidental use of an
unrelated default Docker engine. Do not mount the host checkout, `.env`, or Docker socket into the
computer container beyond the application's documented Docker control boundary.

## Rollback and removal

Before a code rollback, stop only the three OpenMuse jobs, back up P41 data, switch the clean
checkout to the reviewed commit, rerun `deploy.sh`, and reinstall the LaunchAgents. Database
compatibility across arbitrary old commits is not guaranteed, so retain the backup.

To stop these jobs without deleting data:

```sh
for label in com.openmuse.server com.openmuse.browser-worker com.openmuse.web; do
  launchctl bootout "gui/$(id -u)/$label" || true
done
```

Removing plist files or P41 data is intentionally not automated.
