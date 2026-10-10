# Current state

An audit of the app's interface (`frontend/`) on 9 October 2026 found these facts. They explain why the app looks generated, and they set the work to move it to this system.

## What the numbers show

| Measure | Now | This system |
|---|---|---|
| Font sizes | 19 (9 to 24px; 11px used 35 times) | 5 sizes, 12px minimum |
| Font weights | 6 (400 to 800) | 2 |
| Radii | 21 single values | 5 |
| Shadows | about 25 values | 1 |
| Backdrop blurs | 16 blurs with 9 values, on every button and every map card | 1, on two parts |
| Padding values | 101 | 7 spacing steps |
| `!important` | 112, 82 of them to undo glass | 0 |
| Selectors declared more than once | 115 (`.panel` 6 times) | 0 |
| Explanation paragraphs (`read-note`) | 49 | 0 |
| Lines with " · " meta strings | 81 | Two items at most |
| Peek sizes | 15 (16 to 76px), on the Tasks button, the live line, notices and task heads | 6 sizes, 8 places |

## Faults that users can see

- A global rule gives every `button` a 16px backdrop blur, and map cards are buttons. So every card is glass, against the frontend README.
- The map ground has four pastel radial gradients (the "wall"). This is the strongest sign of a generated interface.
- Contrast fails: `--faint` text is 2.21:1 on white (line numbers, keys, chevrons). `--good` text is 2.22:1 (the live line at 12px). `--del` break counts are 3.55:1. The edge stroke is 2.46:1.
- Touch targets under 44px: the clear button (24px), the comparison summary (26px), map buttons (36px, 32px on small phones), "Back to task" (28px), the composer mode tabs (34px), and others.
- A dashed outline means three things: a stub neighbour, a removed card and uncommitted changes.
- Text glyphs are used as icons ("×", "‹", "›", "✓", "✗"), although `icons.js` has the icons.
- Some styles undo earlier styles: the Ask answer bubble, the session approval card and the relation list each have two or three opposite definitions.

## The move to this system

1. **Foundations.** Replace the `:root` tokens with `tokens.json` (through a generated `tokens.css`). Load the two font families (now Host Grotesk and JetBrains Mono). Remove the wall gradients. Glass is for the parts that float (**Looks**).
2. **Lint.** Add a stylelint configuration for rules R1 to R10, and run it in CI. Fix what it finds.
3. **Components.** The parts are in `frontend/ui.js`, and `npm run lint` stops new UI outside them (R37 to R42). Next, move each screen onto them, one screen at a time: header, map cards, sheet, composer, tasks, code, then the pages. Each move lowers the counts in `scripts/ui-baseline.json`.
4. **Words.** Remove the explanation paragraphs and the long meta lines (see **Writing**).
5. **Peek.** Move Peek to the places in **Peek**. Keep it in the live line and the task heads. Remove it from the Tasks button and the notices. Add the head over the agent's card.
6. **Docs.** Update `AGENTS.md` (the glass rule), `frontend/README.md`, the user guide screenshots and the memory notes on the minimal design.

Each step keeps the app working, and each one has its own commit and screenshots.
