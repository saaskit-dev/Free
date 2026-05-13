# Free Product Interface

Free is an AI-native coding workflow runtime interface.

It is not a chat product, an IDE, a SaaS dashboard, or an issue tracker. Free is
a human-agent handoff surface for remote coding workflows. The primary object is
the session: a continuing remote coding workflow that can be supervised,
continued, approved, interrupted, restored, or taken over by a human.

This document is the product interface baseline for future UI, UX, copy, and
frontend implementation work. `docs/remote-acp.md` and `docs/relay-invariants.md`
remain the protocol and relay boundary references. This document translates
those runtime boundaries into product behavior.

## Product Shape

The main interface is a three-surface workspace:

```text
Session Memory Surface | Workflow Canvas | Context Surface
```

Do not add top-level session tabs, a global icon rail, dashboard widgets, or a
global footer composer. The product should feel operational, vivid, dense,
precise, continuous, and typography-driven.

Free users are not primarily chatting with an assistant. They are managing
remote agent sessions: checking what needs attention, watching active work,
reviewing context, approving sensitive actions, continuing a workflow, and
handing work back and forth with the agent.

## Current Interface Focus

Free's final product surface is its own Session Workbench. The workbench should
eventually be the primary place where users create sessions, continue agent
work, approve sensitive operations, interrupt running turns, inspect outputs,
review changes, and restore durable workflows.

The current product and UI focus is narrower: make the bridge compatibility
layer excellent, then expose its capabilities through the Web UI. That includes
host discovery, connection authorization, session selection, runtime permission
decisions, reconnect and restore state, session memory, logs, diffs, terminal
context, attachments, and the command surface needed to continue a workflow.

The product frontend stack should prioritize `Expo + React Native + React
Native Web`; Electron is the preferred desktop container. The React Native Web
surface should lead product implementation, with React Native mobile kept
first-class. Worker-rendered HTML is not a product surface. It should remain
limited to server-side protocol pages that cannot yet be represented by a real
Workbench API.

External ACP clients remain important compatibility surfaces during this phase.
They should not define the final information architecture. If a design decision
works for a stdio bridge client but weakens the Session Workbench model, prefer
the workbench model and keep the bridge behavior as an adapter concern.

## Current Workbench Surface

The Workbench should expose only surfaces backed by real relay APIs. As of this
implementation phase, the product navigation is limited to:

- Access: `/api/session`, plus the existing `/login` and `/logout` protocol
  endpoints.
- Hosts: `/api/hosts`.
- Settings: local Workbench preferences and the real `/api/session` account
  state.

Do not expose pages for authorization queues, session continuation, migration
state, logs, attachments, or runtime controls until the matching API exists. If
one of those surfaces becomes necessary, implement the API and tests first, then
add the UI.

## Responsive Requirement

Bridge Web UI must be designed as a multi-endpoint product from the first
implementation. Large desktop, small desktop or tablet, and mobile are all
formal experience targets.

Every bridge page should preserve the same product meaning across sizes:

- Home still explains available bridge resources and next actions
- Authorization still distinguishes connection authorization from runtime
  permission
- Hosts still explains discovery and workspace roots
- Sessions still explains binding, reconnect, restore, and continuation
- System still exposes relay, host, API, and attachment diagnostics

On smaller screens, collapse secondary context before removing primary meaning.
Navigation, status, and primary actions must remain reachable without hover,
without horizontal scrolling, and without relying on desktop-only layout.

## Design References

`PRODUCT.md` and `DESIGN.md` are the root design context for frontend work.
This document remains the product interface baseline.

Apple Human Interface Guidelines are a formal design reference:

https://developer.apple.com/design/human-interface-guidelines/

For Free, Apple HIG should be interpreted as product behavior rather than a
visual skin:

- hierarchy: `Waiting Auth` > `Running` > `Idle`, with next action visible
- harmony: session list, canvas, context, and command surface support one
  continuous workflow
- consistency: state names, action labels, tabs, and controls keep the same
  meaning across surfaces
- clarity: labels describe concrete workflow and runtime state
- deference: chrome stays subordinate so session content remains primary
- depth: layering supports attention and disclosure, not decoration

Free also borrows operational lessons from Linear, Raycast, Superhuman, Arc,
and Codex, but it should not copy any of them visually.

## Brand System Inputs

Use the Free app materials from the upstream app directory as the first visual
asset source:

```text
https://github.com/saaskit-dev/agentbridge/tree/main/apps/free/app
```

The verified directory includes `public`, `sources`, `targets`, and `logo.txt`
entry points. Use those materials for logos, app imagery, reference assets, and
brand continuity before inventing new visual language.

Use Hugeicons as the default icon library for Web UI controls:

```text
https://hugeicons.com/
```

If source assets are insufficient, generate replacement imagery with the image2
image generator. Prefer transparent-background images for product objects,
icons, stickers, editorial cutouts, packaging studies, and other composable
brand assets.

## Session Memory Surface

The left surface is an attention queue for active and recent remote agent
sessions. It is not a generic sidebar, project tree, issue list, or dashboard.

Only three primary states should be used:

- `Waiting Auth`: the workflow is blocked on a human authorization decision.
- `Running`: an agent turn or runtime operation is actively progressing.
- `Idle`: no active execution is currently running.

Errors are not a fourth state. They are Idle context, for example:

- `Idle · tests failed`
- `Idle · command exited 1`
- `Idle · host offline`

Sorting should prioritize attention:

1. `Waiting Auth`
2. `Running`
3. `Idle`

Empty sections should be hidden. Do not render counters for empty sections.

Every session row should show:

- agent identity
- current workflow phase or title
- repo, branch, or workspace context when available
- latest meaningful runtime or relay event
- compact state indicator
- relative time as secondary metadata

The latest event is important. Current runtime code emits and maps session
updates such as agent text, thoughts, plans, tool calls, tool call updates,
usage, mode updates, config updates, and session title updates. The row summary
should be derived from those events rather than from static session metadata.

Examples:

- `Running tests`
- `Editing src/auth/session.ts`
- `Waiting for terminal approval`
- `Restoring session`
- `Relay reconnecting`
- `Idle · 3 failing tests`

Recent sessions should not be a permanent list section. Recent belongs in quick
switch, search, or a small popover near the search field.

Filters should be available from a filter control, not as a permanent form.
Useful filter dimensions are status, agent, workspace, repo, branch, host,
remote, time, and keyword. Host is operationally important, but it should not be
forced into every row unless the user is filtering, inspecting details, or
debugging.

## Workflow Canvas

The center surface is the operational workflow canvas. It is not a chat column.

Do not constrain normal workflow content to a narrow chat-reader column. Text,
reasoning, tool results, file changes, tests, review notes, and handoff content
should use the available canvas width. Readability should come from structure,
spacing, and hierarchy, not from a `max-width` chat layout.

Canvas content should be organized by workflow meaning rather than speaker
identity:

- workflow title
- analysis or reasoning
- plan
- key findings
- operations
- file changes
- tests
- terminal output
- review or handoff state
- command surface

The implementation already maps runtime thread and turn events into ACP session
updates: user messages, agent messages, thoughts, plans, tool calls, tool call
updates, usage, and metadata updates. The canvas should render those as a
continuous workflow document instead of emphasizing `You` and agent chat roles.

Handoff is a workflow transition, not a marketing callout. It should be compact
and action-oriented:

- `Agent finished implementation and is waiting for review.`
- `Review changes`
- `Approve and continue`
- `Request changes`

## Context Surface

The right surface is supporting context. It is not a second workspace and should
not become a stack of cards.

Use one context tab at a time:

- `Diff`
- `Files`
- `Terminal`
- `Logs`

If `Diff` is selected, only diff context should be shown. Do not stack terminal,
logs, metrics, tags, and session info under it.

The current runtime operation should drive the default context:

- edit operations open `Diff`
- read/search operations open `Files`
- command operations open `Terminal`
- relay, bridge, or host diagnosis opens `Logs`

Session-level metadata belongs in the session row, header, hover detail, quick
switch, or debugging view. It should not become a permanent card stack in the
right surface.

## Command Surface

The command surface belongs inside the workflow canvas. It is not a global
footer and not a chat composer.

The user is continuing a workflow, not sending a message. Use `Execute` for the
primary action, not `Send`.

The command surface should support runtime controls from real session metadata:

- agent
- mode
- model or profile where exposed by the agent
- autonomy or permission mode where exposed by the agent
- inline file, issue, command, image, audio, and resource references

The current code supports session modes and config options through
`session/set_mode` and `session/set_config_option`. The UI should treat these as
first-class runtime controls, not decorative pills.

Primary action changes by session state:

- `Idle`: `Execute`
- `Running`: `Stop` or `Interrupt`
- `Waiting Auth`: authorization-specific actions

## Authorization

`Waiting Auth` contains more than one product situation. The UI should preserve
one high-level state while making the concrete authorization type clear.

There are two important authorization classes today:

- connection authorization: choosing a host, agent, and workspace for a relay
  session
- runtime permission authorization: allowing or rejecting a sensitive operation
  during an agent turn

Connection authorization should stay compact and scoped. It can expose machine,
agent, and workspace because these are user-facing choices. It should not expose
connection proofs, grant internals, connection ids, host ids, or relay lifecycle
details unless the user is explicitly debugging.

Runtime permission authorization should show the operation and scope:

- `Allow once`
- `Allow for this session`
- `Reject`

Product copy should be specific:

- `Allow terminal once`
- `Allow file edit for this session`
- `Reject`

Avoid generic approval copy that hides what is being authorized.

## Reconnect And Restore

Reconnection and restoration are part of the continuous workflow experience.
They are not automatically errors.

The bridge and relay support reconnect backoff, pending outbound queues,
in-flight replay, duplicate response suppression, pending host reconnect, and
session binding restoration. The UI should surface these as workflow continuity
states:

- `Connecting`
- `Reconnecting`
- `Restoring session`
- `Ready`
- `Needs authorization`

Only unrecoverable conditions should become Idle error context, for example:

- host unavailable after the reconnect window
- missing historical session binding
- workspace policy denial
- authorization expired
- relay queue overflow

Implementation identifiers such as ticket, grant, connection id, host id,
connection proof, reconnect grace, and relay route should remain hidden in the
normal product surface.

## Host, Agent, And Workspace

Host, agent, and workspace are real product dimensions, but they should be
shown at the right moment.

Host metadata currently includes machine name, runtime instance id, advertised
agent types, and workspace roots. These should inform:

- new session setup
- authorization flows
- filtering
- hover details
- debugging views
- session restoration context

They should not dominate normal session rows. Most users should experience a
session as work happening in a workspace through a chosen agent, not as a relay
route bound to an internal host id.

When more than one host is online, the product should make host choice explicit.
When one obvious host is available, the product can default it and keep the
choice subdued.

## Visual Direction

The default product surface should be:

- light theme by default, with dark theme as a first-class mode
- graphite-tinted operational neutrals in both themes
- saturated brand color used deliberately for active states and brand moments
- dense
- precise
- operational
- playful without becoming childish
- futuristic without becoming generic sci-fi
- tactile
- rhythm-driven
- typography-driven
- visually experimental in onboarding, authorization, empty states, and other
  brand surfaces
- calmer inside diffs, logs, terminal output, and long workflow reading

Avoid:

- icon rail
- browser-style session tabs
- dashboard cards
- large widgets
- generic strong gradients
- decorative glow as default atmosphere
- noisy badges
- repeated metadata
- nested cards
- permanent heavy toolbars

Use boundaries sparingly. Prefer alignment, typography, state semantics, and
content hierarchy over decorative framing. Use bold color, clean geometry,
editorial image direction, and product-detail imagery where the surface can
carry brand personality without weakening workflow clarity.

The interface must support English and Chinese. Language switching should keep
the same product structure and density. Translate action labels, state labels,
headings, hints, and workflow summaries; keep code identifiers, repo names,
branches, paths, and precise runtime nouns stable when translation would make
the UI less exact.

## Design Implications From Current Code

The current codebase implies these product rules:

- Session rows should be event-driven, because runtime events already carry
  plans, thoughts, tool calls, operation status, usage, mode changes, config
  changes, and title updates.
- `Waiting Auth` must distinguish connection authorization from runtime
  permission decisions.
- `Reconnecting` and `Restoring session` should be visible continuity states,
  not treated as failures by default.
- The command surface must own runtime controls such as session mode and config
  options.
- The context surface should follow the selected or latest operation.
- Host, grant, proof, connection id, and relay route details should remain
  internal unless the user is debugging.
- Workspace scope is a product-level safety boundary and should appear in
  authorization, filtering, and session setup.

## Source Of Truth

When product and implementation drift, use this order:

1. Existing runtime and relay behavior in code.
2. Relay and trust-boundary invariants in `docs/remote-acp.md` and
   `docs/relay-invariants.md`.
3. This product interface baseline.
4. Visual mockups and screenshots.

Screenshots are directional references, not authoritative protocol or state
models. Code-level runtime events and relay boundaries define what the product
can truthfully show.
