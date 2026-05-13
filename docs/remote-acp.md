# Remote ACP

Free makes a remote host feel like a local ACP agent.

This document describes the current bridge compatibility layer. The bridge path
keeps external ACP clients working while Free builds its own Session Workbench
as the primary product client. The compatibility layer is an important current
implementation surface, but it is not the final product center.

The user-facing path has three moving parts:

- `free bridge run` speaks native ACP over stdio to the editor.
- The relay routes native ACP bytes and stores reconnect state.
- `free host run` verifies the bridge proof and serves the local runtime.

The Web UI should expose and harden the same bridge-era capabilities before it
fully replaces the external ACP client as the main interaction surface: host
discovery, session selection, authorization, runtime controls, reconnect and
restore, logs, attachments, and workflow continuation.

## Identity

`AccountSession` is the only account credential. It is signed by the account
authority and contains the account id, principal id, principal type, expiry, and
principal public key.

`free auth login` stores one local credential at
`~/.free/account-session.json`. The host uses the encoded AccountSession for
relay API and registration, and the bridge uses the matching private key to
prove each client connection.

The account authority public key is shipped with Free. Normal users do not set
host ids, public keys, or relay credentials.

For every relay connection the bridge signs a `ConnectionProof` with its
AccountSession private key. The proof binds:

- account session
- client id
- connection id
- host id
- nonce
- timestamp

The relay verifies the AccountSession before routing. The host independently
verifies the account authority signature and the bridge proof signature before
creating an ACP runtime connection. The relay cannot forge this proof unless it
also has the bridge private key or the account authority private key.

## Relay

The relay does not issue runtime credentials. It only:

- authenticates account-scoped API requests
- records host/client presence
- checks grants before routing
- forwards `Hello`, `Data`, `Ack`, `Ping`, `Pong`, and `Close`
- keeps disconnected client/host state during reconnect grace windows
- replays pending frames after reconnect

There is no extra runtime credential and no separate refresh endpoint.

## Host

The host treats relay memory as cache and treats the bridge proof as the runtime
authorization boundary. After a valid `Hello`, it exposes the local runtime
through the standard ACP facade.

Network drops, host reconnect, client reconnect, and pending-frame replay are
handled inside relay/host/bridge. Editors continue using native ACP.

The bridge discovers the online host from the signed account session and relay
host API. If more than one host is online, it prefers the host whose machine
metadata matches the current machine, then falls back to a stable host id order.
