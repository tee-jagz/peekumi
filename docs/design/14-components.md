# Components

Every screen is built from these parts. Each part is a function in `frontend/ui.js` with the same name, and its styles are the `pk-` classes in `frontend/ui.css`. The mockups in `mockups/` render the same functions. A new part needs a row in this table, with a reason, before it is built.

## Basics

| Component | What it is | Variants | Replaces now |
|---|---|---|---|
| `Button` | An action with a verb label, `label` style, `radius-sm`, 44px high. | primary (`accent` fill), secondary (`line-strong` border), plain (text only), danger (`danger` text) | Glass buttons, `.btn`, `.link-button` with " ›" |
| `IconButton` | A 44px square with one 20px icon and an accessible name. | default, pressed, with status dot | Round 38px buttons, "×" and "‹" text glyphs |
| `SegmentedControl` | Two to four related choices that change one view. | text, icon | Time or Diff, Ask or Instruction or Session, Before or After, Branch or Pull request |
| `Tabs` | The sheet tabs: Details, Source, Changes, Relations. Icon with a label. | None | `#helperTools` |
| `TextField` | One line of input, 16px, `surface-sunken`, `line-strong` border. | default, error | Frosted fields |
| `TextArea` | Multi-line input, 16px, grows to 40% of the visible height. | default, error | `.fix-text`, the composer field |
| `Select` | A field that opens a `Menu` with the choices. | None | The frosted select |
| `Checkbox` | 20px box in a 44px row. | None | Native checkboxes in fix and rule rows |
| `Choices` | One choice from a short list, as rows with a check on the chosen one. For the comparison choices. | None | The head and base selects |
| `Disclosure` | A row that opens more detail below it, with the `chevron` icon. | None | `details` with `.p-section` cards |

## Layout

| Component | What it is |
|---|---|
| `AppShell` | The page frame: the header, the commit rail, the map, the sheet and an overlay for a dialog. From 900px wide, the sheet becomes a right panel. |
| `Stack` | Parts in a column with the standard gap. |
| `Actions` | A row of buttons, or a column with `stack`. |
| `List` | Rows with hairlines between them. |
| `Group` | A group heading and its content. |
| `Text` and `Note` | Words in the body style, and a quiet note in `body-sm`. |

## Content

| Component | What it is | Replaces now |
|---|---|---|
| `Row` | A list row: main line (`title` or `body-sm`), an optional caption, an optional figure, and a chevron when it opens a page. 44px or more. Hairlines between rows, no box. | Frosted list cards, `.task-link`, `.break-row`, relation rows |
| `MetaLine` | A caption with at most two items joined by " · ". | Long dot strings |
| `FactGrid` | Two to four facts as label and value pairs, values in `figure` or `body-sm`. | Dot strings in task heads |
| `StatusLabel` | A state word with its icon and colour (see **Tasks and review**). | Coloured text only |
| `StatusMark` | A `+`, `~` or `−` count, or the broken-link count, in its colour. | `.n-counts`, `.n-breaks` |
| `Figure` | One key number with its unit. | New |
| `InlineCode` | Code in running text, `mono` on `surface-sunken`. | New |
| `CodeLink` | `InlineCode` that opens a place on the map, with a dotted `accent` underline. | `.code-link` |

## The shell

| Component | What it is |
|---|---|
| `AppHeader` | The repository name, the `ComparisonLine`, and up to three header buttons. |
| `ComparisonLine` | Branch, base and head (`code-sm`, `ink-muted`). It opens the comparison menu. Shows "Offline" and "Update ready". |
| `ReviewSheet` | The non-modal bottom sheet with its grabber and three heights; the right panel on desktop. Glass. |
| `SheetTitleRow` | Status, name and kind of the selection, with the one key line (and its action, such as **Fix**) and a `LiveLine` or `ChangeTray`. |
| `PageHeader` | Back, the page title (`title-lg`), a `MetaLine` and at most two `IconButton` actions. |
| `Composer` | The place it is about, the field, **Add as a change** and **Ask** (the `intent` variant of **Flows**, flow 2), or today's mode `SegmentedControl`. Glass. |
| `ChangeTray` | The changes that wait for an agent, as one button: "2 changes · Send". Every change goes through it (**Flows**, F2). |
| `LiveLine` | Peek in the agent's activity or state (28px), then the agent's name and step ("Claude Code · Reads lookup.rs"), or "Needs you", in one line. |

## The map

| Component | What it is |
|---|---|
| `MapCanvas` | The single SVG canvas with zoom, pan and the zoom levels. |
| `MapCard` | A folder, file or declaration card with its icon, name, `StatusMark` counts, the change bar for a folder, and its states (selected, dimmed, unchanged, removed, uncommitted, agent here). |
| `MapEdge` | A dependency line in its style: import, call, implements, rule break, added, removed. |
| `MapControls` | Home, Up, Changes only, Zoom out, Zoom in, Fit and Key, each 44px. |
| `MapKey` | The popover that explains status marks and line styles. |
| `TimeRail` and `CommitCard` | The commit strip in Time mode only. |
| `MapList` | The list view of the same tree, for screen readers and one-hand use. |

## Code

| Component | What it is |
|---|---|
| `SourceBlock` | Source with line numbers and the selected declaration marked. |
| `DiffBlock` | A unified diff (split from 768px) with tints, word marks, signs and hunk headers. |
| `CollapsedLines` | The "Show 24 lines" row in a diff. |

## Tasks and review

| Component | What it is |
|---|---|
| `TaskRow` | A `Row` with the task's title, its `StatusLabel` and the time. |
| `TaskGroup` | A heading ("Needs you") and its rows. |
| `InstructionReport` | One instruction with the agent's report and its commit. |
| `ProgressSteps` | The current step of a long run, and the time since the start. |
| `ApprovalPrompt` | A command to allow or deny in a session. |
| `MergeDialog` | The modal confirmation of a merge, with its facts and undo note. |
| `ProposalRow` | A proposed fix or rule: `Checkbox`, the plain sentence, a `MetaLine`, the figure, its notes and errors, and a `Disclosure` to edit. A row that went to an agent is muted. |

## Feedback

| Component | What it is |
|---|---|
| `InlineError` | An error where it happened, with the fix. |
| `EmptyState` | Peek in the `empty` state, one line and one button. |
| `Skeleton` | Grey blocks in the shape of the content. |
| `Spinner` | A small spinner for one part. |
| `Toast` | A passive confirmation that fades. Never an error. |
| `Menu` | The context menu and select menus: `surface`, `radius-md`, `shadow-float`, 44px items. |
| `Popover` | The key and the comparison menu. |
| `Dialog` | A modal dialog with the `scrim`. |
| `Modal` | A modal sheet: a native dialog over the `scrim`, at the bottom of a phone and in the middle from 900px. Escape and a tap on the scrim close it. `openModal` shows it. For the Agents sheet. |
| `Peek` | The mascot in one of its states or activity poses, from `frontend/peek.js`, in the places that **Peek** gives. |
