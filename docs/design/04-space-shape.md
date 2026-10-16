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

There are four levels.

1. **The ground.** The `canvas` base colour, the `field` (Tide) on it and fine grain on top. The ground is the only place for the field.
2. **Frosted glass.** The map frame and the review sheet are frosted glass (`glass`, `glass-strong`) with `blur-glass`. Glass is lighter at the top and has a thin `float-line` rim and a top highlight. It casts `shadow-glass`, and the sheet casts `shadow-sheet` up over the map.
3. **Glass parts.** Map cards, buttons, tabs and fields are glass on glass. A changed card is `glass-card` with `blur-card`, so lines behind it blur, and it lifts with `shadow-strata`. A button is `glass-control` with `shadow-control`. The open tab or selected segment is `glass-control-on`, raised in a `glass-groove` track. A text field is a `glass-groove` with a `line-strong` edge.
4. **Pop-ups.** Menus, select lists, popovers, dialogs and the Agents sheet use the solid `surface-popup` ground. They cast `shadow-popup`, a deeper shadow with a faint rim in dark. A pop-up's header with its controls stays at the top while its content scrolls.

Change shows by contrast. A changed card is clear glass that lifts. An unchanged card is a thin frost (`glass-card-quiet`) with no shadow and less opacity, so it fades into the frame. The card where an agent works has a 1.5px `accent` edge and `shadow-agent`, a faint accent halo. A selected card has a 2px `accent` ring, 3px outside the card.

## Glass

- **Where.** Blur (`backdrop-filter`) is allowed on the map frame, the floating map controls, the review sheet, the composer and changed map cards. A clear card (unchanged, stub or boundary) does not blur. Inside the frosted frame, a blur sees only the frame's own fill, so a clear card would turn dark.
- **Buttons.** Buttons, tabs and fields are frost: a flat, clear fill with no gradient, so the colour behind them shows through. A faint inner rim and a top highlight come from `shadow-control`. The selected piece is white frost in light and a faint teal frost in dark.
- **The recipe.** On the frame, the sheet and cards, the fill is lighter at the top. The rim is thin and light (`float-line` or `card-line`). The shadow token holds a top highlight and a soft shadow. Blur uses `saturate(180%)` on large glass and `saturate(170%)` on cards.
- **Text.** Text on glass meets 4.5:1 in the worst case. That is the most saturated part of the field under the clearest part of the glass. See **Colour** for the pairs.
- **Never on the bare frame.** Do not put `ink-subtle` or `accent` text directly on the map frame. In light it reaches only 4.16:1 and 4.37:1 there. Put such text on a card, a row or the sheet.
- **Reduce transparency.** When the device asks for less transparency (`prefers-reduced-transparency`), glass becomes the solid surfaces and the field goes.
- **Pop-ups are not glass.** They stay solid so that they read over anything.
