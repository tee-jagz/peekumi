# Mockup generator

These scripts make the mockups in `../mockups/` and the file `frontend/tokens.css`. They use Node and no packages. Each mockup renders the real parts of `frontend/ui.js`.

- `dom.mjs` is a small DOM for Node. It lets `ui.js` run outside a browser and write its elements as HTML.
- `gallery.mjs` has one preview for each part: its group, its height, a short guide and its markup from `ui.js`.
- `screens.mjs` has the full screens. Each screen is one `AppShell`. The phone screens are 390 × 844px, and the desktop screen is 1280 × 800px.
- `make.mjs` writes the files.

## Make the mockups again

1. Change `../tokens.json`, `frontend/ui.js`, `frontend/ui.css` or a preview.
2. Run `node docs/design/tools/make.mjs` from the repository root.
3. Open `../mockups/screens.html` and examine each screen in all four themes.

To update the design system artifact too, give the folder of its components as an argument: `node docs/design/tools/make.mjs <folder>`.

Do not edit `frontend/tokens.css` or the files in `../mockups/` by hand. The next run replaces them.
