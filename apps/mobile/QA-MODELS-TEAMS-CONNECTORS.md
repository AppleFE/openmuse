# Mobile integration QA

Validated on 2026-09-29 against an isolated sample server and the Expo web app. The test data directory was `%TEMP%\openmuse-mobile-qa`; the fake Rich Threads key intentionally produced 401 responses only on Intelligence-backed paths and did not affect the settings or task APIs exercised here.

## Browser coverage

- Desktop, light: opened Apps, verified the server model catalog and connection cards, then created `QA Build Team`.
- Desktop, dark: changed Appearance to Dark, reopened Apps, inspected the team editor, and created/tested `QA WireGuard`. The expected local permission/tool error rendered as an in-product connector error without exposing credentials.
- Desktop, light again: changed Appearance to Light and confirmed the full shell, cards, sheets, fields, labels, and navigation returned to light semantic colors.
- Phone viewport, light and dark: repeated the Apps/settings flow and confirmed the model/team/connector controls wrap and scroll without clipping.

Screenshots from that run are in the local system temporary directory:

- `%TEMP%\openmuse-light-apps.png`
- `%TEMP%\openmuse-dark-apps.png`
- `%TEMP%\openmuse-dark-team.png`
- `%TEMP%\openmuse-dark-connector.png`
- `%TEMP%\openmuse-phone-light.png`
- `%TEMP%\openmuse-phone-dark.png`

## Reproduction

1. Start the server with sample auth plus at least two enabled entries in `OPENMUSE_MODELS`, then start the Expo web app with `EXPO_PUBLIC_API_URL` pointing at that server.
2. Open **Apps & settings**. Under **Appearance**, select System, Light, and Dark and verify the preference survives a reload.
3. Under **Models**, choose an enabled model. Create a model team, edit each planner/coder/reviewer model and system prompt, change Sequential/Parallel, save it, and launch a team task.
4. Open the launched task. Verify role progress and durable thread messages show the configured speaker label and model ID.
5. Add two Proxmox connections to confirm entries are not provider-singletons. For each connector type, create, edit, test, and remove an entry; verify configured credentials are represented only by status and are never filled back into an input.
6. At a narrow phone viewport, repeat steps 2-5 and verify sheets remain scrollable and actions remain reachable.

## Focused contract audit

- The mobile request paths and methods match the current authenticated APIs: `/api/agent/models`, `/api/agent/model-settings`, `/api/agent/teams`, `/api/agent/tasks`, and `/api/connectors` with provider/list/create/update/delete/test operations.
- A server selection of `{ modelId: null }` is not represented faithfully by the current client: `chooseAvailableModel` falls back to the first enabled model, and there is no explicit "no default" control. This should be resolved only if `null` remains a user-facing server state in the runtime contract.
- Connector configuration currently treats `verifyTls` as the only boolean field by name because provider metadata does not publish field types. New runtime settings should publish explicit types, bounds, defaults, and editability so the client does not infer behavior from field names.
- Backend findings affecting the UI were handed to the owning worker: credential-bearing connector base URLs can be returned in public config, concurrent connector edits can receive a stale test result, and connector tool cancellation does not currently abort provider I/O.

## Automated checks from the completed frontend milestone

- 20 mobile tests passed.
- TypeScript typecheck passed.
- Expo web, Android, and iOS exports completed.

## Jev and pi runtime settings follow-up

Validated on 2026-09-29 against an isolated sample server at `localhost:8787` and Expo web at `localhost:8082` after the authenticated runtime contract landed.

- `GET /api/agent/runtime-settings` populated the Jev and pi status, policy, and numeric controls without returning credential material.
- The rendered form changed pi from 4 to 5 maximum iterations and Jev from `local-budget` to `closed`; Save issued the PATCH and a separate GET confirmed both persisted values.
- Client validation mirrors the shared contract: Jev timeout 1000-30000 ms, pi iterations 1-8, and pi timeout 5000-900000 ms.
- Desktop light and dark captures show readable nested surfaces, secure credential input, status labels, policy buttons, numeric controls, and a reachable save action.
- A 390x844 mobile emulation exposed every runtime input/action in the accessibility tree and kept the settings vertically scrollable without horizontal clipping.

Runtime QA captures are in the local system temporary directory:

- `%TEMP%\openmuse-runtime-dark.png`
- `%TEMP%\openmuse-runtime-light.png`
- `%TEMP%\openmuse-runtime-phone-light.png`
