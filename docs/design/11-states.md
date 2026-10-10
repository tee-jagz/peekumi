# States

Design each of these states for every view, before any decoration.

## Loading

| Wait | Show |
|---|---|
| Less than 1 second | Nothing. |
| 1 to 10 seconds, a whole view (the map, a page) | A skeleton in the shape of the content: grey blocks in `line` on the right ground. |
| 1 to 10 seconds, one part (a source block, a row) | A small spinner in `ink-muted` in that part. |
| More than 10 seconds (an agent run, an audit, a proposal) | The step in words, the time since the start, and "You can leave this page" when it runs on the server. |

- Never block the whole screen for one part.
- Status changes reach screen readers through a polite live region.

## Empty

- One short line that says what is empty: "No tasks yet."
- One button for the next step: "Write an instruction".
- Peek in the `empty` state (88px) shows above the line.

## Error

- Show the error where it happened, inline, in `danger` with the word or an icon. Never as a toast that fades.
- Say what failed and what to do. Give a button when one action fixes it ("Try again").
- No Peek in an inline error. An error needs calm facts.
- When a whole screen fails, Peek in the `error` state shows above the message.

## Offline

- The comparison line in the header says "Offline" with a dot in `warning`.
- The map stays as it was, and actions that need the server are off, with the reason.
- The offline screen shows Peek in the `asleep` state above the message, and a "Try again" button.

## Working (an agent)

- The Tasks button shows a dot in `accent`.
- On the map, the card where the agent works has an `accent` border, and Peek's head looks over its top edge. The head moves with the agent from file to file.
- In the sheet, the live line shows Peek in the pose of the activity, then the agent's name and its step: "Claude Code · Edits graph_brief.rs". **Peek** lists the poses.

## Needs you

- The Tasks button shows a dot in `warning`.
- The live line shows Peek in the `thinking` state and says "Needs you" in `warning`. It opens the question.

## Success

- Confirm in place: the button changes to the done state ("Approved", "Merged into main").
- A toast is allowed only for a passive confirmation ("Saved 2 drafts"). It never holds an action that cannot be found elsewhere.
- After a merge, the task page and the toast show Peek in the `merged` state.

## Updates

- "Update ready" shows in the header's comparison line as quiet text with "Reload" and "Later".
- If a field holds unsent text, Reload first asks to keep or clear it.
