# Relay Invariants

Free relay makes a remote host behave like a local ACP agent. These invariants
are the boundaries that must remain true when refactoring the relay internals.

## Trust Boundaries

- Relay memory is cache. It can restore routing state, pending frames, and
  reconnect windows, but it is not the authorization root.
- `AccountSession` identifies the account and principal. Relay verifies it for
  account-scoped HTTP and WebSocket routing.
- `ConnectionProof` is the bridge-to-host runtime authorization boundary. Relay
  verifies it before routing, and the host verifies it again before serving ACP.
- D1 is the control plane for accounts, hosts, grants, OAuth state, login
  approvals, and session bindings.
- Durable Object storage is only reconnect state for an account shard.

## Connection Lifecycle

- A transient client disconnect may keep relay state open during the reconnect
  grace window.
- A final ACP client close must close the route and notify the host. It must not
  enter the reconnectable replay path.
- A host disconnect may keep authorized client routes pending during the host
  reconnect grace window.
- Host reconnect reopens previously authorized routes with a fresh `Hello`; it
  does not mint a new runtime credential.
- Replacing a client or host socket should close the previous socket with a
  replacement close reason and keep the newest socket authoritative.

## Replay And Ordering

- Relay may replay pending frames only through the ack/replay rules. It must not
  unconditionally resend arbitrary historical frames.
- Native ACP client acknowledgements are emitted only after the bridge has
  accepted the corresponding relay response or notification.
- Duplicate host frames after reconnect must be suppressed when they correspond
  to already completed or replayed client-visible results.
- Session control requests must preserve deterministic replay order across host
  restart and reconnect.

## User Surface

- Users should experience `Connecting`, `Reconnecting`, `Restoring session`,
  `Ready`, or `Needs authorization`.
- Relay implementation identifiers such as ticket, grant, connection id,
  host id, and reconnect grace remain internal unless the user is debugging.
- The editor-facing bridge continues to speak native ACP over stdio.

## Refactor Rules

- Keep Cloudflare Worker and Durable Object event handling thin.
- Keep ACP relay protocol state in testable TypeScript modules, not in route
  handlers or HTML/login code.
- Snapshot and WebSocket attachment formats must stay versioned and validated.
- New persistence must declare whether it belongs to D1 control-plane state or
  Durable Object reconnect cache.
