# Free

Free owns the remote ACP product surface: relay worker, native ACP bridge,
machine host, account authorization, and remote operational tooling.

`@saaskit-dev/acp-runtime` remains the local SDK dependency. Free should import
only the public runtime API from that package.

## Local Commands

- `make help` lists the maintained command surface.
- `make build` builds the local `acp-runtime` dependency and then Free.
- `make test` runs Free unit tests.
- `make relay-dev` starts the Cloudflare relay worker locally.
- `make relay-deploy` deploys the production relay worker.

## CLI

The package exposes `free`:

- `free auth login`
- `free auth status`
- `free host install`
- `free host status`
- `free bridge run`
