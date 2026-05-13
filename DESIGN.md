# Free Design System Context

register: product

## Design Language

Free's design language is:

```text
Playful, futuristic, vivid, precise, continuous.
```

The interface should feel like a precise runtime workbench wrapped in a bold
creative technology brand. It should balance toy-like energy with the polish of
a high-end creative studio. Free should not feel like a chat app, IDE clone,
project management dashboard, or generic SaaS tool.

The default physical scene is a developer working inside a code-heavy desktop
tool that still carries a confident consumer-product personality: scanning
multiple long-running agent sessions while bright geometric brand moments,
precise motion, and tactile surfaces make the system feel young, future-facing,
and highly designed.

The brand world should express:

- creativity
- youthfulness
- rhythm
- tactile interaction
- concept-forward digital product thinking
- product obsession
- visual experimentation
- packaging exploration
- editorial photography
- immersive retail cues
- cross-platform brand consistency

The product surface still needs operational clarity. Dense session work areas
should use disciplined structure, but the surrounding brand system can use
high-saturation color, clean geometry, modern typography, energetic rhythm, and
slightly surreal imagery.

Free must support two first-class themes:

- Light is the default product surface for broad daily work. It should feel
  like a polished desktop product with visible brand energy, not a white SaaS
  dashboard.
- Dark is a first-class focused work mode. It should use the same hierarchy and
  token roles, not a separate visual language.

Both themes should remain operational, dense, and precise.

## Apple HIG Interpretation

Apple Human Interface Guidelines are a formal design reference for Free:

https://developer.apple.com/design/human-interface-guidelines/

Apply the principles as product behavior:

- Hierarchy: attention order is `Waiting Auth` > `Running` > `Idle`; workflow
  sections must make the current phase and next action obvious.
- Harmony: session list, workflow canvas, context surface, and command surface
  must support one continuous workflow instead of competing for focus.
- Consistency: the same state names, action labels, controls, and context tabs
  must mean the same thing across all product surfaces.
- Clarity: labels should identify concrete runtime work, not abstract AI
  activity.
- Deference: chrome, borders, icons, and decoration should stay subordinate to
  session content.
- Depth: use layering for attention, context, and disclosure, not visual
  ornament.

## Color Strategy

Use a vivid dual-theme product palette: graphite-tinted operational neutrals
plus saturated brand color. Use OKLCH tokens for new CSS.

The strategy is not a quiet monochrome product shell. It is a controlled
high-color system. Use bright color deliberately for brand surfaces, active
states, onboarding, authorization moments, empty states, packaging-like
composition, and visual storytelling. Use calmer neutrals for dense workflow
reading, diffs, logs, and terminal output.

Recommended roles:

- background: app background, tinted graphite in both light and dark modes
- shell: main working surface, separated from background by luminance
- surface: panel and control surface
- surface-2: hover, selected, and grouped content surface
- border: low-contrast graphite separator
- border-strong: selected or active boundary
- text: high-contrast foreground, never pure black or pure white
- muted: secondary metadata
- accent: vivid blue-violet or electric blue for active selection and primary
  execution
- brand-bright: saturated consumer-product color for brand moments and visual
  rhythm
- brand-contrast: a second saturated color for campaign, empty-state, or
  editorial contrast
- success: precise green for running or passed checks
- warning: muted amber for authorization and recoverable attention
- danger: muted red for rejected, failed, or destructive states

Accent color should be used for current selection, command execution, focus
ring, and state indicators. Brand color may carry more surface area in
onboarding, marketing, first-run, illustration, and memorable product moments,
but it must not obscure workflow state or make inactive controls look active.

Avoid:

- white SaaS dashboard surfaces
- one-note purple surfaces
- blue-slate dashboard atmosphere
- saturated inactive states
- color used without state meaning

Do not flatten the brand into a single blue-purple software palette. Use
color-blocking, swatches, geometric fields, layered product details, and
editorial image direction before relying on generic gradients or glow.

## Brand Assets And Imagery

Free brand materials may be sourced from:

```text
https://github.com/saaskit-dev/agentbridge/tree/main/apps/free/app
```

The verified upstream app directory includes Free app assets and source
material entry points such as `public`, `sources`, `targets`, and `logo.txt`.
Use these as the first source for logos, app imagery, reference assets, and
brand continuity before inventing new visual language.

If the available assets are insufficient, generate replacement imagery with the
image2 image generator. Prefer transparent-background images for product
objects, icons, stickers, mascot-like elements, packaging studies, and
editorial cutouts so they can be composed cleanly into Web UI surfaces.

Image direction should be slightly surreal, tactile, and product-obsessed:
precise object details, bold color, crisp silhouettes, confident art direction,
and enough physicality to avoid generic abstract AI decoration.

## Language

Free must support English and Chinese as product languages. The UI should treat
language as interface state, not as a separate route family.

Rules:

- Keep runtime nouns such as `Session`, `Agent`, `Diff`, and repo or branch
  names stable when translation would reduce precision.
- Translate action labels, state labels, headings, hints, and operational
  summaries.
- Preserve the same information density in both languages.
- Do not use informal symbols or decorative language in either locale.

## Typography

Use system UI fonts:

```css
font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

Use monospace only for code, paths, line numbers, diffs, terminal output, and
machine identifiers:

```css
font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
```

Product UI should use a tight fixed scale:

- 11 px: metadata, compact row details, shortcuts
- 12 px: default dense UI text
- 13 px: important row titles and body text
- 15 to 16 px: panel headers and section titles
- 20 to 24 px: workflow title only

Do not use fluid viewport-based font scaling. Letter spacing should remain 0
except where existing platform rendering requires a small technical adjustment.

## Layout

The primary app shell is a three-surface workspace:

```text
Session Memory Surface | Workflow Canvas | Context Surface
```

Recommended full product dimensions:

- Session Memory Surface: 240 to 280 px
- Workflow Canvas: remaining available width
- Context Surface: 300 to 340 px
- Top chrome: compact, content-first
- Command Surface: inside Workflow Canvas

The workflow canvas should use available width. Avoid a narrow centered chat
column such as `max-width: 760px; margin: auto;`.

Use stable dimensions for rows, toolbars, icon buttons, tabs, and command
controls so content changes do not shift the layout.

## Components

### Session Row

Session rows are dense inbox rows. They should include:

- agent icon
- workflow phase
- repo, branch, or workspace
- latest meaningful event
- state dot
- relative time

Waiting Auth rows may use a soft amber background and amber state dot. Running
rows use green state indicators and event-first summaries. Idle rows are
subdued; errors appear as small contextual markers.

Avoid turning rows into large cards. Do not use heavy colored side stripes.

### Section Header

Section headers should be compact and sticky when the list scrolls. Hide empty
sections entirely. Do not show zero-count groups.

### Context Tabs

Context tabs are `Diff`, `Files`, `Terminal`, and `Logs`. Only one tab is
visible at a time. Tabs should use compact active indication and no decorative
card stack.

### Command Surface

The command surface is a compact editor with:

- metadata strip for agent, mode, model, autonomy, and current context
- multiline command body
- inline references inside the body
- compact attachment and utility controls
- primary action matching session state

Use `Execute`, `Stop`, `Interrupt`, `Approve`, `Deny`, or `Continue` according
to the current state. Do not use `Send`.

### Handoff

Handoff is a workflow transition. It should be compact, explicit, and placed in
the canvas near the relevant work result.

Good examples:

- `Agent finished implementation and is waiting for review.`
- `Review changes`
- `Approve and continue`
- `Request changes`

Avoid promotional banners and oversized callouts.

## Surfaces

### Session Memory Surface

This is an attention memory surface. It answers:

- what blocks progress now
- what is still running
- what can wait

The section order is fixed:

1. `Waiting Auth`
2. `Running`
3. `Idle`

Recent belongs in quick switch, not as a permanent section.

### Workflow Canvas

This is the main surface. It renders a continuous workflow document:

- analysis
- reasoning
- operations
- file changes
- tests
- command output
- review state
- handoff
- next command

It should be readable through hierarchy and structure, not through chat-style
message bubbles.

### Context Surface

This is reference material. It supports the current workflow but does not own
the main task.

Do not stack multiple context types. Do not add permanent session info cards,
tag cards, metrics cards, or duplicated metadata.

## Interaction

The product should be keyboard-friendly and command-oriented. Search, quick
switch, filters, context tab switching, and command execution should feel fast
and predictable.

Use standard controls where users expect them:

- icon buttons for tools
- segmented controls for modes
- tabs for context
- checkboxes or toggles for binary settings
- menus for option sets
- text buttons for explicit workflow actions

Use Hugeicons as the default icon library:

```text
https://hugeicons.com/
```

Do not invent custom decorative SVGs for standard actions. Custom artwork is
reserved for brand imagery, product illustrations, packaging explorations, and
transparent-background image assets.

## Motion

Motion should communicate state:

- row selection
- context tab change
- command surface focus
- authorization reveal
- reconnect or restore state

Keep most transitions between 150 and 250 ms. Do not animate layout properties.
No decorative page-load sequences.

## Accessibility

Every interactive control needs visible focus state, accessible name, disabled
state, hover state, and active state.

Color cannot be the only signal. State labels or semantic markers must remain
available where status affects action.

Dense UI still needs reliable hit targets. Use compact spacing, not fragile
click areas.

## Responsive Behavior

Multi-endpoint responsiveness is a first-class requirement from the first Web
implementation. Do not treat responsive behavior as a later polish pass.

Design every bridge Web surface for at least three working ranges:

- large desktop: dense supervision, visible navigation, inspector context, and
  broad resource comparison
- small desktop or tablet: preserve navigation and task continuity while
  collapsing secondary context
- mobile: keep the same product meaning with a single-column flow, reachable
  primary actions, readable resource state, and no horizontal overflow

- collapse or overlay Context Surface on narrower widths
- allow Session Memory Surface to become a drawer below desktop breakpoints
- keep Command Surface attached to Workflow Canvas
- preserve state priority and context tab semantics
- keep route navigation reachable without requiring hover or precise pointer
  input
- keep all action rows, endpoint rows, command rows, and resource rows readable
  without clipping text
- verify large desktop, small desktop, and mobile widths before considering a
  Web UI change complete

Do not turn the product into a marketing landing page on small screens.

## Absolute Avoid List

Do not introduce:

- global icon rail
- browser-style session tabs
- dashboard cards
- nested cards
- large widgets
- generic strong gradients
- decorative glow as default atmosphere
- glassmorphism as a default
- noisy badges
- duplicate metadata
- permanent heavy toolbars
- chat bubbles as the primary workflow structure
- paper-plane send icon for command execution
