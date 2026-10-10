# Code

Source and diffs are the most important content in Peekumi. They get the most contrast and the least decoration.

## Diffs

- On a phone, show a unified diff. Side by side starts at 768px wide.
- Each line: two line-number columns in `code-sm`, `ink-subtle`, then the sign (`+`, `−` or a space), then the code in `code`, `ink`.
- An added line has the `added-tint` ground. A removed line has the `removed-tint` ground. The changed words inside the line have `added-word` or `removed-word`.
- The text colour in a diff stays `ink`. Only the ground shows the change.
- A hunk header (`@@ -12,6 +12,8 @@`) is `code-sm` in `ink-muted` on `accent-subtle`.
- Show 3 lines of context around a change. Hidden lines show as one row, "Show 24 lines", that opens them.

## Source

- The block has the `surface-sunken` ground, `radius-sm`, and padding `space-3`.
- Line numbers are in `ink-subtle`, right-aligned with `tabular-nums`.
- The selected declaration has `accent-subtle` on its lines and a 2px `accent` rule at the left of the code.

## Scroll and wrap

- Do not wrap code. A long line scrolls inside the code block.
- The line-number gutter stays fixed while the code scrolls sideways.
- The page itself never scrolls sideways (WCAG 1.4.10).

## Syntax colours

Use four colours at most, and keep most code in `ink`.

- Comments: `ink-muted`.
- Strings and numbers: `syntax-string`.
- Top-level definitions (function and type names where they are defined): `accent`.
- Never use a status colour (`added`, `removed`, `modified`, `danger`) for syntax. Those colours mean a state.
- Keywords, calls, variables and punctuation: `ink`.
- No bold and no italic.

## In the composer and in answers

- Inline code (a name, a path) is `mono` at the text size, on `surface-sunken`, with `radius-xs`.
- A code span that names one file or declaration links to the map. It has a dotted underline in `accent`.
