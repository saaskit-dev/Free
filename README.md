# Free

Free makes a remote machine available to an ACP-capable editor as if it were a
local ACP agent. It owns the product surface around the relay Worker, native ACP
bridge, machine host, account authorization, and remote operational tooling.

`@saaskit-dev/acp-runtime` remains the local SDK dependency. Free should import
only the public runtime API from that package; relay, bridge, host, daemon, and
Worker behavior belong in this repository.

## Install

Install the latest CLI from source:

```sh
curl -fsSL https://raw.githubusercontent.com/saaskit-dev/Free/main/scripts/install.sh | bash
```

The installer clones Free and `acp-runtime`, builds the required local packages,
packs Free, installs the resulting CLI globally with npm, then runs
`free auth login` by default.

Useful install flags:

- `--no-login` installs only the `free` CLI.
- `--no-host` logs in without installing the default user host.
- `--system` installs the macOS host as a boot-time system service after login.
- `--force-login` refreshes browser login and reinstalls the active host mode.
- `--relay-url <ws-url>` uses a non-default relay.
- `--ref <git-ref>` installs a specific Free branch, tag, or commit.

For a local checkout:

```sh
./scripts/install.sh
```

## CLI

The installed package exposes `free`:

```sh
free auth login
free auth status
free auth logout
free host install
free host status
free host restart
free host run
free bridge run
free bridge config
```

The normal user flow is:

1. Run `free auth login` on each machine that should host agents.
2. Keep `free host run` or the installed host service running on those machines.
3. Configure the editor ACP client to launch `free bridge run`.

Hosts are registered in the relay control plane. Offline hosts can still appear
in discovery using their last known metadata, but only currently connected hosts
are selectable for a new route.

## Architecture

The user-facing path is:

```text
Editor ACP client -> free bridge run -> Relay Worker -> free host run -> acp-runtime -> Agent
```

The relay control plane stores account, client, host, grant, session binding,
and last-known host metadata in D1. Relay memory is limited to live transport
state such as active WebSocket routes, heartbeats, reconnect windows, pending
frames, and in-flight waiters.

See `docs/remote-acp.md` and `docs/relay-invariants.md` for the detailed relay
and trust-boundary rules.

## Development

Use the maintained make targets:

```sh
make help
make install
make build
make test
make verify
```

Common relay commands:

```sh
make relay-dev
make relay-deploy-dry-run
make relay-migrate-remote
make relay-deploy
make remote-prod-smoke
```

`make build` builds the local `../acp-runtime` dependency and then Free.
`make verify` runs typecheck, tests, package creation, install smoke, and relay
deploy dry-run.

## Cloudflare Deployment

Free separates the public product surface from the relay/API surface.

- Workbench Web: the product UI. Deploy the Expo Web export to Cloudflare Pages,
  for example `https://free.saaskit.app`.
- Relay/API: the Worker that owns WebSocket ACP, API, OAuth exchange, D1, and
  Durable Object state. Deploy it to a separate Worker domain, for example
  `https://free-relay.saaskit.app`.

Deploy the relay Worker:

```sh
make relay-migrate-remote
make relay-deploy
```

`make relay-deploy` deploys the Worker custom domain
`free-relay.saaskit.app` by default. Override `RELAY_DOMAIN` only for a custom
relay deployment.

Set these Worker secrets before using GitHub OAuth online:

```sh
pnpm --dir relay exec wrangler secret put ACP_RELAY_GITHUB_CLIENT_SECRET
pnpm --dir relay exec wrangler secret put ACP_RELAY_ACCOUNT_SESSION_PRIVATE_KEY
```

Set these Worker variables in `relay/wrangler.jsonc` or the Cloudflare dashboard:

```text
ACP_RELAY_GITHUB_CLIENT_ID
ACP_RELAY_ACCOUNT_SESSION_KEY_ID
ACP_RELAY_ACCOUNT_SESSION_PUBLIC_KEYS
ACP_RELAY_WORKBENCH_ORIGIN=https://free.saaskit.app
```

Deploy Workbench Web after setting the public origins:

```sh
EXPO_PUBLIC_RELAY_URL=https://free-relay.saaskit.app \
EXPO_PUBLIC_WORKBENCH_ORIGIN=https://free.saaskit.app \
WORKBENCH_PAGES_PROJECT=free-app \
make workbench-deploy
```

GitHub OAuth callback URLs should belong to Workbench, not the relay Worker:

```text
https://free.saaskit.app/login/callback
http://127.0.0.1:8790/login/callback
```

The relay still handles the OAuth token exchange through `/api/login/callback`,
but the visible callback, approval, error, and completion surfaces stay on
Workbench.

## Relay Environments

The default bridge, auth, and host environment is online:

```sh
free bridge config
free bridge run
free auth login
free host run
```

Use the local environment when testing against `make relay-dev` on port `8791`
and Workbench Web on port `8790`:

```sh
free bridge config --relay-env local
free bridge run --relay-env local
free auth login --relay-env local
free host run --relay-env local
```

`--relay-url <ws-url>` remains available for custom relay deployments, but it
should not be mixed with `--relay-env`.
