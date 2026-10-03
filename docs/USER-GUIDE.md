# Using Peekumi

This guide walks through every part of the Peekumi interface on a phone, then the desktop layout. Each screenshot has numbered orange markers, and the table under it explains what each numbered element is and how to use it. The screenshots show Peekumi inspecting its own repository.

To install Peekumi, pair a phone and keep it updated, see [SETUP.md](SETUP.md). Instructions, agent runs and verification are covered in more depth in [WORKFLOW.md](WORKFLOW.md).

The screenshots and icon images are generated from the live interface by `node scripts/guide-screenshots.mjs`, so they can be refreshed whenever the interface changes.

## Contents

- [The map at a glance](#the-map-at-a-glance)
- [Gestures and keys](#gestures-and-keys)
- [Map key](#map-key)
- [Choosing what to compare](#choosing-what-to-compare)
- [Moving through history](#moving-through-history)
- [Selecting something](#selecting-something)
- [The review sheet](#the-review-sheet): Details, Source, Changes, Relations
- [Ask, instructions and tasks](#ask-instructions-and-tasks)
- [Typing on a phone](#typing-on-a-phone)
- [Desktop layout](#desktop-layout)
- [Icon reference](#icon-reference)
- [Offline and updates](#offline-and-updates)

## The map at a glance

<img src="guide/01-map.jpg" width="340" alt="The phone layout: header, map with floating controls, and the review sheet at peek height">

The screen has three parts. The header names the repository and the comparison. The map in the glass card shows the repository's real folders, files and declarations. The review sheet at the bottom describes what you're looking at and holds the Ask and Instruction box.

| # | Element | How to use it |
|---|---|---|
| 1 | Repository name | The repository being inspected. With several repositories registered, switch between them in the comparison popover (2). |
| 2 | Comparison line | Shows the branch and the two commits being compared, as `base → head`. Tap it to change branch, head, base or pull request. |
| 3 | Time / Diff | **Time** shows commit cards to step through history one commit at a time. **Diff** compares any head with any base you choose. |
| 4 | Tasks | Opens your draft instructions and agent runs. The icon turns blue when an agent has finished work that is ready for review. |
| 5 | Before / After | Shown in Diff. Switches the map and source between the base (dot on the left) and the head (dot on the right). |
| 6 | Card | A folder, file or declaration. Tap once to select it, tap again to open it. The tint shows its change: orange is modified, green is added, red and dashed is removed, plain is unchanged. A modified declaration also shows which parts changed: signature, documentation or implementation. |
| 7 | Card counts | How many files inside were added, modified or removed, followed by the total number of files. |
| 8 | Home and Up | Home returns to the repository root. Up goes to the parent folder. Both are dimmed at the root. |
| 9 | Changes only | Hides unchanged cards at every level, keeping changed folders so you can still drill in. |
| 10 | Zoom out | Zooms the map out. Pinching works too. |
| 11 | Zoom in | Zooms the map in. |
| 12 | Fit | Fits the whole map on screen. |
| 13 | Reset | Returns to actual size, aligned to the top. |
| 14 | Key | Opens the map key, which also holds the colour lens. See [Map key](#map-key). |
| 15 | Sheet handle | Drag up or down, or tap, to move the sheet between peek, half and full height. |
| 16 | Summary | The description of the selection or the current folder, taken from committed documentation. Long text scrolls and fades its last line while more is available. |
| 17 | Ask / Instruction | Ask a question about the selection, or write an instruction for an agent. |
| 18 | Anchor | What your question or instruction is about, and the commit it refers to. |
| 19 | Text field | Type your question or instruction here. |
| 20 | Send | Sends the question. In Instruction mode this is replaced by Cancel and Save draft. |

Lines between cards are static dependencies: imports, calls, implementations and inheritance found in the code, not runtime behaviour. Tap a line to select it. Cards with a dashed outline are neighbours outside the current folder.

Selecting a card highlights its own connections and fades everything unrelated. Blue lines are what the selection uses; teal lines are what uses the selection. If the selection has no connections, nothing fades.

## Gestures and keys

| Action | On a phone | With a mouse or keyboard |
|---|---|---|
| Select a card | Tap | Click, or Tab to it and press Enter |
| Open a card | Tap it again | Click again, or press Enter again |
| Pan the map | Drag; a flick keeps gliding | Drag, scroll, or arrow keys with the map focused |
| Zoom | Pinch | Control or Command and scroll, or `+` and `-` |
| Go up a level | Up button | Up button, or Escape with nothing selected |
| Clear a selection | × in the sheet | Escape |
| Close a popover | Tap outside it, or ✕ | Escape |
| Change sheet height | Drag or tap the handle | Arrow keys, Home and End on the handle |

## Map key

<img src="guide/02-key.jpg" width="340" alt="The map key popover over the map">

| # | Element | How to use it |
|---|---|---|
| 1 | Colour lens | **Changes** colours cards by Git status. **Structure** hides change colours to show the plain layout. |
| 2 | Colours and types | What each change colour and shape means, the icon for each kind of folder, declaration and file, and the icons for what changed inside a declaration. |
| 3 | Line styles | Blue lines are what a selection uses and teal lines use the selection. Solid lines are imports or calls, dotted are implementations, dashed are inheritance, red marks a removed relationship or a broken dependency rule. |

## Choosing what to compare

<img src="guide/03-comparison.jpg" width="340" alt="The comparison popover">

Tap the comparison line in the header to open this popover.

| # | Element | How to use it |
|---|---|---|
| 1 | Branch | Choose which branch to inspect. This only changes what you view; your checkout is never switched. |
| 2 | Pull requests | Lists open pull requests when GitHub CLI is signed in on the host. Choosing one shows its full diff against its merge base, with its description, checks and discussion. |
| 3 | Commit summary | The head commit's message, date, and what it is compared with. |
| 4 | Head revision | The newer commit in the comparison. |
| 5 | Compare with | The older commit. **Previous commit (automatic)** follows the head's first parent. Choosing a specific commit pins it until you pick the automatic option again or tap **Use previous commit**. |
| 6 | Refresh | Checks for new commits. Uncommitted work is never shown. |
| 7 | Close | Closes the popover. Tapping anywhere outside it also closes it. |

When several repositories are registered, a **Repository** picker appears above Branch.

<img src="guide/04-select-menu.jpg" width="340" alt="A frosted selection menu listing commits">

Every picker opens a menu like this one. The current choice has a check mark (1). Tap an option to choose it, or use the arrow keys, Home, End and Enter. Escape closes the menu without changing anything.

## Moving through history

<img src="guide/05-time.jpg" width="340" alt="Time mode with commit cards above the map">

In **Time**, a strip of commit cards appears above the map. The highlighted card (1) is the commit being shown, compared with its parent. Tap another card (2) to move to that commit. Swipe the strip sideways to reach older commits.

## Selecting something

<img src="guide/06-selection-peek.jpg" width="340" alt="A function selected, with its summary and inputs in the sheet">

| # | Element | How to use it |
|---|---|---|
| 1 | Selected card | A blue outline marks the selection. Tap it again to open it: a folder or file opens on the map, a declaration opens in Source. |
| 2 | Name and status | The selection's name, its change status icon, and what kind of thing it is. For a modified declaration, a line such as **Signature and implementation changed** says which parts to inspect. |
| 3 | Summary | Its committed documentation. Scroll it to read more. |
| 4 | Inputs, outputs and fields | One line each for parameters, the return type and class fields. Swipe sideways to see them all; a fade on the right means there is more. Only declared types appear here. The Details view labels any missing annotation. |
| 5 | Up | Leaves the file and returns to its folder. |

## The review sheet

Drag the sheet up to half or full height to inspect the selection. The view buttons stay at the top of the sheet; choosing a view never lowers a sheet you have raised.

### Details

<img src="guide/07-details.jpg" width="340" alt="The Details view of a selected function">

| # | Element | How to use it |
|---|---|---|
| 1 | Details | Facts, documentation and declaration metadata for the selection. |
| 2 | Source | The code, as a diff or as the Before or After version. |
| 3 | Changes | Changed files or declarations in the current scope, and file search. |
| 4 | Relations | Dependencies, dependency rules and their evidence. |
| 5 | Discussion | Shows the conversation for the selection that matches the box below: your Ask questions and answers, or the instructions left on it. |
| 6 | Facts | One quiet line after the content: the line range, or file and change counts for a folder. |
| 7 | Main action | The next step for this selection, such as **View source**, **Open file**, **Open folder** or **Show evidence**, beside the facts. |
| 8 | Clear selection | Deselects and returns the sheet to the current folder or file. |

Expanded Details is the peek view in full: the whole description and the same **In** and **Out** lines, with parameter defaults, plus notes on parameters where the code documents them. For a folder it shows its README or package docstring as plain text, with a link to read the whole file. A small **adapter** note at the end names the language adapter that read the file; tap it for what the adapter extracts and its limits.

The only labelled view button is the one that is open; the others show just their icons. All of them are listed in the [icon reference](#icon-reference).

### Source

<img src="guide/08-source.jpg" width="340" alt="The Source view with a highlighted declaration">

| # | Element | How to use it |
|---|---|---|
| 1 | Diff / After / Before | **Diff** shows the changes with old and new line numbers. **After** and **Before** show the whole file at the head or base. |
| 2 | Code | Scrolls inside its own box, which fills the sheet, so the controls above stay in place. With a declaration selected, **Diff** shows only that declaration's changes. |
| 3 | Highlight | The selected declaration's lines are highlighted and scrolled into view. |

### Changes

<img src="guide/09-changes.jpg" width="340" alt="The Changes view with a list of changed files">

| # | Element | How to use it |
|---|---|---|
| 1 | Overview | How many files changed in the current scope, with counts for each change type. |
| 2 | Search | Finds any file in the repository by path, changed or not. |
| 3 | Changed file | Tap to open the file on the map. Inside a file, the list shows changed declarations instead. |

### Relations

<img src="guide/10-relations.jpg" width="340" alt="The Relations view for a selected function">

| # | Element | How to use it |
|---|---|---|
| 1 | Rule summary | Results of the dependency rules committed in `.peekumi.json`. Expand it for configuration details and analysis gaps. Without a rules file it says rules are not configured. |
| 2 | Relationship kind | Show all relationships, or only imports, calls, implementations or inheritance. |
| 3 | Violations only | Show only relationships that break a dependency rule. |
| 4 | Relationship | `from → to`, with its kind, change status and how many sites exist before and after. Tap to select it and see buttons for each file involved. |
| 5 | Resolved evidence | Each relationship found in the code, with a link that opens the exact source line. |
| 6 | Unresolved targets | References Peekumi could not resolve with certainty, and why. These are listed rather than guessed. |

## Ask, instructions and tasks

**Ask** answers questions about the selection using Claude Code on this computer. It reads committed code only and cannot run, change or send anything. For a file or declaration it reads the source and its diff, plus what the code calls, imports or inherits and what calls it. When that is not enough, it can look up more of the repository at the same revisions (search declarations or the code itself, read a declaration or file, follow relationships), up to 12 lookups per answer. The answer appears as it is written, shows each lookup while it happens, and lists what it looked up. Names of files and declarations in an answer are underlined with dots when they point to exactly one place: tap one and the map moves there and selects it. For a folder or the whole repository it reads that folder's README, the declarations inside it and the diffs of its changed files. Your question appears as soon as you send it, and you can type the next one while the answer loads. If the answer ends with a suggested instruction, **Save as draft instruction** keeps it as a draft for the same selection. While you are exploring a task's changes, the button reads **Add to requested changes** instead: it takes you back to the task with the suggestion in its Request changes box, because a new draft would start from main without the agent's work. One conversation runs for the session: it stays on screen as you move around the map, each question is about whatever is selected when you send it, and "About …" marks where the subject changes. **New conversation** clears it, and it is lost on reload.

<img src="guide/11-comment.jpg" width="340" alt="Writing an instruction draft">

| # | Element | How to use it |
|---|---|---|
| 1 | Instruction | Switches the box from asking to writing an instruction for an agent. |
| 2 | Anchor | The selection and commit the instruction is attached to. It stays attached even if you navigate elsewhere before saving. |
| 3 | Instruction text | Describe what should change and why. |
| 4 | Cancel | Discards the unsent instruction. |
| 5 | Save draft | Saves the instruction as a draft and lists it under Discussion for that selection. Drafts are private until you send them to an agent. |

<img src="guide/12-tasks.jpg" width="340" alt="The Tasks view with one draft instruction">

| # | Element | How to use it |
|---|---|---|
| 1 | Review task | Turns your drafts into a task: choose which drafts, which agent (Codex or Claude Code) and optional extra instructions, then preview the exact task before starting it. |
| 2 | Draft | A saved instruction with its anchor and commit. Edit or delete it while it is a draft. |

After a task starts, the same view follows the agent's progress, its reported checks and the commits it made. The task leads with its state, then each instruction and the agent's result. **Explore changes** shows everything the agent did on the map, compared with the commit the task started from; **Back to task** returns you to the task and your previous view. **Approve** records your review (tap **Add note** first to leave one), and **Request changes** asks what needs fixing, then sends it to the same agent as the next round. That round starts from the agent's last commit, so earlier work is kept, and the task shows your feedback above the instructions. Earlier rounds open from the latest one with **Open round N**. The agent's messages, raw events and the generated task sit in **Agent log**. The Tasks button toggles: tap it again, or tap empty map space, to return to the map selection.

Approving a task does not change your code. Peekumi never merges: the agent's commits stay on their task branch. Once you approve, the task shows **Next: apply to main** with the exact command, such as `git merge --ff-only peekumi/run-…`, and a copy button. Run it in the repository with main checked out, or open a pull request from that branch. When the commits reach main, the task reads **Applied to main**. See [WORKFLOW.md](WORKFLOW.md) for the full loop.

## Typing on a phone

<img src="guide/13-keyboard.jpg" width="340" alt="The layout with the phone keyboard open">

When the keyboard opens, the header and the map controls step aside, the sheet keeps its size at peek height, and the text field (1) stays above the keyboard. The map stays visible so you can still see what you are asking about.

## Desktop layout

<img src="guide/14-desktop.jpg" width="720" alt="The desktop layout in dark mode">

On a wide screen the header (1) spans the top, the map (2) fills the left, and the review sheet (3) sits on the right at full height. Everything else works the same way. Peekumi follows the system light or dark appearance.

## Icon reference

Every icon button has a name that appears as a tooltip and is read by screen readers.

### Header and map

| Icon | Name | What it does |
|---|---|---|
| <img src="guide/icons/glyph-branch.svg" width="20" alt=""> | Branch | Marks the comparison line; tap it to change branch or comparison. |
| <img src="guide/icons/glyph-time.svg" width="20" alt=""> | Time | Step through history with commit cards. |
| <img src="guide/icons/glyph-diff.svg" width="20" alt=""> | Diff | Compare any two commits. |
| <img src="guide/icons/glyph-tasks.svg" width="20" alt=""> | Tasks | Drafts and agent runs. |
| <img src="guide/icons/glyph-before.svg" width="20" alt=""> | Before | Show the base revision. |
| <img src="guide/icons/glyph-after.svg" width="20" alt=""> | After | Show the head revision. |
| <img src="guide/icons/glyph-home.svg" width="20" alt=""> | Home | Go to the repository root. |
| <img src="guide/icons/glyph-up.svg" width="20" alt=""> | Up | Go up one level. |
| <img src="guide/icons/glyph-filter.svg" width="20" alt=""> | Changes only | Hide unchanged cards. |
| <img src="guide/icons/glyph-zoomOut.svg" width="20" alt=""> | Zoom out | Zoom the map out. |
| <img src="guide/icons/glyph-zoomIn.svg" width="20" alt=""> | Zoom in | Zoom the map in. |
| <img src="guide/icons/glyph-fit.svg" width="20" alt=""> | Fit | Fit the map on screen. |
| <img src="guide/icons/glyph-reset.svg" width="20" alt=""> | Reset | Actual size. |
| <img src="guide/icons/glyph-key.svg" width="20" alt=""> | Key | Map key and colour lens. |

### Review sheet

| Icon | Name | What it does |
|---|---|---|
| <img src="guide/icons/glyph-details.svg" width="20" alt=""> | Details | Facts and documentation. |
| <img src="guide/icons/glyph-source.svg" width="20" alt=""> | Source | Code and diff. |
| <img src="guide/icons/glyph-changes.svg" width="20" alt=""> | Changes | Changed files and search. |
| <img src="guide/icons/glyph-relations.svg" width="20" alt=""> | Relations | Dependencies and rules. |
| <img src="guide/icons/glyph-discussion.svg" width="20" alt=""> | Discussion | Your Ask conversation, or the instructions on the selection. |
| <img src="guide/icons/glyph-ask.svg" width="20" alt=""> | Ask | Ask a question about the selection. |
| <img src="guide/icons/glyph-comment.svg" width="20" alt=""> | Instruction | Write an instruction for an agent. |
| <img src="guide/icons/glyph-pin.svg" width="20" alt=""> | Anchor | What the question or instruction refers to. |
| <img src="guide/icons/glyph-send.svg" width="20" alt=""> | Send | Send the question. |
| <img src="guide/icons/glyph-check.svg" width="20" alt=""> | Save draft | Save the instruction. |
| <img src="guide/icons/glyph-close.svg" width="20" alt=""> | Cancel or close | Discard, or close a popover. |
| <img src="guide/icons/glyph-copy.svg" width="20" alt=""> | Copy | Copy the command that applies a reviewed task. |
| <img src="guide/icons/glyph-refresh.svg" width="20" alt=""> | Refresh | Check for new commits. |

### Change status

Each status has its own shape as well as its own colour.

| Icon | Status |
|---|---|
| <img src="guide/icons/status-added.svg" width="20" alt=""> | Added |
| <img src="guide/icons/status-changed.svg" width="20" alt=""> | Modified |
| <img src="guide/icons/status-removed.svg" width="20" alt=""> | Removed |
| <img src="guide/icons/status-unchanged.svg" width="20" alt=""> | Unchanged |

### Folders, files and declarations

Icons describe what a card is, never its change status. Source files are files a language adapter parsed; other files are recognised by their extension.

| Icon | Kind | Icon | Kind |
|---|---|---|---|
| <img src="guide/icons/object-folder.svg" width="20" alt=""> | Folder | <img src="guide/icons/file-code.svg" width="20" alt=""> | Source file |
| <img src="guide/icons/object-files.svg" width="20" alt=""> | Repository files (root files group) | <img src="guide/icons/file-document.svg" width="20" alt=""> | Documentation |
| <img src="guide/icons/object-class.svg" width="20" alt=""> | Class or struct | <img src="guide/icons/file-data.svg" width="20" alt=""> | Data or configuration |
| <img src="guide/icons/object-function.svg" width="20" alt=""> | Function or method | <img src="guide/icons/file-image.svg" width="20" alt=""> | Image |
| <img src="guide/icons/object-interface.svg" width="20" alt=""> | Interface or trait | <img src="guide/icons/file-sealed.svg" width="20" alt=""> | Binary or restricted file (no preview) |
| <img src="guide/icons/object-enum.svg" width="20" alt=""> | Enum | <img src="guide/icons/file-file.svg" width="20" alt=""> | Other file |

### Changed parts of a declaration

A modified declaration says which parts changed, on its card and in the sheet. The comparison is of the code's structure, not its behaviour: whitespace-only edits do not count as changes, and "implementation" means the body's code changed, not that it behaves differently. A change outside these parts, such as a Python decorator, shows as plain **Modified**.

| Icon | Part | What changed |
|---|---|---|
| <img src="guide/icons/part-signature.svg" width="20" alt=""> | Signature | Parameters, return type, generics, base classes, or a struct's or class's declared fields |
| <img src="guide/icons/part-documentation.svg" width="20" alt=""> | Documentation | Doc comments or docstrings |
| <img src="guide/icons/part-implementation.svg" width="20" alt=""> | Implementation | The body's code, excluding documentation |

### Inputs and outputs

| Icon | Meaning |
|---|---|
| <img src="guide/icons/contract-in.svg" width="20" alt=""> | Inputs: parameters |
| <img src="guide/icons/contract-out.svg" width="20" alt=""> | Outputs: return type or description |
| <img src="guide/icons/contract-fields.svg" width="20" alt=""> | Fields declared on a class |

## Offline and updates

Peekumi runs on your own computer; the phone app is a window onto it. If the phone loses its connection, a banner says so, and no code is stored on the phone. When the server has a new version, the app shows **Update available · reload**. Save any unsent text, then tap it. Changes to the app's name, icon or full-screen mode take effect after removing the app from the home screen and adding it again.
