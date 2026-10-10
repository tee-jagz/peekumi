# Looks

The first version of this system removed the signs of a generated interface, and it removed too much. The second version ("Survey" in light) put a black 1px box around every part. It looked like a wireframe and like a common template. This section records the current look, glass strata, and the reasons for it.

The high-fidelity mockups of this look show 7 screens, in light and in dark. They are the map, a folder and its changes, a file's diff, Ask, the send sheet, a live session and Time mode.

## The look: glass strata

It comes from the first Peekumi mockup (`docs/context/repo-strata-context.zip`). `AGENTS.md` names that mockup as the visual reference: glass surfaces, curved dependency lines and a zoom into the code.

- **A flat ground.** Cool grey (`canvas` #eef1f0) in light, almost black (#030505) in dark. No gradient and no colour field.
- **Glass where parts float.** The map frame, the review sheet, the composer and the floating controls are glass with a soft rim (`float-line`). Cards and rows are not glass.
- **Four colours.** Neutral (the ground, glass, text and lines), teal for actions, the selection and added code, amber for modified, and red for removed and rule breaks. Peek keeps its own colours and shading.
- **Change shows by contrast, not by tint.** A changed card is a clear card that lifts a little (`shadow-strata`). An unchanged card fades into the ground: no fill, no shadow, a hairline edge and less opacity. Counts are plain coloured numbers, not badges.
- **Icons in place of label words.** The sheet tabs show an icon; the open tab also shows its name. The tray is an icon with a count. The agent in the dock is a small, still Peek. Words stay on actions: Fix, Start task, Add as a change, Allow once.
- **Round, soft shapes.** Cards and menus use `radius-md` (16px). The map frame and the sheet use `radius-lg` (26px). Icon buttons, map controls, the composer field and segmented controls are pills.
- **Type.** Host Grotesk for the interface and the names, JetBrains Mono for code, paths and hashes.

## What changed after review

- Stacked commit sheets behind the map were removed. They took space and did nothing that the commit rail does not do.
- The colour field behind the glass was removed, and the colours went from nine to four.
- The agent's gradient edge became one solid accent line with a faint halo.
- Tinted cards and tinted chips were removed in favour of contrast.
- The cards keep the elements that they had: icon, name, a two-line description, the change counts, the file count and the change bar.

## Candidates that were removed

- **Warm cream, paper and a soft serif.** This mix is now the house style of many AI products.
- **Survey** (white paper, black 1px boxes, hard ink shadows). It looked like a wireframe and like a common template.
- **Geologic sheet, drafting sheet and instrument.** They were plain, or they borrowed a look that other products own.
- **Luminous** (true black and white with rims of light). It was polished, but less Peekumi than glass strata.

## Contrast

**Colour** lists every text and mark pair in the four themes, from the token values. All pairs meet WCAG 2.2 AA.
