# Looks

The first version of this system removed the signs of a generated interface, and it removed too much. The second version ("Survey" in light) put a black 1px box around every part. It looked like a wireframe and like a common template. The third version (glass strata) put glass on a flat ground, and the glass looked like grey panels. This section records the current look, frosted glass on a Tide field, and the reasons for it.

The mockups for this look show the real app with each field, in light and in dark. They show the map, a selection with its lines, a diff and a pop-up.

## The look: frosted glass on Tide

It comes from the first Peekumi mockup (`docs/context/repo-strata-context.zip`). `AGENTS.md` names that mockup as the visual reference: glass surfaces, curved dependency lines and a zoom into the code.

- **A colour field on the ground.** Sky blue at the top, deep teal at the bottom and a small warm glow in one corner. The base is cool grey (`canvas` #e8eeed) in light and near-black (#04080a) in dark. The shapes fade with eased stops, and fine grain sits on top, so no edge or step shows. The field carries no meaning.
- **Frosted glass.** The map frame and the sheet blur the field strongly, with more saturation. Glass is lighter at the top, has a thin light rim and a top highlight, and casts a soft shadow.
- **Glass on glass.** Changed map cards are frosted glass too, so the lines behind them blur. Buttons, tabs and fields in the sheet are flat frost with a faint rim, so the field colour shows through. The open tab is a little more frost in its groove: white in light and faint teal in dark. Send is the flat accent.
- **Four colours carry meaning.** Neutral is for the ground, glass, text and lines. Teal is for actions, the selection and added code. Amber is for modified, and red is for removed and rule breaks. Peek keeps its own colours and shading.
- **Change shows by contrast, not by tint.** A changed card is clear glass that lifts. An unchanged card is a thin frost with no shadow and less opacity. Counts are plain coloured numbers, not badges.
- **Pop-ups stay solid.** Menus, popovers and dialogs use `surface-popup` and a deep shadow, so they read over anything.
- **Icons in place of label words.** The sheet tabs show an icon; the open tab also shows its name. The tray is an icon with a count. The agent in the dock is a small, still Peek. Words stay on actions: Fix, Start task, Add as a change, Allow once.
- **Round, soft shapes.** Cards and menus use `radius-md` (16px). The map frame and the sheet use `radius-lg` (26px). Icon buttons, map controls, the composer field and segmented controls are pills.
- **Type.** Host Grotesk for the interface and the names, JetBrains Mono for code, paths and hashes.

## What changed after review

- Stacked commit sheets behind the map were removed. They took space and did nothing that the commit rail does not do.
- The colours that carry meaning went from nine to four.
- The agent's gradient edge became one solid accent line with a faint halo.
- Tinted cards and tinted chips were removed in favour of contrast.
- The cards keep the elements that they had: icon, name, a two-line description, the change counts, the file count and the change bar.
- On a flat ground, the glass looked like grey panels. The owner preferred the earlier glass and colour field. The field came back as smooth shapes with grain, not as round blobs with hard edges.
- The glass became frosted: a stronger blur, a top highlight and a rim. Map cards and the buttons in the sheet became glass too.
- Glossy grey gradients on buttons and on the open tab looked like plastic. They became flat frost that takes the colour behind it.

## Candidates that were removed

- **Warm cream, paper and a soft serif.** This mix is now the house style of many AI products.
- **Survey** (white paper, black 1px boxes, hard ink shadows). It looked like a wireframe and like a common template.
- **Geologic sheet, drafting sheet and instrument.** They were plain, or they borrowed a look that other products own.
- **Luminous** (true black and white with rims of light). It was polished, but less Peekumi than glass.
- **The old field** (four round blobs with hard edges at 70%). Where peach met blue, the colour became muddy, and the edges showed.
- **The Strata field** (tilted layers of blue, sand, sage and teal). In light, its sand band was large and warm, close to the cream look.
- **The Lumen field** (almost one colour, with one glow). It was calm, but it gave the glass little to show.

## Contrast

**Colour** lists every text and mark pair in the four themes, from the token values. It also gives the worst case for text on glass. Every pair meets WCAG 2.2 AA where that text can appear.
