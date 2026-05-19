# Free verification matrix

Free has three user-visible surfaces that must stay aligned:

- Native ACP bridge and host runtime.
- Relay/API Worker on port `8791` locally or `free-relay.saaskit.app` online.
- Workbench Web product surface on port `8790` locally or `free.saaskit.app` online.

The matrix below defines which command proves which layer. Keep new verification
paths in this file and expose stable make targets instead of leaving one-off
commands in issue threads or local notes.

| Target | Command | Proves |
| --- | --- | --- |
| Core implementation | `make verify-core` | Free TypeScript build, relay typecheck, Workbench typecheck, and unit tests. |
| Package install path | `make verify` | Core implementation plus npm pack/install smoke, source installer smoke, and relay deploy dry run. |
| Local relay path | `make verify-relay-local` | Local Wrangler relay on `127.0.0.1:8791` and relay HTTP E2E. |
| Local full path | `make verify-local` | `make verify` plus local relay E2E. |
| Binary path | `make verify-binary` | Bun compiled binary starts and exposes core CLI help/config commands. |
| Hosted relay path | `make verify-prod-smoke` | Current online relay/API smoke test. |

## Manual product checks

Automated checks are not enough for changes that affect Workbench UI, GitHub
OAuth, Zed launch, host lifecycle, session continuity, or runtime recovery.
Those changes also need a real-chain check against the affected product surface:

- Workbench UI: run Workbench on `8790`, relay on `8791`, and verify in Chrome
  Canary across desktop and narrow widths.
- Zed ACP bridge: rebuild the actual installed `free` binary or `dist`, launch
  through Zed, and confirm `~/Library/Logs/Zed/Zed.log` plus Free bridge/host
  logs show the expected route.
- Host lifecycle: verify the launchd service and the relay `/api/hosts` view,
  not only the local CLI process status.
- Session recovery: prove whether the original ACP session, runtime service, and
  relay request state were recovered or explicitly failed.

## Scope rule

Do not treat generic HTTP tunnel behavior as proof of Free behavior. Free's
critical unit is an ACP session or turn, not a raw HTTP/WebSocket stream.
