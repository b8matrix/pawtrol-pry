# Design — Pawtrol "Run Ledger"

The whole UI reads like one technical sheet: blueprint-grey paper, steel-blue ink, hairline rules, and crosshair registration marks. It is quiet and minimal, and the plain-language copy is readable by anyone. The source of truth is `styles.css`, which is shared by `sidepanel.html` (`body.panel`) and `options.html` (`body.page`).

## Themes and tokens (`:root` in styles.css)

**Themes:**
- There are two schemes. `theme-boot.js` sets `<html data-scheme="light|dark">` before first paint. It follows the system setting unless `localStorage["pry-theme"]` holds an explicit choice.
- **Controls:** the header toggle (`[data-theme-toggle]`, sun/moon) and a System / Light / Dark control in Settings (`input[name="pry-theme"]`). Both live in `theme.js`.
- Switching animates a circular reveal from the button, using a View Transition. It is skipped under reduced motion.
- **Light, "drafting white":** zinc neutrals in the shadcn scale on pure white, with steel-blue ink. No ornament.
- **Dark, "blueprint night":** graphite-navy paper plus these ornaments:
  - a 24px drafting grid that fades out down the page (`body::before`)
  - ruler ticks along the top edge of hero frames (`.frame::before`, `.intro::before`)
  - accent-tinted crosshairs and a faint top sheen on accent surfaces
  - meter segments lit like instrument lights
- **Both themes:** a scan line sweeps under the ledger head while the agent runs, and the user's name in the greeting headline is set in accent ink (`.greet-name`).
- **Adding ornament:** use tokens (`--grid-line`, `--ruler`, `--cross`, `--frame-fill`, `--sheen`) that are transparent in light. Don't duplicate selectors.

**Colors:**

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#ffffff` | `#0d1116` | Page ground |
| `--surface` / `--surface-2` | — | — | Rows, inputs, recessed areas |
| `--line` / `--line-strong` | — | — | Dividers, frames, control borders |
| `--ink` / `--ink-2` / `--mute` | — | — | Text |
| `--accent` | `#4a6f9a` | `#84aad6` | The only accent |
| `--accent-tint` / `--accent-line` | — | — | Accent fills and borders |
| `--alert` / `--ok` (+ `-tint`) | — | — | Status only |

The `--color-*` variables are aliases kept only for inline styles injected by the minified bundles.

**Type:**

| Face | Use |
|---|---|
| **Barlow Condensed** 600/700 | Headlines and every uppercase label: 11–12px, tracking 0.12–0.14em |
| **Barlow** 400–600 | Body text, 13px |
| **JetBrains Mono** | Data only: model ids, step log, counters, token values. Never decoration. |

## Components
- **Label**: `.label`, condensed uppercase in `--mute`. Section heads use it; they are never eyebrows above headings.
- **Frame**: `.frame` / `.intro`, a 1px `--line-strong` box with four `.cross` crosshairs (`tl`, `tr`, `bl`, `br`) sitting on the corners. It is reserved for the one hero block on each page.
- **Meter**: 12 outlined segments. `.on` fills with accent, and the `.alert` variant switches to `--alert`.
- **Chip**: 26px tall, 3px radius. `.active` is filled accent. `.needs-key` shows an alert dot. `.chip-add` has a dashed border.
- **Buttons**:
  - `.btn`: condensed uppercase with a hairline border. `.btn-primary` is filled accent.
  - `.link-btn`: accent text. `.danger` switches it to alert.
  - `.icon-btn`: 30px, drawn SVG icons with a 1.4 stroke. No emoji or unicode glyph icons.
- **Popovers** (`.menu`, `.model-menu`): surface, `--line-strong` border, soft `--shadow`, and a 4px radius.
- **Sheets** (`.sheet`): full panels below the top bar, with a sticky `.audit-header`. Stats render as a shared-border grid, not as separate cards.
- **Ledger entries**:
  - `step`: mono, dashed divider.
  - `user` and `assistant`: bordered surface blocks.
  - `egress`: accent tint.
  - `error`: alert tint.

## Layout (side panel)
From top to bottom:
1. Top bar (52px)
2. Page exposure
3. Ledger head
4. Scrolling ledger, with the greeting frame when empty
5. Confirm bar
6. Composer: model chips, then the note and model picker, then the input and send button

The gutter is 16px.

## Motion
- The single authored moment is the greeting headline: it blurs and rises into place when it re-rolls for a new chat.
- Everything else is short and functional: entries fade in, popovers pop, sheets rise.
- All motion uses `--ease-out` and is disabled under `prefers-reduced-motion`.

## Voice
- Write in plain words ("Scan this page for personal data", "Nothing leaves your machine").
- The greeting rotates through the phrases in `ui-shell.js` (`PHRASES_NAMED` / `PHRASES_ANON`).
- Never invent metrics. Every number shown comes from real audit or tripwire data.
