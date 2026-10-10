Peekumi is a map of a repository on your phone. You use it to see what a coding agent changed, from the whole repository down to one line. Then you ask about it, give instructions, and approve or merge the work. Each screen in this system serves that job: understand a change fast, and decide with confidence.

Read this page first. The sections after it give the detail for each topic. **Rules** lists the rules that every screen must obey. **Components** lists the parts that every screen must use.

## The idea in one line

The code and the change are the content. Everything else is quiet.

Peekumi's name comes from geology: strata are the layers of a rock face. Peek, the mascot, looks over three layers of sediment. The system keeps that idea. Calm ground layers, clear edges, and one strong signal where something changed.

## Principles

1. **Content first.** The map, the code and the diff have the strongest contrast. Chrome (headers, toolbars, sheets) stays quiet: `ink-muted` labels, `line` hairlines and no colour.
2. **Colour means something.** Use colour only for state: `added`, `removed`, `modified`, `danger`, `warning`, `success`, and `accent` for the one primary action. Never use colour as decoration.
3. **Never colour alone.** Every status also has a glyph or a word: `+` added, `−` removed, `~` modified, a broken-link icon for a rule break.
4. **One primary action for each view.** It uses `accent`, and it sits at the bottom of the sheet or the composer, where the thumb is.
5. **Show the state, not an explanation.** Do not put a paragraph under a heading to explain the screen. Use a short label, a number and a state.
6. **Summary before detail.** A count and a status come first, then the list, then the code.
7. **Every state is designed.** Empty, loading, working, error, offline and done states each have a defined look before any decoration.

## Content fundamentals

- Write in plain English with short sentences. Use the vocabulary of developers: commit, branch, diff, merge, rule.
- Use sentence case everywhere: "Propose fixes", not "Propose Fixes".
- Address the owner as "you" only when it helps ("You can leave this page"). Peekumi never says "we" or "I".
- Buttons are verbs, one to three words: "Approve", "Request changes", "Merge into main". A link to a page is a noun: "Tasks", "History".
- Errors say what failed and what to do: "Cannot reach Peekumi. Check that the server runs." No "Oops" and no apology.
- No emoji in the interface. No exclamation marks.
- Numbers are digits ("3 files"), with `tabular-nums` where they align.
- Peek never talks. No text is written in Peek's voice.

## Visual foundations

- **Colour.** The tokens in **Colour** are the only colours. A flat ground with glass on it: cool grey in light, near-black in dark. Four colours: neutral, teal for actions, the selection and added code, amber for modified, and red for removed and breaks. No gradient. Light and dark themes, plus two colour-blind safe themes in which added is blue and removed is orange. Every text and mark pair meets WCAG 2.2 in all four themes.
- **Type.** `Host Grotesk` for the interface and the display styles (names and titles), and `JetBrains Mono` for code, paths, hashes and counts. Peekumi serves both itself. Use the twelve type styles in **Type** only. Use weights 400 and 600 only. Nothing is smaller than 12px. Every text field is 16px.
- **Space.** A 4px base: `space-1` (4px) to `space-7` (48px). The page gutter is `space-4`.
- **Shape.** Soft radii: cards and menus `radius-md` (16px), the map frame and the sheet `radius-lg` (26px). Icon buttons, map controls, the composer field and segmented controls are pills.
- **Depth.** Two levels: the page, and the floating layer with a soft `shadow-float`. A changed card lifts a little with `shadow-strata`; an unchanged card fades. Rows have no shadow.
- **Glass.** The map frame, the sheet, the composer and the floating controls are glass (`glass`, `glass-strong`, `blur-glass`) with a soft rim. Cards and rows are not glass. No gradient is used anywhere, except Peek's own shading.
- **Motion.** 150ms for feedback, 250 to 300ms for the sheet and map moves, with a decelerating curve. With reduced motion, use cross-fades only.

## Iconography

- Use the icons of `frontend/icons.js` only: line icons on a 20-unit grid, one path each, stroke 1.7, round caps and joins, in `currentColor`.
- Show icons at `icon` (20px) in controls and at `icon-sm` (16px) in captions.
- Each icon button has an accessible name and a 44px target (`tap`).
- Do not use text glyphs ("×", "‹", "›", "✓") as icons. Use `close`, `back`, `chevron` and `check`.
- The status icons (added, changed, removed, unchanged) carry their colour and their glyph together.

## Logo and mascot

- The mark is Peek, in `assets/Mascot/`. Use `peek-tile.svg` for the app icon and `peek.svg` on light or dark ground. Copy them. Never redraw them.
- Peek shows the state of the app and of the agent: loading, working, needs you, ready, merged, empty, offline and others. **Peek** gives the places and the full rules.

## How to use this system

1. Take every value from `tokens.json`. Never write a hex value, a px size or a radius that is not a token.
2. Build every screen from the parts in `frontend/ui.js`. A new part needs a row in **Components** first. `npm run lint` fails when a module makes UI of its own (see **Rules**).
3. Check each screen against **Rules** before it ships.
4. **Current state** lists what the app does now, and the work to move it to this system.
5. **Flows** measures the main journeys and gives the flow rules F1 to F9. A change to a flow obeys them.
6. **Decisions** lists the choices that are open.

## Files

| File | Content |
| --- | --- |
| `01-principles.md` to `13-accessibility.md` | The foundations and the guidance for each topic. |
| `14-components.md` | The parts that every screen must use. |
| `15-rules.md` | The rules that every screen must obey. |
| `16-current-state.md` | What the app does now, and the work to move it to this system. |
| `17-decisions.md` | The open decisions. |
| `19-flows.md` | The main journeys, measured, with simpler flows and the flow rules. |
| `20-looks.md` | The Strata look: the reasons, the contrast and what changes. |
| `18-sources.md` | The research sources. |
| `tokens.json` | The source of all values. |
| `../../frontend/tokens.css` | The tokens as CSS custom properties. `tools/make.mjs` makes it. |
| `../../frontend/ui.js` | The components: one function for each part in `14-components.md`. |
| `../../frontend/ui.css` | The `pk-` classes of all components. Each value comes from a token. |
| `assets/Mascot/` | Peek and the app icon. |
| `mockups/` | One page for each component and each screen, rendered from `frontend/ui.js`. `tools/make.mjs` makes them. |
| `tools/` | The generator of the mockups. |

Open `mockups/index.html` in a browser to see each component. Open `mockups/screens.html` to see all screens. Add `?theme=dark`, `?theme=light-cb` or `?theme=dark-cb` to the address to see another theme.
