# Tasks and review

The owner gives work to agents and decides what goes into the branch. These screens must feel calm and factual.

## State labels

Every state of a task or a session has a word, an icon and a colour, together. Never only one of them.

| State | Word | Colour |
|---|---|---|
| Draft | Draft | `ink-muted` |
| Starting, working | Working | `accent` |
| Needs the owner (a question, a command to approve, a failure) | Needs you | `warning` |
| Done, not reviewed | Ready for review | `accent` |
| Approved | Approved | `success` |
| Merged | Merged into main | `success` |
| Stopped by the owner, or ended without review | Stopped | `ink-muted` |
| Failed | Failed | `danger` |

## The task list

- Group the tasks: "Needs you", then "Working", then "Ready for review", then "Done". Leave out an empty group.
- A row: the task's first instruction as the main line (`title`, one line), then the state label and the time (`caption`).
- The row opens the task. There is no "›" text glyph. Use the `chevron` icon.

## A task

From top to bottom:

1. The title row: back, the title (`title-lg`), the state label.
2. The key facts as fields, not one line with dots: files changed, commits, rule breaks added, and the run time.
3. The instructions, each with the agent's report.
4. The diff, by file.
5. The primary action at the bottom: "Approve" when ready, "Merge into main" when approved. Other actions ("Request changes", "Explore changes") are plain buttons.

## Progress for long waits

An agent run takes minutes. Show progress in steps, not a spinner alone (NN/g: 10 seconds or more needs a progress indicator).

- The current step in words: "Reading the code", "Editing 3 files", "Running tests", "Checking the rules".
- The time since the start, in `caption` with `tabular-nums`.
- A notification when the run ends, if the owner turned notifications on.

## Approvals in a session

- The command shows in `code` on `surface-sunken`.
- The agent's reason shows under it in `body-sm`.
- Buttons: "Allow once" (primary), "Allow for this session", "Deny". "Allow all commands" goes in a menu, because it removes the safeguard.
- Deny uses `danger` text, not a red fill.

## Merge and other confirmations

- A merge is a modal dialog with the `scrim`. It names the branch, the commits and the files, and it says if the merge can be undone.
- The confirm button is the verb: "Merge into main", not "OK" or "Yes".
- Never put a destructive action as the default button.
- After the merge, show "Merged into main" with "Undo merge" for as long as undo is possible.

## Agents

- Name each agent by its product name ("Claude Code", "Codex") with a neutral icon.
- Peek never stands for an agent. Peek shows the agent's state, and the agent's name stays in the text.
- Peek never celebrates the agent's work before the owner reviews it. A friendly verdict makes the owner trust the work too much.
