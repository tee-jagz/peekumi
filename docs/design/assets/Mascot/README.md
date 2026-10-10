Peek, the Peekumi mascot, copied from `frontend/peek.js` in its resting (idle) state. Never redraw it.

- `peek.svg`: Peek with no ground. Use it on `surface`, `canvas` and the dark grounds: empty states, pairing, loading, the first merge.
- `peek-tile.svg`: Peek on its rounded `brand-deep` tile. Use it for the app icon and the home screen icon only.

Colours are fixed in the art (teal dome, the `brand-mint`, `brand-sand` and `brand-clay` layers). An `<img>` cannot recolour it. The app animates Peek with CSS classes in `frontend/peek.js`; these files are the still art. Rules for where Peek appears are in **Peek**.
