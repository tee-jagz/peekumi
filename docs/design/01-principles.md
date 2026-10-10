# Principles

These seven principles decide every design question in Peekumi. When two rules conflict, the earlier principle wins.

## 1. Content first

The owner opens Peekumi to see code and change. The map, the source and the diff get the strongest contrast and the most space. Chrome stays quiet.

- Do: `ink` for code and card names, `ink-muted` for labels and meta.
- Do: hairlines (`line`) between rows, no boxes around groups.
- Do not: frosted panels around lists, coloured icon backgrounds, borders on every card.

Sources: Sourcegraph ("code as content"), Linear 2026 ("structure should be felt not seen").

## 2. Colour means something

A colour is a state. The owner learns it once, and it means the same thing on every screen.

| Meaning | Token | Glyph or word |
|---|---|---|
| Added | `added` | `+` |
| Removed | `removed` | `−`, and a dashed edge |
| Modified | `modified` | `~` |
| Unchanged | `ink-subtle` | none |
| Rule break | `danger` | broken-link icon |
| Needs the owner | `warning` | "Needs you" |
| Approved, merged, passed | `success` | check icon or the word |
| The one primary action, selection, focus | `accent` | Not needed: it marks an action, not a state |

- Do not: tint whole cards, use a gradient, or give a colour to a category ("folders are blue").

Sources: GitHub Primer functional colour, Atlassian ("never communicate meaning with colour alone").

## 3. Never colour alone

About 1 man in 12 sees red and green as one colour. Every status therefore has a second channel: a glyph, a line style or a word. Two colour-blind safe themes also move added to blue and removed to orange.

Source: WCAG 2.2 1.4.1, GitHub colour-blind themes.

## 4. One primary action

Each view has at most one filled button (`accent` with `on-accent`). It is the next step of the owner's job in that view: "Propose fixes", "Approve", "Merge into main", "Send".

- Put it at the bottom of the sheet or in the composer, in the thumb zone.
- Never put a destructive action next to Close in a top corner.
- Other actions are plain buttons or text links.

## 5. Show the state, not an explanation

A screen that needs a paragraph to explain itself has a design fault. Fix the design.

- Use a label, a number and a state: "20 breaks", "Ready for review", "3 files".
- Put help only where the next step is not clear: in an empty state, or behind an info control.
- Keep each label to one to three words.

## 6. Summary before detail

Order every view the same way:

1. The state and the key number (`figure`).
2. The list (rows of `body-sm`).
3. The detail (source, diff, rule JSON) on request.

Do not use more than two levels of disclosure (NN/g).

## 7. Every state is designed

Design empty, loading, working, error, offline and done before anything else. **States** gives the look of each one.

## What this system removes

These patterns made the old interface look generated. Do not use them.

- Pastel colour washes or gradients behind the map.
- Glass on cards, buttons, rows and lists.
- A paragraph under each heading that explains the screen.
- Meta lines with many items joined by " · ". Use two items at most, or separate fields.
- Many sizes (the old app used 19 font sizes and 21 radii).
- A mascot that decorates and shows no state. Peek shows a state, or it does not appear.
- Text glyphs as icons ("×", "‹", "›").
