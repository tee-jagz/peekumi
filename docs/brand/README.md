# Peekumi brand

Peek is the Peekumi mascot: a round, one-eyed character looking over three layered lines, the layers of a repository it lets you see into.

- `peek.svg`: the mascot on a transparent background, for documentation and light or dark pages.
- `frontend/icon-192.png` and `frontend/icon-512.png`: the home-screen icons, Peek on a transparent square with a margin. They are declared `any`, not `maskable`, so Android places them on its own launcher shape (usually a light circle or squircle) and iOS fills the transparent area with black.
- `peekumi-icon.svg`: Peek on the dark, full-bleed tile, for places that need a solid square, such as store listings or social cards.
- `frontend/favicon.svg`: Peek on a transparent background, cropped to the artwork so it fills a browser tab; it reads on light and dark tab bars.

Colours: tile `#1b4a44` to `#0a1a19`, Peek `#78e2c0` to `#1a6553`, eye white with a `#0d2120` pupil, layers mint `#bff7e6` to `#68cfb0`, sand `#f5e2bf` to `#cda874` and clay `#cfa673` to `#916a40`.

## States in the app

`frontend/peek.js` draws Peek inline, and CSS animates one state at a time. Peek is decorative: the words beside it always carry the meaning, and reduced motion holds each state still.

| State | Motion | Where |
|---|---|---|
| Idle | Blinks and glances aside | Sign-in card |
| Loading | Bobs and scans the horizon | Reading the repository, loading a file's declarations |
| Thinking | Looks up with three pulsing thought dots | While Ask is answering |
| Success | Hops with a happy closed eye and sparkles | A reviewed task's next step |
| Error | Sinks behind the horizon with a droopy eye | Error notices and offline |
| Empty | Peeks up, looks around and ducks down | An empty map level, no instructions yet |
