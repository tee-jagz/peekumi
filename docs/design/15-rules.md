# Rules

Every screen obeys these rules. A rule marked **lint** is checked by a tool in CI. The others are checked in review, with the phone and desktop screenshots.

## Values

- **R1 (lint).** Colours come from tokens only. No hex, `rgb()` or named colour in component CSS.
- **R2 (lint).** Font sizes come from the type styles only: 12, 13, 14, 16, 18, 20, 22 and 24px.
- **R3 (lint).** Font weights are 400 or 600.
- **R4 (lint).** Spacing (`padding`, `margin`, `gap`) uses the spacing tokens only, or 0, 1px and 2px for hairlines and fine alignment.
- **R5 (lint).** Radii use the radius tokens only.
- **R6 (lint).** `box-shadow` is a shadow token or none: `shadow-float` on floating layers, `shadow-sheet` on the sheet, `shadow-strata` on a changed folder card, `shadow-agent` on the agent's card.
- **R7 (lint).** `backdrop-filter` appears only on the parts that float: the map frame, the floating map controls, the review sheet and the composer.
- **R8 (lint).** No gradients (`linear-gradient`, `radial-gradient`) in component CSS.
- **R9 (lint).** No `!important`, except the `[hidden]` rule and the reduced-motion rule that stops all animation.
- **R10 (lint).** Each selector is declared once. No later section that overrides an earlier one.

## Layout and touch

- **R11.** Every touch target is 44 × 44px or more, with 8px or more between targets.
- **R12.** Each view has at most one primary button, at the bottom of the sheet or in the composer.
- **R13.** Every text field is 16px.
- **R14.** The page never scrolls sideways at 320px. Only code blocks scroll sideways.
- **R15.** Every drag has a tap alternative.
- **R16.** Back closes a page or lowers the sheet before it leaves the view.

## Colour and status

- **R17.** Every status has a glyph, a line style or a word as well as its colour.
- **R18.** A status colour never fills a large area. Diff tints are the only status grounds.
- **R19.** Text and marks meet the contrast in **Colour** in all four themes.
- **R20.** The dashed border means removed only.

## Content

- **R21.** No paragraph under a heading to explain the screen.
- **R22.** Labels have one to three words; buttons are verbs.
- **R23.** A `MetaLine` has at most two items.
- **R24.** No emoji and no text glyphs as icons ("×", "‹", "›", "✓", "✗").
- **R25.** Errors are inline, say what failed and what to do, and never fade.
- **R26.** Long waits (10 seconds or more) show the step and the time.

## Peek

- **R27.** At most two Peeks on a screen, only in the places in **Peek**, and at most one of them moves.
- **R28.** No Peek in diffs, source, approval prompts, merge dialogs, inline errors, list rows or the Tasks button.
- **R29.** Peek is `aria-hidden` and never talks.

## Accessibility

- **R30.** Every interactive part has an accessible name that includes its visible label.
- **R31.** Every focusable part shows the 2px `focus` ring.
- **R32.** Reduced motion turns moves into cross-fades and stops loops.
- **R33.** The map has its list view.

## Components only

These rules keep the interface on the parts of `frontend/ui.js`. `scripts/lint-ui.mjs` checks them in `npm run lint`.

- **R37 (lint).** Only the component modules (`ui.js`, `peek.js` and `icons.js`) make elements. Another module calls a part of `ui.js`. It never calls `document.createElement` or a helper that makes elements.
- **R38 (lint).** No markup from strings outside the component modules: no `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`.
- **R39 (lint).** No class names and no inline styles outside the component modules. A part takes its state as an argument.
- **R40 (lint).** No native dialogs: no `alert`, `confirm` or `prompt`. Use `Dialog`.
- **R41 (lint).** `index.html` holds only `pk-` classes and mount points. No new stylesheet rules outside `ui.css`.
- **R42 (lint).** Every `pk-` class that `ui.js` uses exists in `ui.css`, and every rendered part has an accessible name (`test/ui.test.mjs`).
- **R43 (review).** Every pop-up (menu, select list, popover, dialog, sheet) has the `surface-popup` ground and `shadow-popup`, so it stands clear of the page in both themes.
- **R44 (review).** When a pop-up scrolls, its header with its controls (Close, Back, Refresh) stays at the top. The content scrolls under it.

The app still has UI from before the components. `scripts/ui-baseline.json` records it for each file. A count above the baseline fails, so new code must use the parts. When a screen moves to the parts, its count goes down. Then `node scripts/lint-ui.mjs --update` writes the lower number, and the debt cannot come back.

## Process

- **R34.** A new component needs a row in **Components** first, then its function in `frontend/ui.js` and its preview in `tools/gallery.mjs`.
- **R35.** A new token needs an entry in `tokens.json` with a usage note and a contrast check.
- **R36.** Run `npm run test:browser` and look at the phone and desktop screenshots for each change to the interface.
