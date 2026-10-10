# Space and shape

## Spacing

A 4px base. Use the seven steps only.

| Token | Value | Use |
|---|---|---|
| `space-1` | 4px | Icon to its label, inside a chip. |
| `space-2` | 8px | Between related items in a row, a title and its caption. |
| `space-3` | 12px | Card padding on the map, between rows of a dense list. |
| `space-4` | 16px | The page gutter, sheet padding, between groups. |
| `space-5` | 24px | Between sections of a sheet page. |
| `space-6` | 32px | Around an empty state, before the primary action at the end of a page. |
| `space-7` | 48px | Between sibling cards at the folder level of the map. |

- Lay out groups with flex or grid and `gap`. Do not stack margins.
- The side gutter is `space-4` at every width.
- A row has `space-3` vertical padding and a minimum height of `tap` (44px).

## Radius

| Token | Value | Use |
|---|---|---|
| `radius-xs` | 4px | Inline marks: code highlights and keys. |
| `radius-sm` | 12px | Buttons, fields, chips, code blocks and rows with a fill. |
| `radius-md` | 16px | Map cards, menus, popovers and dialogs. |
| `radius-lg` | 26px | The map frame and the top corners of the review sheet. |
| `radius-full` | 999px | Circles and pills: icon buttons, the composer field, the send button, map controls, segmented controls and the grabber. |

- A smaller part never has a larger radius than the part that holds it.
- Rows in a list have no radius and no box. A hairline (`line`) separates them.

## Depth

There are three levels.

1. **The page.** The flat `canvas` ground. The map frame and the sheet are glass on it.
2. **The floating layer.** Map controls and toasts use `shadow-float`, a soft and short shadow, and a `float-line` rim. The review sheet uses `sheet-edge` and `shadow-sheet`.
3. **Pop-ups.** Menus, select lists, popovers, dialogs and the Agents sheet use the `surface-popup` ground and `shadow-popup`, a deeper shadow with a faint rim in dark. A pop-up's header with its controls stays at the top while its content scrolls.

A changed card on the map lifts a little with `shadow-strata` and has a hairline `card-line` edge. An unchanged card has no shadow and no fill, and fades into the ground. The card where an agent works has a 1.5px `accent` edge and `shadow-agent`, a faint accent halo. A selected card has a 2px `accent` ring, 3px outside the card.

## Glass

Glass is allowed on two parts only: the review sheet and the composer. They float over the map, and the map stays visible behind them.

- Ground: `glass`. Blur: `blur-glass` (20px).
- Text on glass meets 4.5:1 against the darkest card or canvas that can sit under it. With the `glass` opacity of 0.88, `ink` and `ink-muted` pass on every map ground, also over card text.
- Do not put `ink-subtle` text directly on glass. Over dark card text in the light theme, it reaches only 4.45:1. Put such text on an opaque `surface` row.
- If the browser has no `backdrop-filter`, use `surface`.
- Nothing inside the sheet is glass again: rows, lists, buttons, fields and code blocks are opaque.
- No gradient on glass and no glossy highlight.
