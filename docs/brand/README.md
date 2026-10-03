# Peekumi brand

Peek is the Peekumi mascot. Peek is a round character with one eye, and it looks over three layered lines. The lines are the layers of a repository, and Peek lets you see into that repository.

- `peek.svg`: The mascot on a transparent background. Use it for documentation and for light or dark pages.
- `frontend/icon-192.png` and `frontend/icon-512.png`: The home-screen icons. Each icon shows Peek on a transparent square with a margin. They are declared `any`, not `maskable`. Thus, Android puts them on its own launcher shape (usually a light circle or squircle), and iOS fills the transparent area with black.
- `peekumi-icon.svg`: Peek on the dark, full-bleed tile. Use it where a solid square is necessary, for example in store listings or social cards.
- `frontend/favicon.svg`: Peek on a transparent background. The image is cropped to the artwork, so it fills a browser tab. It is clear on light and dark tab bars.

Colours:

- Tile: `#1b4a44` to `#0a1a19`.
- Peek: `#78e2c0` to `#1a6553`.
- Eye: white, with a `#0d2120` pupil.
- Layers: mint `#bff7e6` to `#68cfb0`, sand `#f5e2bf` to `#cda874` and clay `#cfa673` to `#916a40`.

## States in the app

`frontend/peek.js` draws Peek inline. CSS animates one state at a time. Peek is decorative. The words next to Peek always give the meaning. When reduced motion is on, each state stays still.

| State | Motion | Where |
|---|---|---|
| Idle | Blinks and looks to the side | The sign-in card |
| Loading | Moves up and down and scans the horizon | When Peekumi reads the repository or loads the declarations of a file |
| Thinking | Looks upward, with three thought dots that pulse | While Ask answers |
| Peeking | Goes down behind its layers and looks over them. Its eye moves quickly from side to side | While Ask does code lookups |
| Working | Reads with its eye down. Its layers go up and then down again, one after the other | An agent that runs a task: the Tasks button and the task |
| Ready | Looks at you, makes one small bounce, then waits | A finished task that waits for review; the Tasks button when the agent finishes |
| Success | Jumps, with a happy closed eye and sparkles | The next step of a reviewed task |
| Merged | Its lower layers move into the top layer, then a sparkle shows | A task applied to main |
| Stopped | Its eye is half closed and it is low. Its layers are not in line | A task that failed, was interrupted or was stopped; the Tasks button while a task needs attention |
| Error | Goes down behind the horizon, with its eyelid low | Error notices |
| Asleep | Its eye is closed, it breathes slowly and dots move up slowly | When Peekumi is offline or cannot connect to the server |
| Empty | Comes up, looks around and goes down again quickly | An empty map level; no instructions yet |
