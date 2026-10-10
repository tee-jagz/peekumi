# Colour

Peekumi has four themes: Light, Dark, and a colour-blind safe version of each. The owner's device setting chooses light or dark. A setting in Peekumi turns on the colour-blind safe themes.

## Roles

Use the role tokens only. Never use a hex value in a component.

**Ground**

- `canvas`: the map ground and the page. White paper in light, deep teal-black in dark. No gradient, no colour washes.
- `surface`: the sheet.
- `surface-sunken`: code blocks, diffs, fields and the composer input.
- `surface-raised`: changed map cards.
- `surface-popup`: every pop-up (menus, select lists, popovers, dialogs and the Agents sheet), with `shadow-popup`. In dark it is a step lighter than the sheet and the cards.
- `glass` and `glass-strong`: the map frame, the floating controls, the sheet and the composer (see **Space and shape**).

**Text and lines**

- `ink`: main text, code and card names.
- `ink-muted`: labels, meta lines and captions.
- `ink-subtle`: line numbers, unchanged status and placeholders. Never below 12px.
- `line`: hairlines between rows and around cards. It never marks the only edge of a control.
- `line-strong`: the edges of fields and controls, and the grabber. 3:1 or more on every ground.
- `card-line`, `card-rim`: the soft hairline edge of a map card. It is decorative: a card is identified by its name and its fill, and the selected card has a 2px `accent` ring (3:1 or more).
- `float-line`: the soft rim of glass and of floating layers. It is decorative: a floating layer stands out by its fill and `shadow-float`, and each control in it keeps its own edge or fill.
- `sheet-edge`: the top edge of the review sheet.

**Action**

- `accent`: the one primary action, links, the selected card ring, selected edges and the focus ring (`focus`). Ink black in light, mint in dark.
- `accent-subtle`: the ground of a selected row or chip.
- `on-accent`: text and icons on an `accent` fill.

**Strata**

- `layer-1`, `layer-2` and their `-line` tokens: the two strata under a changed folder card. Ochre and rust with ink lines in light, teals in dark. They mark a folder's layers only, never a status.

**State**

- `added`, `removed`, `modified`: Git status, with `+`, `−` and `~`.
- `added-tint`, `removed-tint`: the ground of a whole diff line. The text on it stays `ink`, so syntax colours still read.
- `added-word`, `removed-word`: the ground of the changed words inside a diff line.
- `danger`, `danger-tint`: rule breaks and destructive actions.
- `warning`: a task or a session that needs the owner.
- `success`: approved, merged, passed.
- `edge`: dependency lines on the map.
- `syntax-string`: strings and numbers in code only.
- `scrim`: behind a modal dialog only.

## Rules

- One accent: ink in light, mint in dark. Colour in the light theme comes only from the strata and the status marks.
- A status colour is never a large fill. It colours a glyph, a count, an edge or a thin tint.
- Diff lines tint the ground only. Text in a diff stays `ink`.
- In the dark themes, show depth with lighter grounds (`surface`, then `surface-raised`) and a rim of light on cards.
- The dark ground is `#030505`, almost black. Glass in dark is dark too, so the cards and the pop-ups stand out.
- The colour-blind safe themes change `added`, `removed` and `success` only. Added is blue and removed is orange. Every other token stays the same.

## Contrast

Every pair below meets WCAG 2.2 AA in all four themes. Text needs 4.5:1. Lines, edges, focus rings and icons that carry meaning need 3:1. The ratios come from the token values.

| Text or mark | Ground | Light | Dark | Light CB | Dark CB | Needs |
|---|---|---|---|---|---|---|
| `ink` | `surface` | 16.79 | 15.57 | 16.79 | 15.57 | 4.5:1 |
| `ink` | `canvas` | 14.77 | 17.98 | 14.77 | 17.98 | 4.5:1 |
| `ink` | `surface-sunken` | 15.46 | 16.64 | 15.46 | 16.64 | 4.5:1 |
| `ink` | `surface-raised` | 16.79 | 14.48 | 16.79 | 14.48 | 4.5:1 |
| `ink` | `added-tint` | 14.64 | 12.50 | 14.28 | 13.30 | 4.5:1 |
| `ink` | `removed-tint` | 14.41 | 14.00 | 14.79 | 12.94 | 4.5:1 |
| `ink` | `added-word` | 13.92 | 8.83 | 14.14 | 8.76 | 4.5:1 |
| `ink` | `removed-word` | 10.98 | 9.92 | 11.59 | 8.78 | 4.5:1 |
| `ink-muted` | `surface` | 6.28 | 7.79 | 6.28 | 7.79 | 4.5:1 |
| `ink-muted` | `canvas` | 5.53 | 9.00 | 5.53 | 9.00 | 4.5:1 |
| `ink-muted` | `surface-raised` | 6.28 | 7.25 | 6.28 | 7.25 | 4.5:1 |
| `ink` | `surface-popup` | 16.79 | 12.88 | 16.79 | 12.88 | 4.5:1 |
| `ink-muted` | `surface-popup` | 6.28 | 6.45 | 6.28 | 6.45 | 4.5:1 |
| `ink-subtle` | `surface-popup` | 5.55 | 4.89 | 5.55 | 4.89 | 4.5:1 |
| `accent` | `surface-popup` | 5.82 | 9.13 | 5.82 | 9.13 | 4.5:1 |
| `ink-subtle` | `surface` | 5.55 | 5.91 | 5.55 | 5.91 | 4.5:1 |
| `ink-subtle` | `surface-sunken` | 5.12 | 6.31 | 5.12 | 6.31 | 4.5:1 |
| `ink-subtle` | `canvas` | 4.89 | 6.82 | 4.89 | 6.82 | 4.5:1 |
| `accent` | `surface` | 5.82 | 11.03 | 5.82 | 11.03 | 4.5:1 |
| `on-accent` | `accent` | 5.82 | 11.88 | 5.82 | 11.88 | 4.5:1 |
| `added` | `surface-raised` | 5.82 | 10.26 | 6.61 | 7.66 | 4.5:1 |
| `removed` | `surface-raised` | 6.45 | 7.52 | 6.06 | 8.05 | 4.5:1 |
| `modified` | `surface-raised` | 6.11 | 9.99 | 6.11 | 9.99 | 4.5:1 |
| `danger` | `danger-tint` | 5.54 | 7.27 | 5.54 | 7.27 | 4.5:1 |
| `syntax-string` | `surface-sunken` | 5.63 | 11.49 | 5.63 | 11.49 | 4.5:1 |
| `syntax-string` | `added-word` | 5.07 | 6.09 | 5.15 | 6.04 | 4.5:1 |
| `accent` | `added-word` | 4.83 | 6.25 | 4.90 | 6.20 | 4.5:1 |
| `edge` | `canvas` | 3.41 | 3.81 | 3.41 | 3.81 | 3:1 |
| `line-strong` | `surface` | 3.54 | 3.49 | 3.54 | 3.49 | 3:1 |
| `focus` | `surface` | 5.82 | 11.03 | 5.82 | 11.03 | 3:1 |

In the default themes, added green and removed red have almost the same lightness (1.1:1). That is why the `+` and `−` glyphs are required, and why the colour-blind safe themes exist.

## Do not

- No gradients and no colour washes. The only glow is `shadow-agent`, on the card where an agent works in dark.
- No colour for a category ("folders blue, files green"). The strata under folders are a shape in the brand colours, not a category colour.
- No white text on `added`, `removed` or `modified`.
- No `ink-subtle` text below 12px, and no text in `line` or `edge` colours.
