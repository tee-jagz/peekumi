# Motion

Motion shows where something went. It never decorates, and the owner never waits for it.

## Durations and curves

| Use | Duration | Curve |
|---|---|---|
| Press and hover feedback | 100ms | `ease-out` |
| A small change (a row opens, a chip changes) | 150ms | `cubic-bezier(0.2, 0, 0, 1)` |
| The sheet moves to another height | 280ms | `cubic-bezier(0.05, 0.7, 0.1, 1)` |
| The map zooms into a card | 300ms | `cubic-bezier(0.05, 0.7, 0.1, 1)` |
| A dialog or menu closes | 150ms | `cubic-bezier(0.3, 0, 0.8, 0.15)` |

- Entry decelerates and exit accelerates. Never use linear motion for movement.
- Nothing takes more than 400ms.

## What moves

- The sheet follows the finger during a drag, then settles at a height.
- The map zooms into the card that the owner opens, and back out.
- A newly selected card's ring fades in.
- The working state of an agent: one quiet pulse on the card where the agent works, at most once a second.

## What does not move

- Dependency lines while they redraw.
- Text, numbers and lists while they update.
- Anything on a loop, except Peek and a loading indicator. At most one Peek moves on a screen.

## Reduced motion

When `prefers-reduced-motion: reduce` is on:

- The sheet and the map change with a 150ms cross-fade, not a move or a zoom.
- No pulses and no loops.
- Peek holds still in the pose of its state.
