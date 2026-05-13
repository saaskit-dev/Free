# Free Product Context

register: product

## Product Definition

Free is an AI-native coding workflow runtime interface.

It is not a chat product, an IDE, a SaaS dashboard, or an issue tracker. Free is
a human-agent handoff surface for remote coding workflows. Its primary object is
the session: a continuing remote coding workflow that can be supervised,
continued, approved, interrupted, restored, or taken over by a human.

Free sits above a universal agent runtime that can connect to multiple coding
agents, including Claude Code, Codex, Gemini, Cursor Agent, and custom ACP
agents. The interface should hide relay and runtime plumbing during normal use
while preserving enough operational truth for supervision, authorization,
review, and recovery.

## Current Execution Focus

The long-term product direction is for Free's own Session Workbench to become
the primary client for coding-agent interaction. Users should be able to create,
continue, authorize, interrupt, restore, review, and hand off agent work inside
Free without depending on an external ACP client as the main product surface.

The current implementation focus is the bridge compatibility layer and the Web
UI around it. This means Free should keep external ACP clients working through
`free bridge run` while building the product capabilities that the Session
Workbench will own directly: host discovery, session selection, authorization,
runtime controls, reconnect and restore states, logs, attachments, and workflow
continuation.

Product UI implementation should prioritize `Expo + React Native + React
Native Web`, with Electron as the preferred desktop container. Cloudflare Worker
HTML must not become a second product surface. The relay should keep only the
server-rendered protocol pages required by OAuth login, login confirmation, and
ACP authorization flows until those flows have first-class Workbench APIs.

Treat the bridge as a compatibility and migration surface. It is allowed to
expose protocol-level behavior where needed for compatibility, but product
decisions should still optimize toward the Session Workbench as the durable
human-agent interaction model.

## Users

Free is for developers and technical operators who manage more than one remote
coding workflow at a time. They open the product to decide what needs attention,
which agents are still running, what changed, what failed, what needs approval,
and how to continue a session without losing context.

The user is not primarily asking an AI a question. They are supervising and
continuing work that is already in motion.

## Core Object

The core object is `Session`.

A session represents a durable coding workflow with runtime state, agent
identity, workspace context, events, operations, authorizations, outputs, and
handoff moments. A session is not equivalent to a chat thread, file, project,
issue, terminal, or dashboard card.

Session state should use three primary product states:

- `Waiting Auth`: human authorization is blocking workflow progress.
- `Running`: an agent turn or runtime operation is actively progressing.
- `Idle`: no active execution is running.

Errors are Idle context, not a fourth state. Examples: `Idle · tests failed`,
`Idle · command exited 1`, `Idle · host offline`.

## Product Purpose

Free lets a user manage multiple remote coding agent sessions from one
operational surface:

- see which sessions require human attention
- observe agents executing remotely
- inspect code changes, tests, diffs, terminal output, and logs
- approve or deny sensitive operations
- continue an idle or blocked workflow
- interrupt running work
- take over from an agent and hand the task back
- restore or reconnect durable sessions without losing workflow context

The product verbs are:

- supervise
- continue
- approve
- deny
- interrupt
- review
- take over
- hand off

The product verb is not `chat`.

## Main Surface

The main product surface is the Workbench app, not the relay Worker root. During
the bridge compatibility focus, the live Workbench navigation must stay limited
to surfaces backed by real APIs:

- Access: account session state from `/api/session`, plus `/login` and
  `/logout`.
- Hosts: host discovery from `/api/hosts`.
- System: relay health from `/health`.

Do not keep sample workbench routes, fake project sessions, fake deploys, fake
repositories, generic settings pages, or archived prototypes in the primary UI.
Do not expose authorization queues, session continuation, migration state, logs,
attachments, or runtime controls until the matching API and tests exist.

Bridge Web UI is multi-endpoint from the first implementation. Large desktop,
small desktop or tablet, and mobile must all preserve the same product meaning:
account access, host discovery, and system health. Smaller screens may collapse
secondary context, but they must not lose the primary bridge workflow.

The main product surface has three regions:

```text
Session Memory Surface | Workflow Canvas | Context Surface
```

There should be no global icon rail, no top-level browser-style session tabs,
no dashboard widget grid, and no global bottom composer.

### Session Memory Surface

The left surface is an attention queue for remote coding sessions. It should be
240 to 280 px wide in the full Workbench app frame and should prioritize attention:

1. `Waiting Auth`
2. `Running`
3. `Idle`

Empty sections are hidden. Recent sessions belong in search, quick switch, or a
popover, not as a permanent section competing with state groups.

Every row should show agent identity, workflow phase, repo or workspace
context, latest meaningful event, compact state indicator, and relative time as
secondary metadata. Running rows should emphasize the latest event, not elapsed
duration.

### Workflow Canvas

The center surface is the operational workflow canvas. It is not a chat column.
Workflow content should use the available canvas width. Readability comes from
structure, spacing, hierarchy, and workflow sections, not from a narrow
`max-width` reader layout.

Canvas content is organized by workflow meaning:

- title
- analysis
- plan
- key findings
- operations
- modified files
- tests
- review state
- handoff
- command surface

Speaker labels are secondary. The workflow is primary.

### Context Surface

The right surface is auxiliary context, usually 300 to 340 px wide. It is not a
second IDE workspace and should not become a stack of cards.

Only one context tab is visible at a time:

- `Diff`
- `Files`
- `Terminal`
- `Logs`

If `Diff` is active, the surface shows diff context only. Terminal, logs,
metrics, tags, and session info must not be stacked underneath.

### Command Surface

The command surface belongs inside the workflow canvas. It is a workflow
continuation editor, not a chat composer.

Use `Execute`, not `Send`.

Inline references such as `@auth.ts`, `#123`, and `/review` are part of the
command body. Runtime controls such as agent, mode, model, and autonomy belong
in a compact metadata strip.

Primary action changes by session state:

- `Idle`: `Execute`
- `Running`: `Stop` or `Interrupt`
- `Waiting Auth`: `Approve`, `Deny`, or `Continue`

## Strategic Principles

### Canvas First

The workflow canvas is the main content area. Analysis text, reasoning, file
changes, tests, handoff states, and commands all belong to the same continuous
workflow document.

### Workflow Over Chat

The product should not visually center `You` and agent names as chat bubbles.
Runtime events become workflow phases, findings, operations, diffs, tests, and
handoff states.

### Attention Over Structure

Session ordering should answer the user's first operational question: what
needs attention now. The session list is an attention memory surface, not a
business taxonomy.

### Deference Over Decoration

The workflow UI should recede behind the task, but the brand should not become
bland. Use alignment, typography, state semantics, and subtle boundaries inside
dense working areas. Use bold color, geometry, imagery, and motion in brand
moments such as onboarding, authorization, empty states, generated imagery, and
Web UI surfaces that can carry personality. Avoid generic decorative glow,
large cards, heavy toolbars, noisy badges, generic strong gradients, duplicate
metadata, and dashboard widgets.

### Command, Not Message

The input area continues work. Its model is command execution and workflow
handoff, not casual messaging.

## Design References

Free should absorb principles from these references without copying their
surface style:

- Apple Human Interface Guidelines: hierarchy, harmony, consistency, clarity,
  deference, and depth.
- Linear: dense scanning, low visual noise, stable hierarchy.
- Raycast: command-first execution and keyboard-oriented workflows.
- Superhuman: attention queue and fast triage.
- Arc: reduced chrome and content-first framing.
- Codex: agent command surface and coding workflow continuity.
- Contemporary creative technology brands: vivid color, tactile product
  detail, editorial image direction, and confident art direction.
- Consumer product and fashion systems: packaging discipline, cross-platform
  consistency, and memorable brand surfaces.

Apple HIG is a formal design reference, not a visual skin. In Free it means the
interface should make priority clear, keep controls harmonious with the current
workflow, and use consistent state semantics across sessions, canvas, context,
and command surfaces.

Reference: https://developer.apple.com/design/human-interface-guidelines/

## Anti-References

Free should not drift into these product shapes:

- ChatGPT for coding: the center object becomes chat messages.
- Cursor clone: the center object becomes files and editor chrome.
- VS Code Web: terminal, file tree, and editor layout become the product.
- Devin dashboard: sessions become status cards and metrics panels.
- Jira or Linear issue tracker: sessions become issues instead of runtime
  executions.
- SaaS dashboard: widgets and summary cards displace the workflow.

## Copy Rules

Use operational, specific language.

Free supports English and Chinese. Product copy should preserve the same
workflow meaning in both languages; translate actions, state labels, headings,
and workflow summaries while keeping code identifiers, paths, repo names,
branch names, and precise runtime nouns stable when needed.

Prefer:

- `Execute`
- `Review changes`
- `Approve and continue`
- `Request changes`
- `Interrupt`
- `Waiting for terminal approval`
- `Restoring session`

Avoid:

- `Send`
- `Ask AI`
- vague approval copy
- decorative labels
- repeated metadata
- informal symbols in technical UI copy

## Implementation Boundary

Normal product surfaces should hide internal relay and trust details unless the
user is debugging. Host id, connection id, grant, ticket, connection proof,
route, reconnect grace, and relay internals are implementation concepts.

User-facing surfaces may expose host, agent, workspace, branch, and remote
context when they help setup, filtering, authorization, restoration, or
debugging.
