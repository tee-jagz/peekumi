# The map

The map is Peekumi's main surface: one SVG canvas with cards for folders, files and declarations, and curved lines for their dependencies. It follows Shneiderman's order: overview first, zoom and filter, then details on demand.

## Zoom levels

The map shows one level of the real folder tree at a time. Opening a card zooms into it.

| Level | A card shows | Hidden |
|---|---|---|
| Repository and folders | Name, the change counts (`+ ~ −`), the file count, rule breaks | Descriptions longer than two lines |
| Files | Name, the status glyph, the declaration count, rule breaks | Declaration list |
| Declarations | Name with `()` for functions, kind, the changed parts | Nothing |

- A label that would show smaller than 12px fades out. It never shrinks below 12px.
- Never invent a layer. The levels are the repository's real folders.

## Cards

- A changed card has a `surface-raised` ground, a hairline `card-line` edge, `radius-md` and a small lift (`shadow-strata`). No glass and no tint.
- An unchanged card fades into the ground: no fill, no shadow, a `line` edge, less opacity, and its name in `ink-muted` at weight 400. So the changed cards stand out first. Change shows by contrast, not by colour.
- Name in `label`, two lines at most. Meta and counts in `caption`, `ink-muted`.
- A changed folder card ends with the change bar: one 6px pill that splits its files into added, modified, removed and unchanged parts. It shows how much of the folder changed. It is `aria-hidden`, because the counts above it carry the same facts.
- The map ground has a dot grid: 1px dots every 16px in `line-strong` at `dim` opacity. It shows that the canvas moves.
- The hit area is at least 44 × 44px, also when the drawn card is smaller.
- The object-type icon (folder, file, function, class) is `icon-sm` in `ink-muted`.

## Status on a card

Each status has a colour and a second channel.

| Status | Mark |
|---|---|
| Added | `+` count in `added` |
| Modified | `~` count in `modified` |
| Removed | `−` count in `removed`; a removed card has a dashed `line-strong` border and a struck-through name |
| Unchanged | No mark; name in `ink-muted` |
| Rule breaks | Broken-link icon and the count in `danger`, at the right of the name row |
| Uncommitted changes | A 6px `warning` dot after the name, and the word "uncommitted" in the sheet |
| An agent works here | An `accent` border, and Peek's head (the `working` state) looks over the top edge of the card |

- The old dashed border for uncommitted changes is removed. A dashed border means "removed" only.
- Never tint the whole card for a status.

## Edges

- Curved lines that follow the folder tree, 1.5px, in `edge`.
- Imports are solid. Calls are solid. Implements and inherits are dotted. The key shows each style.
- A line that adds a rule break is `danger`, dashed, with the broken-link icon at its middle.
- A removed dependency is dashed in `removed`. An added one is solid in `added`.
- When a folder is closed, its child lines become one line with a count.
- Lines do not move while they redraw.

## Selection

- A selected card has a 2px `accent` ring.
- The selected card and its direct neighbours stay at full opacity. Everything else dims to `dim` (0.25).
- Incoming lines are solid and outgoing lines are dashed, so direction does not depend on colour.
- The sheet shows the selection at once.

## Controls

- Map controls float at the bottom edge of the map: Home, Up, Changes only, Zoom out, Zoom in, Fit, and the Key. Each is 44px.
- The key shows the status marks and the line styles. It is a popover with `radius-md` and `shadow-float`.
- The Before and After control sits at the top left of the map.

## A text alternative

The map has a list view of the same tree for screen readers and one-hand use. Each row gives the name, the status, the counts and the rule breaks, and it opens the same selection.
