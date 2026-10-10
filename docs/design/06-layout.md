# Layout

## The phone shell

From top to bottom:

1. **Header.** The repository name (`title`), the comparison line (`code-sm`, `ink-muted`), and at most three header buttons: Time or Diff, Conversations, Tasks. Each button is 44px.
2. **Map.** The single SVG canvas fills the space between the header and the sheet. Map controls float on its lower edge.
3. **Review sheet.** A non-modal bottom sheet over the map, at one of three heights.
4. **Composer.** At the bottom of the sheet, above the keyboard when the keyboard is open.

There is no tab bar, no folder strip and no second canvas. The time rail of commit cards shows in Time mode only.

## The review sheet

The sheet shows the selection, and the pages that open from it (a task, Proposed fixes, Proposed rules).

| Height | Shows | When |
|---|---|---|
| Peek | The title row: status, name and kind, and the one key line (a rule break, the agent's state). | The owner looks at the map. |
| Half (about 55%) | The title row, the tabs (Details, Source, Changes, Relations) and the start of the content. | The default after a selection. |
| Full | Everything, to the bottom of the header. | Source, a diff, a task, a long list. |

- The grabber is 36 × 4px in `line-strong`, in a 44px tall target. A tap on it moves to the next height.
- The sheet is non-modal: no scrim, and the map stays usable above it.
- The content of the sheet scrolls in its own container, with `overscroll-behavior: contain`. A drag on the title row changes the height. A scroll in the content moves the content.
- Back closes a page of the sheet first, then lowers the sheet, and only then leaves the view.
- Every drag has a button alternative (WCAG 2.5.7): the grabber cycles the heights, and the map has zoom and pan buttons.
- Only one sheet shows at a time. A modal dialog (merge, commit, agents) opens over it.

## The composer

- It holds the mode control (Ask, Instruction, Session), the place it is about, the text field and the send button.
- The text field is 16px (`body`). It grows with its text up to 40% of the visible height, then it scrolls.
- The send button is a 44px circle at the bottom right, in `accent`. It is off while the field is empty.
- On a phone, Return adds a line and the send button sends. On a desktop, Return sends and Shift+Return adds a line. Set `enterkeyhint="send"`.
- When the keyboard opens, the composer follows the visual viewport, so it stays above the keyboard on iOS too.
- A draft stays through sheet moves and page changes.

## Safe areas

- Set `viewport-fit=cover`. Pad the header with `env(safe-area-inset-top)` and the composer with `env(safe-area-inset-bottom)`.
- Use `dvh`, never `100vh`, for heights.

## Desktop

From 900px wide:

- The map takes the left part, and the sheet becomes a right panel, 400 to 480px wide, full height.
- The panel has no heights and no grabber. It has the same pages and the same composer at its bottom.
- Diffs can show side by side from 768px wide (see **Code**).
- Controls on a fine pointer can be `control-fine` (32px) high. Targets on touch stay 44px.

## Header buttons

- Time or Diff is one segmented control with two segments.
- Conversations and Tasks are icon buttons with a name.
- When an agent works or a task needs the owner, the Tasks button shows a status dot (`accent` for working, `warning` for needs you). It does not show Peek.
