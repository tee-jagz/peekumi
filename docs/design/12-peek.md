# Peek

Peek is the mascot: a teal dome with one eye that looks over three layers of sediment (mint, sand and clay). Peek shows the state of Peekumi and of the agent. One look at Peek tells the owner if the agent works, waits for them or stopped. The words next to Peek give the facts.

## The drawing

- The drawing and its animations are `frontend/peek.js` and the Peek part of `frontend/style.css`. The mockups use the same files through `tools/build.py`.
- Each state is one class on the drawing. Do not add a pose without a change to this section.
- `assets/Mascot/peek.svg` and `peek-tile.svg` are still exports. Use them for the app icon, the docs and other places without the app's script.

## States

| State | Motion | When |
|---|---|---|
| `idle` | Blinks and glances | Pairing, the start page |
| `loading` | Bobs and scans | The app or the map loads for more than 1 second |
| `working` | Reads, and its layers lift in turn | An agent works |
| `peeking` | Ducks, then looks over its layers | Ask reads the repository |
| `thinking` | Looks up, with three dots | An agent needs you: a question, or a command to allow |
| `ready` | One bounce, then it waits | A task is ready for review |
| `success` | Hops, with a happy eye and a sparkle | A step that you started is done: a save, an approval |
| `merged` | The layers slide into one, then a sparkle | A task is merged into its branch |
| `empty` | Peeks up, looks around and ducks | Nothing is here yet |
| `asleep` | Eye closed, breathes | Offline |
| `stopped` | Half-lidded, with its layers out of line | A task stopped or was cancelled |
| `error` | Sinks, with a droopy eye | A run failed |

## What the agent does

While an agent works, Peek shows its activity. The activity comes from the agent's last step. Each pose uses Peek's own parts (its eye, its head and its three layers) and two props: a reading lens and a pencil.

| Pose | Motion | The agent's step |
|---|---|---|
| `reading` | Wears the reading lens, and the eye reads line by line | `Read`, or a lookup in the map |
| `searching` | Wears the reading lens, ducks, then looks over its layers | `Grep`, `Glob` |
| `editing` | Writes along its top layer with the pencil, and the eye follows it | `Edit`, or `Write` to a file that exists |
| `creating` | Writes with the pencil while new layers rise into the stack | `Write` to a new file |
| `running` | The eye holds still, and the layers pulse in turn | A command, for example the tests |
| `working` | Reads, and its layers lift in turn | Any other step, or text from the agent |

- The text next to Peek names the activity and its object: "Claude Code · Edits graph_brief.rs". The pose adds speed, not facts.
- On the map, Peek's head moves to the card of the file that the agent uses now. When the file is not on this level, the head goes on the card of the folder that holds it.
- Each pose stays for 2 seconds or more, so fast steps do not flicker. A newer step then replaces it.
- Props are part of Peek's drawing: the reading lens (one lens, because Peek has one eye) and the pencil in Peek's layer colours. Never put an icon, an emoji or clip art on Peek. Generic clip art makes a mascot look generated.
- A new prop needs a change to this section. It uses the brand colours, Peek's line weight and Peek's light.

## Places

| Place | Size | States |
|---|---|---|
| The live line in the sheet | 28px | The activity poses, `thinking`, `ready`, `stopped` |
| Over the top edge of the map card where the agent works (the head only) | 40 × 22px | The activity poses |
| The head of a task page or a session page | 44px | The state of the task |
| Empty states | 88px | `empty` |
| The offline screen and the loading screen | 88px | `asleep`, `loading` |
| A toast after a merge or a finished step | 24px | `merged`, `success` |
| Pairing | 72px | `idle` |
| The app icon | 192 and 512px | `peek-tile.svg` |

## Where Peek never appears

- In a diff, in source, or on a rule-break line. The code gets the attention.
- Inside an approval prompt or a merge dialog. A decision needs calm facts. The page head above it can show the state.
- In an inline error for one field or one action. A whole screen that fails can show Peek in the `error` or `asleep` state.
- As the status mark of a list row. Rows use the status dot and the word.
- On the Tasks button. The button uses a status dot.

## Rules

1. At most two Peeks on a screen, and at most one of them moves. On the map, the head over the agent's card moves. The Peek in the live line holds its pose still.
2. Peek shows a state, never a verdict. Peek does not celebrate an agent's work before the owner reviews it. `success` and `merged` follow an action of the owner.
3. Peek never stands for one agent. The agent's name is in the text next to Peek: "Claude Code · Editing".
4. Peek is decorative: `aria-hidden="true"`. The text next to it carries the meaning, so each state is clear without Peek.
5. Peek never talks. No text in Peek's voice and no speech bubbles.
6. `stopped` and `error` are slow and quiet. Peek does not bounce in a bad moment.
7. With reduced motion, each state holds still in its pose.

## Why

A mascot that shows a state gives the owner a fast signal at the edge of their view. Clippy failed because it took the focus and talked. Peek does neither: it never takes the focus, it never talks, and the words carry the facts. Mailchimp's guide says that in stressful moments, the voice must be "straightforward, serious, and calm". So Peek is quiet in errors and stays out of approvals and merge dialogs.
