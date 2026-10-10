# Type

## Families

- **Interface and display:** `Host Grotesk` (family key `ui`), weights 400 and 600. It sets the interface text and the display styles: the repository name, page titles and the selection's name.
- **Code:** `JetBrains Mono` (family key `mono`), weights 400 and 600. It sets code, paths, hashes and counts.

Peekumi serves both families itself (`frontend/fonts`, SIL Open Font License), so the app works offline and the Content Security Policy stays `'self'`. Host Grotesk has open, even shapes that read well at small sizes on a phone. JetBrains Mono separates 0 and O, 1, l and I, which matters for commit hashes and paths.

Fallbacks: the system font (`-apple-system`, `Segoe UI`, `system-ui`) and the system mono (`ui-monospace`, `SF Mono`, `Menlo`, `Consolas`).

## Scale

Use these twelve styles only.

| Style | Size / line | Weight | Use |
|---|---|---|---|
| `display-lg` | 24 / 30 | 600, ui | The repository name in the header. |
| `display` | 22 / 28 | 600, ui | The title of a page or a dialog. |
| `display-sm` | 18 / 24 | 600, ui | The selection's name in the sheet, and the line of an empty state. |
| `title-lg` | 20 / 26 | 600 | A large heading inside a page, where `display` is too strong. |
| `title` | 16 / 22 | 600 | The selection's name, the main line of a row, section headings. |
| `body` | 16 / 24 | 400 | Reading text (answers, instructions, notes) and every text field. |
| `body-sm` | 14 / 20 | 400 | Rows, lists, details. The workhorse. |
| `label` | 14 / 20 | 600 | Buttons, tabs, segments and card names on the map. |
| `caption` | 12 / 16 | 400 | Meta lines and counts. The smallest size. |
| `figure` | 20 / 24 | 600, mono | The one key number of a row or a view. |
| `code` | 13 / 20 | 400 | Source and diff lines, commands, rule JSON. |
| `code-sm` | 12 / 16 | 400 | Hashes, paths and line numbers in meta lines. |

## Rules

- Nothing is smaller than 12px. The old sizes of 9, 10, 10.5, 11 and 11.5px are removed.
- Every text field (the composer, instruction text, rule edits) is 16px. Below 16px, iOS Safari zooms into the field.
- Use weights 400 and 600 only. Do not use 500, 650, 700 or 800.
- Use `font-variant-numeric: tabular-nums` for counts, line numbers, times and diff statistics.
- Keep reading text to `measure` (68 characters) or less.
- Use `mono` for code, paths, hashes, commands and rule IDs only. Never for labels or headings.
- Headings use `text-wrap: balance`.
- The layout must not break when the owner sets line height to 1.5 times, or letter spacing to 0.12 em (WCAG 1.4.12).
- Never set `user-scalable=no`.
