# Using Peekumi

This guide shows each part of the Peekumi interface on a phone, and then the desktop layout. Each screenshot has numbered orange markers. The table below each screenshot tells what each numbered element is and how to use it. The screenshots show Peekumi when it inspects its own repository.

For the procedures to install Peekumi, pair a phone and keep Peekumi up to date, refer to [SETUP.md](SETUP.md). [WORKFLOW.md](WORKFLOW.md) gives more information about instructions, agent runs and verification.

The command `node scripts/guide-screenshots.mjs` makes the screenshots and icon images from the live interface. Thus, you can make them again each time the interface changes.

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

<img src="guide/01-map.jpg" width="340" alt="The phone layout: the header, the map with its controls on top, and the review sheet at peek height">

The screen has three parts. The header shows the name of the repository and the comparison. The map in the glass card shows the real folders, files and declarations of the repository. The review sheet at the bottom tells you about the item that you look at. The review sheet also contains the Ask and Instruction box.

| # | Element | How to use it |
|---|---|---|
| 1 | Repository name | The repository that Peekumi inspects. If you register more than one repository, use the comparison popover (2) to change between them. |
| 2 | Comparison line | Shows the branch and the two commits that Peekumi compares, as `base → head`. Tap it to change the branch, head, base or pull request. |
| 3 | Time / Diff | **Time** shows commit cards. Use them to go through the history one commit at a time. **Diff** compares any head with any base that you select. |
| 4 | Tasks | Opens your draft instructions and agent runs. The icon becomes blue when an agent completes work that is ready for review. |
| 5 | Before / After | Shows in Diff. It changes the map and the source between the base (dot on the left) and the head (dot on the right). |
| 6 | Card | A folder, file or declaration. Tap it one time to select it. Tap it again to open it. The tint shows its change: orange is modified, green is added, red and dashed is removed, and plain is unchanged. A modified declaration also shows which parts changed: signature, documentation or implementation. |
| 7 | Card counts | The number of files in the card that are added, modified or removed, and then the total number of files. |
| 8 | Home and Up | Home goes back to the repository root. Up goes to the parent folder. At the root, the two buttons are dim. |
| 9 | Changes only | Hides unchanged cards at all levels. Changed folders stay on the map, so you can still go down into them. |
| 10 | Zoom out | Zooms the map out. You can also pinch the map. |
| 11 | Zoom in | Zooms the map in. |
| 12 | Fit | Makes the full map fit on the screen. |
| 13 | Reset | Goes back to actual size, with the map aligned to the top. |
| 14 | Key | Opens the map key. The map key also contains the colour lens. Refer to [Map key](#map-key). |
| 15 | Sheet handle | Drag it up or down, or tap it, to move the sheet between peek, half and full height. |
| 16 | Summary | The description of the selection or the current folder. This text comes from committed documentation. You can scroll long text. While more text is available, its last line fades. |
| 17 | Ask / Instruction | Ask a question about the selection, or write an instruction for an agent. |
| 18 | Anchor | The subject of your question or instruction, and the commit that it refers to. |
| 19 | Text field | Type your question or instruction here. |
| 20 | Send | Sends the question. In Instruction mode, Cancel and Save draft replace this button. |

The lines between cards are static dependencies: imports, calls, implementations and inheritance that Peekumi finds in the code. They do not show runtime behaviour. Tap a line to select it. Cards with a dashed outline are neighbours outside the current folder.

When you select a card, Peekumi highlights the connections of that card and fades all unrelated items. Blue lines show what the selection uses. Teal lines show what uses the selection. If the selection has no connections, no items fade.

## Gestures and keys

| Action | On a phone | With a mouse or keyboard |
|---|---|---|
| Select a card | Tap | Click, or Tab to it and push Enter |
| Open a card | Tap it again | Click again, or push Enter again |
| Pan the map | Drag. After a flick, the map continues to move | Drag, scroll, or use the arrow keys when the map has the focus |
| Zoom | Pinch | Control or Command and scroll, or `+` and `-` |
| Go up a level | Up button | Up button, or Escape when no item is selected |
| Clear a selection | Tap an empty area of the map, or × in the sheet | Click an empty area of the map, or Escape |
| Close a popover | Tap outside it, or ✕ | Escape |
| Change sheet height | Drag or tap the handle | Arrow keys, Home and End on the handle |

## Map key

<img src="guide/02-key.jpg" width="340" alt="The map key popover above the map">

| # | Element | How to use it |
|---|---|---|
| 1 | Colour lens | **Changes** colours the cards by Git status. **Structure** hides the change colours and shows the plain layout. |
| 2 | Colours and types | The meaning of each change colour and shape. The icon for each type of folder, declaration and file. The icons for the parts that changed in a declaration. |
| 3 | Line styles | Blue lines show what a selection uses. Teal lines show what uses the selection. Solid lines are imports or calls, dotted lines are implementations, and dashed lines are inheritance. Red shows a removed relationship or a broken dependency rule. |

## Choosing what to compare

<img src="guide/03-comparison.jpg" width="340" alt="The comparison popover">

Tap the comparison line in the header to open this popover.

| # | Element | How to use it |
|---|---|---|
| 1 | Branch or Pull request | Select which list to use. **Pull request** shows the pull requests of the repository instead of the branch controls. |
| 2 | Branch | Select the branch to inspect. The most recent branches are first. The list does not show a remote branch that has a local copy, or the branches of agent tasks (the Tasks view shows them). Type in the filter box at the top of a long list to find a branch. This changes only what you see. Peekumi never switches your checkout. |
| 3 | Commit summary | The message and date of the head commit, and the commit that Peekumi compares it with. |
| 4 | Head revision | The newer commit in the comparison. |
| 5 | Compare with | The older commit. **Previous commit (automatic)** follows the first parent of the head. If you select a specific commit, Peekumi pins it until you select the automatic option again or tap **Use previous commit**. |
| 6 | Refresh | Looks for new commits. Peekumi never shows uncommitted work. |
| 7 | Close | Closes the popover. You can also tap anywhere outside the popover to close it. |

A list with more than 12 entries opens at the current entry. It has a filter box at the top and shows the number of entries at the bottom.

### Viewing a pull request

Tap **Pull request** in the comparison popover. The popover shows the open pull requests, then up to 10 recently merged pull requests. Each row shows the number, title, state, author and date. You see this list only when GitHub CLI is signed in on the host.

When you tap a pull request, the map shows all of its changes, from its merge base to its head. The header shows `PR #3 · base → head`. Tap **✕** next to it to go back to your branch.

When nothing is selected, the sheet shows the pull request:

- At the lowest sheet height, the sheet shows the state (Open, Draft, Merged or Closed), the branches, the title, the author, the date and the size.
- When you pull up the sheet, it also shows the first paragraph of the description, **Read full description**, one line for checks, one line for reviews and **Open on GitHub**. Tap **Checks** or **Reviews** to see the full list.

Select a card to see its details. To see the pull request again, tap an empty area of the map and go back to the top of the map. Ask uses the two commits of the pull request. Peekumi does not send comments or reviews to GitHub.

When you register more than one repository, a **Repository** picker shows above Branch.

<img src="guide/04-select-menu.jpg" width="340" alt="A frosted selection menu with a list of commits">

Each picker opens a menu like this one. A check mark (1) shows the current choice. Tap an option to select it. You can also use the arrow keys, Home, End and Enter. Escape closes the menu and makes no changes.

## Moving through history

<img src="guide/05-time.jpg" width="340" alt="Time mode with commit cards above the map">

In **Time**, a strip of commit cards shows above the map. The highlighted card (1) is the commit that Peekumi shows, compared with its parent. Tap a different card (2) to go to that commit. Swipe the strip to the side to see older commits.

## Selecting something

<img src="guide/06-selection-peek.jpg" width="340" alt="A selected function, with its summary and inputs in the sheet">

| # | Element | How to use it |
|---|---|---|
| 1 | Selected card | A blue outline shows the selection. Tap it again to open it. A folder or file opens on the map, and a declaration opens in Source. |
| 2 | Name and status | The name of the selection, its change status icon, and its type. For a modified declaration, a line such as **Signature and implementation changed** tells which parts to inspect. |
| 3 | Summary | Its committed documentation. Scroll it to read more. |
| 4 | Inputs, outputs and fields | One line each for the parameters, the return type and the class fields. Swipe to the side to see all of them. A fade on the right shows that there is more. Only declared types show here. The Details view puts a label on each missing annotation. |
| 5 | Up | Closes the file and goes back to its folder. |

## The review sheet

Drag the sheet up to half or full height to inspect the selection. The view buttons stay at the top of the sheet. If you move the sheet up, a different view never moves it down.

### Details

<img src="guide/07-details.jpg" width="340" alt="The Details view of a selected function">

| # | Element | How to use it |
|---|---|---|
| 1 | Details | Facts, documentation and declaration metadata for the selection. |
| 2 | Source | The code, as a diff or as the Before or After version. |
| 3 | Changes | Changed files or declarations in the current scope, and file search. |
| 4 | Relations | Dependencies, dependency rules and their evidence. |
| 5 | Discussion | Shows the conversation for the selection that agrees with the box below: your Ask questions and answers, or the instructions on the selection. |
| 6 | Facts | One quiet line after the content: the line range, or the file and change counts for a folder. |
| 7 | Main action | The next step for this selection, such as **View source**, **Open file**, **Open folder** or **Show evidence**. It is next to the facts. |
| 8 | Clear selection | Removes the selection and sets the sheet back to the current folder or file. |

Expanded Details is the peek view in full. It shows the full description and the same **In** and **Out** lines, with parameter defaults. It also shows notes on parameters where the code documents them. For a folder, it shows the README or package docstring of the folder as plain text, with a link to the full file. At the end, a small **adapter** note gives the name of the language adapter that read the file. Tap the note to see what the adapter extracts and its limits.

Only the open view button has a label. The other view buttons show only their icons. The [icon reference](#icon-reference) lists all of them.

### Source

<img src="guide/08-source.jpg" width="340" alt="The Source view with a highlighted declaration">

| # | Element | How to use it |
|---|---|---|
| 1 | Diff / After / Before | **Diff** shows the changes with old and new line numbers. **After** and **Before** show the full file at the head or base. |
| 2 | Code | Scrolls in its own box. This box fills the sheet, so the controls above it stay in position. When you select a declaration, **Diff** shows only the changes to that declaration. |
| 3 | Highlight | Peekumi highlights the lines of the selected declaration and scrolls them into view. |

### Changes

<img src="guide/09-changes.jpg" width="340" alt="The Changes view with a list of changed files">

| # | Element | How to use it |
|---|---|---|
| 1 | Overview | The number of files that changed in the current scope, with counts for each change type. |
| 2 | Search | Finds any file in the repository by its path, changed or unchanged. |
| 3 | Changed file | Tap to open the file on the map. In a file, the list shows changed declarations, not files. |

### Relations

<img src="guide/10-relations.jpg" width="340" alt="The Relations view for a selected function">

| # | Element | How to use it |
|---|---|---|
| 1 | Rule summary | Results of the dependency rules committed in `.peekumi.json`. Expand it to see configuration details and analysis gaps. If there is no rules file, it says that rules are not configured. |
| 2 | Relationship kind | Show all relationships, or only imports, calls, implementations or inheritance. |
| 3 | Violations only | Show only relationships that break a dependency rule. |
| 4 | Relationship | `from → to`, with its kind, its change status, and the number of sites before and after. Tap it to select it and to see a button for each file that it involves. |
| 5 | Resolved evidence | Each relationship that Peekumi found in the code, with a link that opens the exact source line. |
| 6 | Unresolved targets | References that Peekumi cannot resolve with certainty, and the reason. Peekumi lists these references and does not guess. |

## Ask, instructions and tasks

**Ask** uses Claude Code on this computer to answer questions about the selection. It reads only committed code. It cannot run, change or send anything. For a file or declaration, it reads the source and its diff. It also reads what the code calls, imports or inherits, and what calls the code. For a folder or the whole repository, it reads the README of that folder, the declarations in it and the diffs of its changed files.

When that is not sufficient, Ask can look up more of the repository at the same revisions. It can search declarations or the code, read a declaration or file, and follow relationships. It can do up to 30 lookups for each answer. Before it answers, Ask checks each fact that the answer depends on. If a first draft leaves a fact unchecked, Ask checks it and writes the answer again. The answer shows while Ask writes it. Ask shows each lookup while it occurs, and lists what it looked up.

Some names of files and declarations in an answer point to exactly one location. These names have a dotted underline. Tap one, and the map moves to that location and selects it. Your question shows immediately when you send it. You can type the next question while the answer loads. Answers are in ASD-STE100 Simplified Technical English: short sentences, one meaning for each word, and steps as numbered instructions.

If the answer ends with a suggested instruction, **Save as draft instruction** keeps it as a draft for the same selection. When you explore the changes of a task, this button shows **Add to requested changes**. The save button of the Instruction box also shows this label. Each of these buttons adds the change, at the location that it is about, to the next round of that task. Then you can continue to explore. Peekumi does this because a new draft starts from main and does not contain the work of the agent.

The **Back to task** chip shows the number of changes that wait ("2 to send"). The task lists those changes, and you can edit them. The button below the list sends them together, for example **Send 2 changes to Codex**.

One conversation continues for the session. It stays on the screen while you move on the map. Each question is about the item that is selected when you send it. "About …" shows where the subject changes. Each branch has its own conversation. When you explore the branch of an agent, Ask shows the conversation for that branch. When you go back, Ask shows the conversation for your branch again. Peekumi keeps each conversation, so a reload or an app update does not remove it. **New conversation** clears the conversation for the branch that you see.

<img src="guide/11-comment.jpg" width="340" alt="The Instruction box while you write a draft instruction">

| # | Element | How to use it |
|---|---|---|
| 1 | Instruction | Changes the box from a question to an instruction for an agent. |
| 2 | Anchor | The selection and commit that the instruction is attached to. It stays attached if you go to a different location before you save. |
| 3 | Instruction text | Describe the change that you want and the reason for it. |
| 4 | Cancel | Discards the unsent instruction. |
| 5 | Save draft | Saves the instruction as a draft. Discussion shows the draft for that selection. Drafts are private until you send them to an agent. |

<img src="guide/12-tasks.jpg" width="340" alt="The Tasks view with one draft instruction">

| # | Element | How to use it |
|---|---|---|
| 1 | Review task | Makes a task from your drafts. Select the drafts, the agent (Codex or Claude Code) and optional extra instructions. Then look at a preview of the exact task before you start it. |
| 2 | Draft | A saved instruction with its anchor and commit. You can edit or delete it while it is a draft. |

After a task starts, the same view shows the progress of the agent, the checks that the agent reports and the commits that it made. The task first shows its state, then each instruction and the result from the agent. **Explore changes** shows all the work of the agent on the map, compared with the commit that the task started from. **Back to task** takes you back to the task and your previous view. **Agent log** contains the messages of the agent, the raw events and the generated task.

**Approve** records your review. To add a note, tap **Add note** first. To ask for changes, write each change in the box at the bottom of the task and tap ✓. Peekumi adds the change to the list of the task. **Request changes** puts the cursor in that box. Then tap the button below the list, for example **Send 1 change to Codex**. The same agent starts the next round. That round starts from the last commit of the agent, so Peekumi keeps the earlier work. To open an earlier round, use **Open round N** in the latest round.

The Tasks list puts tasks in groups by what they need from you. **Needs you** has drafts and tasks to review. **Working** has the tasks that an agent works on now. **Done · waiting to merge** has approved tasks that you did not merge yet, and these are muted. When a task is applied to main, it goes to **History**. A link at the bottom of the list opens History. On a selection, approved instructions and instructions of applied tasks go into one line, "N earlier instructions", which opens when you tap it.

The Tasks button is a toggle. To go back to the map selection, tap it again or tap an empty area of the map. While an agent works, Peek works inside the Tasks button in all parts of the app. Tap the button to open that task. When the agent completes its work, Peek jumps one time and the icon becomes blue for review. If Peek droops on an orange tint, a task stopped before it was complete and needs your action.

Approval of a task does not change your code. After you approve, the task shows **Ready to merge into main**, with the number of commits and changed files. Tap **Merge into main**, then **Merge** to confirm. Peekumi does a fast-forward of main to the last commit of the task. It never pushes. After the merge, the task shows **Merged into main** and an **Undo merge** button. Undo works until main changes.

If you have uncommitted changes in a file that the merge changes, the task shows the files that are in the way. Tap **Commit my changes, then merge**. An agent writes a commit message for only those files. Examine the files and the message, then tap **Commit**. If main has new commits, tap **Update with main**. If main and the task conflict, the agent resolves the conflict in a new round, and you review the task again. Refer to [WORKFLOW.md](WORKFLOW.md) for the full loop.

## Typing on a phone

<img src="guide/13-keyboard.jpg" width="340" alt="The layout with the phone keyboard open">

When the keyboard opens, the header and the map controls move away. The sheet keeps its size at peek height, and the text field (1) stays above the keyboard. The map stays on the screen, so you can still see the subject of your question.

## Desktop layout

<img src="guide/14-desktop.jpg" width="720" alt="The desktop layout in dark mode">

On a wide screen, the header (1) is across the top and the map (2) fills the left side. The review sheet (3) is on the right at full height. All other functions operate the same way. Peekumi uses the light or dark appearance of the system.

## Icon reference

Each icon button has a name. The name shows as a tooltip, and screen readers read it.

### Header and map

| Icon | Name | What it does |
|---|---|---|
| <img src="guide/icons/glyph-branch.svg" width="20" alt=""> | Branch | Marks the comparison line. Tap it to change the branch or the comparison. |
| <img src="guide/icons/glyph-time.svg" width="20" alt=""> | Time | Go through the history with commit cards. |
| <img src="guide/icons/glyph-diff.svg" width="20" alt=""> | Diff | Compare any two commits. |
| <img src="guide/icons/glyph-tasks.svg" width="20" alt=""> | Tasks | Drafts and agent runs. |
| <img src="guide/icons/glyph-before.svg" width="20" alt=""> | Before | Show the base revision. |
| <img src="guide/icons/glyph-after.svg" width="20" alt=""> | After | Show the head revision. |
| <img src="guide/icons/glyph-home.svg" width="20" alt=""> | Home | Go to the repository root. |
| <img src="guide/icons/glyph-up.svg" width="20" alt=""> | Up | Go up one level. |
| <img src="guide/icons/glyph-filter.svg" width="20" alt=""> | Changes only | Hide unchanged cards. |
| <img src="guide/icons/glyph-zoomOut.svg" width="20" alt=""> | Zoom out | Zoom the map out. |
| <img src="guide/icons/glyph-zoomIn.svg" width="20" alt=""> | Zoom in | Zoom the map in. |
| <img src="guide/icons/glyph-fit.svg" width="20" alt=""> | Fit | Fit the map on the screen. |
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
| <img src="guide/icons/glyph-pin.svg" width="20" alt=""> | Anchor | The subject of the question or instruction. |
| <img src="guide/icons/glyph-send.svg" width="20" alt=""> | Send | Send the question. |
| <img src="guide/icons/glyph-check.svg" width="20" alt=""> | Save draft | Save the instruction. |
| <img src="guide/icons/glyph-close.svg" width="20" alt=""> | Cancel or close | Discard, or close a popover. |
| <img src="guide/icons/glyph-copy.svg" width="20" alt=""> | Copy | Copy the command that applies a reviewed task. |
| <img src="guide/icons/glyph-refresh.svg" width="20" alt=""> | Refresh | Look for new commits. |

### Change status

Each status has its own shape and its own colour.

| Icon | Status |
|---|---|
| <img src="guide/icons/status-added.svg" width="20" alt=""> | Added |
| <img src="guide/icons/status-changed.svg" width="20" alt=""> | Modified |
| <img src="guide/icons/status-removed.svg" width="20" alt=""> | Removed |
| <img src="guide/icons/status-unchanged.svg" width="20" alt=""> | Unchanged |

### Folders, files and declarations

Icons show what a card is. They never show its change status. Source files are files that a language adapter parsed. Peekumi identifies other files by their extension.

| Icon | Kind | Icon | Kind |
|---|---|---|---|
| <img src="guide/icons/object-folder.svg" width="20" alt=""> | Folder | <img src="guide/icons/file-code.svg" width="20" alt=""> | Source file |
| <img src="guide/icons/object-files.svg" width="20" alt=""> | Repository files (root files group) | <img src="guide/icons/file-document.svg" width="20" alt=""> | Documentation |
| <img src="guide/icons/object-class.svg" width="20" alt=""> | Class or struct | <img src="guide/icons/file-data.svg" width="20" alt=""> | Data or configuration |
| <img src="guide/icons/object-function.svg" width="20" alt=""> | Function or method | <img src="guide/icons/file-image.svg" width="20" alt=""> | Image |
| <img src="guide/icons/object-interface.svg" width="20" alt=""> | Interface or trait | <img src="guide/icons/file-sealed.svg" width="20" alt=""> | Binary or restricted file (no preview) |
| <img src="guide/icons/object-enum.svg" width="20" alt=""> | Enum | <img src="guide/icons/file-file.svg" width="20" alt=""> | Other file |

### Changed parts of a declaration

A modified declaration shows which parts changed, on its card and in the sheet. Peekumi compares the structure of the code, not its behaviour. Peekumi does not count changes to whitespace only. "Implementation" means that the code in the body changed, not that the behaviour is different. A change outside these parts, for example a Python decorator, shows as plain **Modified**.

| Icon | Part | What changed |
|---|---|---|
| <img src="guide/icons/part-signature.svg" width="20" alt=""> | Signature | Parameters, return type, generics, base classes, or the declared fields of a struct or class |
| <img src="guide/icons/part-documentation.svg" width="20" alt=""> | Documentation | Doc comments or docstrings |
| <img src="guide/icons/part-implementation.svg" width="20" alt=""> | Implementation | The code of the body, without documentation |

### Inputs and outputs

| Icon | Meaning |
|---|---|
| <img src="guide/icons/contract-in.svg" width="20" alt=""> | Inputs: parameters |
| <img src="guide/icons/contract-out.svg" width="20" alt=""> | Outputs: return type or description |
| <img src="guide/icons/contract-fields.svg" width="20" alt=""> | Fields declared on a class |

## Offline and updates

Peekumi runs on your own computer, and the phone app is a window into it. If the phone loses its connection, a banner tells you. Peekumi stores no code on the phone. When the server has a new version, the app shows **Update available · reload**. Save all unsent text, and then tap the message. Changes to the name, icon or full-screen mode of the app occur after you remove the app from the home screen and add it again.
