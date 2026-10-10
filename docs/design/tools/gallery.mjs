/**
 * @module The component gallery: one preview for each part in frontend/ui.js, with its group,
 * its preview height and a short guide. make.mjs writes each one as a mockup page and as a card
 * of the design system artifact. Every preview uses only ui.js; the small frames here (box,
 * stage) are the gallery's own and never part of the app.
 */
import * as ui from "../../../frontend/ui.js";

const {
  Actions,
  AppHeader,
  ApprovalPrompt,
  BreakMark,
  Button,
  Checkbox,
  Code,
  CodeLink,
  Command,
  ComparisonLine,
  Composer,
  DiffBlock,
  Dialog,
  Disclosure,
  EmptyState,
  FactGrid,
  Figure,
  Group,
  IconButton,
  InlineError,
  InstructionReport,
  LineSample,
  List,
  LiveLine,
  MapCanvas,
  MapCard,
  MapKey,
  MapList,
  Menu,
  MergeDialog,
  MetaLine,
  Note,
  PageHeader,
  Popover,
  ProgressSteps,
  ProposalRow,
  ReviewSheet,
  Row,
  SegmentedControl,
  Select,
  SheetTitleRow,
  Skeleton,
  SourceBlock,
  Spinner,
  StatusLabel,
  StatusMarks,
  Tabs,
  TaskRow,
  Text,
  TextArea,
  TextField,
  TimeRail,
  Toast,
  AppShell,
  Stack,
  ChangeTray,
  Choices,
} = ui;

/** A gallery element (not an app part). */
export function frame(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.setAttribute("class", className);
  for (const c of children.flat())
    if (c != null && c !== false)
      node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}
/** A map preview with a fixed height: outside an AppShell, the map has no height of its own. */
const tall = (node, height) => {
  node.setAttribute("style", `height: ${height}px`);
  return node;
};
/** A padded preview box on the surface. */
const box = (...children) => frame("div", "pk gallery-box", ...children);
/** A preview in an AppShell of the given height, with a sheet or an overlay. */
const stage = (height, sheetHeight, sheet, overlay) => {
  const shell = AppShell({ sheet, overlay, sheetHeight });
  shell.setAttribute("style", `height: ${height}px`);
  return shell;
};
/** A preview on the glass ground. */
const glass = (...children) => frame("div", "pk gallery-glass", ...children);
const keyRow = (kind, text) =>
  frame("div", "pk-key-row", LineSample(kind), text);
const peekCell = (state, text, tiled = false) =>
  frame(
    "figure",
    "gallery-peek",
    ui.Peek({ state, tiled }),
    frame(
      "figcaption",
      "",
      frame("code", "", tiled ? "tile" : state),
      frame("span", "", text),
    ),
  );

export const COMPARE = () =>
  ComparisonLine({ branch: "main", base: "ea2ae7f", head: "c63a1eb" });
export const ACTIVITY = [
  ["reading", "Reads lookup.rs"],
  ["searching", "Searches names_tree"],
  ["editing", "Edits graph_brief.rs"],
  ["creating", "Creates brief_test.rs"],
  ["running", "Runs cargo test"],
  ["working", "Works"],
];
const PEEK_ACTIVITY = [
  ["reading", "Read, a map lookup"],
  ["searching", "Grep, Glob"],
  ["editing", "Edit, Write to a file"],
  ["creating", "Write a new file"],
  ["running", "A command, the tests"],
  ["working", "Any other step"],
];
const PEEK_STATES = [
  ["idle", "Pairing, the home of the app"],
  ["loading", "The app or the map loads"],
  ["thinking", "An agent needs you"],
  ["ready", "A task is ready for review"],
  ["success", "A step is done"],
  ["merged", "Merged into main"],
  ["empty", "Nothing here yet"],
  ["asleep", "Offline"],
  ["stopped", "A task stopped"],
  ["error", "A run failed"],
];
export const DIFF = [
  { kind: "@", code: "@@ -186,7 +186,9 @@ pub async fn map(app: &App)" },
  {
    kind: " ",
    old: 186,
    new: 186,
    code: [["    "], ["// The names of the map, folded to the budget.", "c"]],
  },
  {
    kind: "-",
    old: 187,
    code: [
      ["    let tree = "],
      ["lookup::names_tree", "del"],
      ["(app, base).await;"],
    ],
  },
  {
    kind: "+",
    new: 187,
    code: [["    let tree = "], ["names_tree", "add"], ["(app, base).await;"]],
  },
  {
    kind: "+",
    new: 188,
    code: [["    "], ["// Moved here: lookup.rs uses the map brief.", "c"]],
  },
  {
    kind: " ",
    old: 188,
    new: 189,
    code: [["    fold(tree, "], ["12_000", "s"], [")"]],
  },
  { kind: " ", old: 189, new: 190, code: "}" },
];

/** { name, group, height, readme, render } for each component. */
export const COMPONENTS = [
  {
    name: "Button",
    group: "Basics",
    height: 210,
    readme:
      "A button does one action and has a verb as its label. Use primary for the one main action of a view, at most once. Use secondary for other actions, plain for quiet actions and links to a page, and danger for destructive actions. Every button is 44px high.",
    render: () =>
      box(
        Actions(
          {},
          Button({ label: "Approve", variant: "primary" }),
          Button({ label: "Request changes" }),
        ),
        Actions(
          {},
          Button({ label: "Explore changes", variant: "plain" }),
          Button({ label: "Undo merge", variant: "danger" }),
          Button({ label: "Merge into main", disabled: true }),
        ),
        Button({
          label: "Propose fixes for 2 rule breaks",
          variant: "primary",
          block: true,
        }),
      ),
  },
  {
    name: "IconButton",
    group: "Basics",
    height: 120,
    readme:
      "An icon button is a 44px square with one icon and an accessible name. Use the quiet variant inside the sheet. A status dot shows that an agent works (accent) or needs the owner (warning).",
    render: () =>
      box(
        Actions(
          {},
          IconButton({ icon: "tasks", label: "Tasks" }),
          IconButton({
            icon: "tasks",
            label: "Tasks, an agent works",
            dot: "accent",
          }),
          IconButton({
            icon: "tasks",
            label: "Tasks, needs you",
            dot: "warning",
          }),
          IconButton({
            icon: "bell",
            label: "Notifications on",
            pressed: true,
          }),
          IconButton({ icon: "back", label: "Back", quiet: true }),
          IconButton({ icon: "close", label: "Close", quiet: true }),
        ),
      ),
  },
  {
    name: "SegmentedControl",
    group: "Basics",
    height: 150,
    readme:
      "A segmented control holds two to four related choices that change one view: Time or Diff, Before or After, the composer modes. The chosen segment uses accent-subtle.",
    render: () =>
      box(
        SegmentedControl({
          label: "Mode",
          value: "diff",
          options: [
            { value: "time", label: "Time", icon: "time" },
            { value: "diff", label: "Diff", icon: "diff" },
          ],
        }),
        SegmentedControl({
          label: "Side",
          value: "after",
          options: [
            { value: "before", label: "Before" },
            { value: "after", label: "After" },
          ],
        }),
      ),
  },
  {
    name: "Tabs",
    group: "Basics",
    height: 100,
    readme:
      "The sheet tabs: Details, Source, Changes and Relations. Each tab is an icon; the selected tab also shows its name.",
    render: () => box(Tabs({ selected: "relations" })),
  },
  {
    name: "TextField",
    group: "Basics",
    height: 210,
    readme:
      "A one-line input at 16px on surface-sunken with a line-strong border. Put its label above it. An error shows under the field in danger, with what to do.",
    render: () =>
      box(
        TextField({ label: "Branch name", value: "peekumi/run-65c6" }),
        TextField({
          label: "OpenRouter key",
          value: "sk-or-v1-…",
          error: "The key was refused. Check it in your OpenRouter account.",
        }),
      ),
  },
  {
    name: "TextArea",
    group: "Basics",
    height: 170,
    readme:
      "Multi-line input at 16px. It grows with its text up to 40% of the visible height, then it scrolls.",
    render: () =>
      box(
        TextArea({
          label: "Instruction",
          value:
            "Move names_tree into graph_brief.rs, so lookup.rs uses it and not the other way round.",
        }),
      ),
  },
  {
    name: "Select",
    group: "Basics",
    height: 110,
    readme:
      "A field that opens a Menu with the choices. Use it for lists longer than four choices.",
    render: () =>
      box(
        Select({
          label: "Compare with",
          value: "0f16f55 Propose only missing rules",
        }),
      ),
  },
  {
    name: "Checkbox",
    group: "Basics",
    height: 130,
    readme: "A 20px box in a 44px row, with its label as the row text.",
    render: () =>
      box(
        Checkbox({ label: "Fix the graph brief cycle", checked: true }),
        Checkbox({ label: "Keep services apart" }),
      ),
  },
  {
    name: "Disclosure",
    group: "Basics",
    height: 160,
    readme:
      "A row that opens more detail below it. Use it for rule JSON, evidence and other detail that most owners do not need.",
    render: () =>
      box(
        Disclosure(
          { summary: "Edit rule", open: true },
          Command(
            '{"id": "graph-brief-not-lookup",\n "from": "graph-brief", "to": ["lookup-tools"]}',
          ),
        ),
      ),
  },
  {
    name: "Row",
    group: "Content",
    height: 250,
    readme:
      "A list row: the main line, an optional caption, an optional figure and a chevron when it opens a page. Rows are at least 44px and have hairlines between them, not boxes.",
    render: () =>
      box(
        List(
          TaskRow({
            title: "Fix the graph brief cycle",
            state: "ready",
            stateText: "Ready for review",
            detail: "12 min ago",
          }),
          Row({
            title: "rules.rs",
            meta: "3 calls from engine.rs",
            end: Figure({ value: 2, unit: "breaks", danger: true }),
          }),
          Row({ title: "Notifications", small: true }),
        ),
      ),
  },
  {
    name: "MetaLine",
    group: "Content",
    height: 90,
    readme:
      "A caption with at most two items joined by a middle dot. More facts go in a FactGrid.",
    render: () =>
      box(
        MetaLine("Separation of concerns", "Medium"),
        MetaLine(Code("0f16f55"), "2 min ago"),
      ),
  },
  {
    name: "FactGrid",
    group: "Content",
    height: 150,
    readme:
      "Two to four facts as label and value pairs. Use it at the top of a task or a selection, in place of a long meta line.",
    render: () =>
      box(
        FactGrid([
          ["Files changed", 4],
          ["Commits", 3],
          ["Rule breaks added", 0],
          ["Run time", "6 min"],
        ]),
      ),
  },
  {
    name: "StatusLabel",
    group: "Content",
    height: 150,
    readme:
      "A state word with its dot and colour, always together: Draft, Working, Needs you, Ready for review, Approved, Merged into main, Stopped and Failed.",
    render: () =>
      box(
        Actions(
          {},
          ...[
            ["draft", "Draft"],
            ["working", "Working"],
            ["needs", "Needs you"],
            ["ready", "Ready for review"],
            ["approved", "Approved"],
            ["merged", "Merged into main"],
            ["stopped", "Stopped"],
            ["failed", "Failed"],
          ].map(([state, text]) => StatusLabel({ state, text })),
        ),
      ),
  },
  {
    name: "StatusMark",
    group: "Content",
    height: 100,
    readme:
      "A count with its sign and colour: + added, ~ modified, \u2212 removed, and the broken-link count for rule breaks. Never colour alone.",
    render: () =>
      box(
        StatusMarks({ added: 2, modified: 4, removed: 1, files: 34 }),
        BreakMark({ text: "2 rule breaks" }),
      ),
  },
  {
    name: "Figure",
    group: "Content",
    height: 90,
    readme:
      "One key number with its unit, at 20px. Use one for each row or view.",
    render: () =>
      box(
        Actions(
          {},
          Figure({ value: 31, unit: "breaks" }),
          Figure({ value: 2, unit: "new breaks", danger: true }),
          Figure({ value: 6, unit: "min" }),
        ),
      ),
  },
  {
    name: "InlineCode",
    group: "Content",
    height: 110,
    readme:
      "Code in running text, in the mono family on surface-sunken. A CodeLink is inline code that opens a place on the map.",
    render: () =>
      box(
        Text(
          "The runner now calls ",
          Code("RunStore::finish"),
          " through the trait. See ",
          CodeLink({ text: "run_store.rs" }),
          ".",
        ),
      ),
  },
  {
    name: "AppHeader",
    group: "Shell",
    height: 120,
    readme:
      "The repository name, the comparison line and up to three header buttons. On a phone it is one row; the comparison line opens the comparison menu.",
    render: () =>
      AppHeader({ name: "peekumi", comparison: COMPARE(), tasksDot: "accent" }),
  },
  {
    name: "ComparisonLine",
    group: "Shell",
    height: 120,
    readme:
      "Branch, base and head in code-sm. It shows Offline and Update ready in the same place.",
    render: () => box(COMPARE(), ComparisonLine({ offline: true })),
  },
  {
    name: "ReviewSheet",
    group: "Shell",
    height: 300,
    readme:
      "The non-modal bottom sheet over the map, at Peek, Half or Full height. It is glass with a blur, radius-lg on its top corners and shadow-float. On a desktop it is a right panel.",
    render: () =>
      stage(
        300,
        250,
        ReviewSheet(
          {},
          SheetTitleRow({
            icon: "obj-file",
            name: "engine.rs",
            kind: "File",
            keyLine: "Breaks backend-layers",
          }),
          Tabs({ selected: "details" }),
        ),
      ),
  },
  {
    name: "SheetTitleRow",
    group: "Shell",
    height: 140,
    readme:
      "The selection's icon, name and kind, the one key line (a rule break, uncommitted changes) and the LiveLine or Back to task at the right.",
    render: () =>
      box(
        SheetTitleRow({
          icon: "obj-folder",
          name: "backend",
          kind: "Folder",
          keyLine: "2 rule breaks start here",
          end: LiveLine({
            text: "Claude Code · Edits 3 files",
            state: "editing",
          }),
        }),
      ),
  },
  {
    name: "PageHeader",
    group: "Shell",
    height: 120,
    readme:
      "Back, the page title in title-lg, a MetaLine and at most two IconButton actions.",
    render: () =>
      box(
        PageHeader({
          title: "Tasks",
          meta: MetaLine("2 need you", "1 working"),
          actions: [
            IconButton({
              icon: "bellOff",
              label: "Turn on notifications",
              quiet: true,
            }),
            IconButton({ icon: "agents", label: "Agents", quiet: true }),
          ],
        }),
      ),
  },
  {
    name: "Composer",
    group: "Shell",
    height: 160,
    readme:
      "The mode control, the place it is about, the 16px field and the send button. It stays at the bottom of the sheet, above the keyboard.",
    render: () =>
      glass(
        Composer({ intent: true, value: "Why does engine.rs call rules.rs?" }),
        Composer({}),
      ),
  },
  {
    name: "LiveLine",
    group: "Shell",
    height: 470,
    readme:
      "One line for the agent's state: Peek in that state, then the agent's name and step, or Needs you. It opens the run.",
    render: () =>
      box(
        Actions(
          { stack: true },
          ...ACTIVITY.map(([state, text]) =>
            LiveLine({ text: `Claude Code · ${text}`, state }),
          ),
          LiveLine({ text: "Needs you", state: "thinking", needs: true }),
          LiveLine({ text: "Ready for review", state: "ready" }),
          LiveLine({ text: "Stopped", state: "stopped" }),
        ),
      ),
  },
  {
    name: "MapCard",
    group: "Map",
    height: 460,
    readme:
      "A folder, file or declaration on the map: type icon, name, StatusMark counts, the change bar for a folder, and its states. Changed cards have a surface ground and a line border; unchanged cards step back. Peek's head marks the card where the agent works.",
    render: () =>
      tall(
        MapCanvas({
          width: 390,
          height: 460,
          controls: false,
          cards: [
            MapCard({
              name: "backend",
              x: 16,
              y: 16,
              width: 170,
              height: 124,
              description: "The Rust backend serves the API.",
              modified: 4,
              added: 2,
              files: 34,
              breaks: 2,
            }),
            MapCard({
              name: "engine.rs",
              x: 202,
              y: 16,
              width: 170,
              height: 124,
              kind: "file",
              code: true,
              modified: 3,
              states: ["selected"],
            }),
            MapCard({
              name: "lookup.rs",
              x: 16,
              y: 184,
              width: 170,
              height: 76,
              kind: "file",
              code: true,
              modified: 1,
              states: ["agent"],
              doing: "editing",
            }),
            MapCard({
              name: "legacy.rs",
              x: 202,
              y: 184,
              width: 170,
              height: 76,
              kind: "file",
              code: true,
              removed: 1,
              states: ["removed"],
            }),
            MapCard({
              name: "Repository files",
              x: 16,
              y: 276,
              width: 170,
              height: 76,
              kind: "rootfiles",
              modified: 1,
              files: 21,
              uncommitted: true,
            }),
            MapCard({
              name: "scripts",
              x: 202,
              y: 276,
              width: 170,
              height: 76,
              files: 15,
              states: ["unchanged"],
            }),
            MapCard({
              name: "names_tree()",
              x: 16,
              y: 368,
              width: 170,
              height: 76,
              kind: "function",
              code: true,
              modified: 1,
            }),
            MapCard({
              name: "docs",
              x: 202,
              y: 368,
              width: 170,
              height: 76,
              files: 91,
              states: ["unchanged", "dim"],
            }),
          ],
        }),
        440,
      ),
  },
  {
    name: "MapEdge",
    group: "Map",
    height: 200,
    readme:
      "A dependency line in its style: import or call solid, implements dotted, outgoing dashed when a card is selected, a rule break dashed in danger with the broken-link mark at its middle, added in added and removed dashed in removed.",
    render: () =>
      box(
        ...[
          ["import", "Import or call"],
          ["impl", "Implements or inherits"],
          ["out", "Outgoing, when selected"],
          ["break", "Breaks a rule"],
          ["added", "Added"],
          ["removed", "Removed"],
          ["selected", "Selected"],
        ].map(([kind, text]) => keyRow(kind, text)),
      ),
  },
  {
    name: "MapControls",
    group: "Map",
    height: 100,
    readme:
      "Home, Up, Changes only, Zoom out, Zoom in, Fit and Key, each 44px, in one floating bar at the bottom of the map.",
    render: () => tall(MapCanvas({ width: 390, height: 100 }), 100),
  },
  {
    name: "MapKey",
    group: "Map",
    height: 480,
    readme:
      "The popover that explains the status marks and line styles, once, so no other screen needs to explain them.",
    render: () => box(MapKey()),
  },
  {
    name: "TimeRail",
    group: "Map",
    height: 110,
    readme:
      "The commit strip of Time mode: one CommitCard for each commit, newest at the right. The current one uses accent-subtle.",
    render: () =>
      TimeRail([
        { hash: "6fbffff", subject: "Wait for a busy agent" },
        { hash: "47a9930", subject: "Session rule check" },
        { hash: "34e5c64", subject: "Rules keep their groups" },
        { hash: "c63a1eb", subject: "Fixes in the background", current: true },
      ]),
  },
  {
    name: "MapList",
    group: "Map",
    height: 260,
    readme:
      "The list view of the same tree, for screen readers and one-hand use. Each row has the name, the status and the counts.",
    render: () =>
      box(
        MapList([
          { name: "backend", added: 2, modified: 4, breaks: 2 },
          { name: "frontend", modified: 3 },
          { name: "test", added: 1, modified: 2 },
        ]),
      ),
  },
  {
    name: "DiffBlock",
    group: "Code",
    height: 300,
    readme:
      "A unified diff on a phone: two line-number columns, the sign and the code. Only the ground shows the change; the text stays ink. Changed words have a stronger ground. Side by side starts at 768px.",
    render: () =>
      box(
        DiffBlock({
          file: "backend/graph_brief.rs",
          added: 2,
          removed: 1,
          lines: [...DIFF, { collapsed: 24 }],
        }),
      ),
  },
  {
    name: "SourceBlock",
    group: "Code",
    height: 230,
    readme:
      "Source with line numbers. The selected declaration has accent-subtle and a 2px accent bar.",
    render: () =>
      box(
        SourceBlock([
          { n: 184, code: [["/// The names-only map in a task's text.", "c"]] },
          {
            n: 185,
            code: [
              ["pub async fn "],
              ["map", "d"],
              ["(app: &App) -> String {"],
            ],
            selected: true,
          },
          {
            n: 186,
            code: "    let tree = names_tree(app, base).await;",
            selected: true,
          },
          {
            n: 187,
            code: [["    fold(tree, "], ["12_000", "s"], [")"]],
            selected: true,
          },
          { n: 188, code: "}", selected: true },
          { n: 189, code: "" },
        ]),
      ),
  },
  {
    name: "CollapsedLines",
    group: "Code",
    height: 90,
    readme:
      "The row that stands for hidden unchanged lines in a diff. A tap shows them.",
    render: () => box(DiffBlock({ lines: [{ collapsed: 24 }] })),
  },
  {
    name: "TaskRow",
    group: "Review",
    height: 200,
    readme:
      "A Row for a task: its first instruction as the title, its StatusLabel and the time.",
    render: () =>
      box(
        List(
          TaskRow({
            title: "Fix the graph brief cycle",
            state: "ready",
            stateText: "Ready for review",
            detail: "12 min",
          }),
          TaskRow({
            title: "Keep services apart",
            state: "working",
            stateText: "Working",
            detail: "3 min",
          }),
        ),
      ),
  },
  {
    name: "TaskGroup",
    group: "Review",
    height: 260,
    readme:
      "A group heading and its rows: Needs you, Working, Ready for review, Done. An empty group is left out.",
    render: () =>
      box(
        Group(
          { title: "Needs you" },
          List(
            TaskRow({
              title: "Session: tidy imports",
              state: "needs",
              stateText: "Needs you",
              detail: "a command to allow",
            }),
          ),
        ),
        Group(
          { title: "Working" },
          List(
            TaskRow({
              title: "Keep services apart",
              state: "working",
              stateText: "Working",
              detail: "3 min",
            }),
          ),
        ),
      ),
  },
  {
    name: "InstructionReport",
    group: "Review",
    height: 210,
    readme: "One instruction, the agent's report and its commit.",
    render: () =>
      box(
        InstructionReport({
          title: "Move names_tree into graph_brief.rs",
          state: "approved",
          stateText: "Done",
          report:
            "Moved names_tree and its tests. lookup.rs now calls graph_brief::names_tree. cargo test passed.",
          commit: "c3491f5",
          files: "2 files",
        }),
      ),
  },
  {
    name: "ProgressSteps",
    group: "Review",
    height: 200,
    readme:
      "The steps of a long run, the current one in bold, and the time since the start.",
    render: () =>
      box(
        ProgressSteps({
          steps: [
            { text: "Read the code", state: "done" },
            { text: "Edited 3 files", state: "done" },
            { text: "Running tests", state: "now" },
            { text: "Check the rules", state: "next" },
          ],
          elapsed: "4 min 12 s · You can leave this page",
        }),
      ),
  },
  {
    name: "ApprovalPrompt",
    group: "Review",
    height: 300,
    readme:
      "A command that waits for the owner in a session: the command, the agent's reason, and Allow once, Allow for this session and Deny.",
    render: () =>
      box(
        ApprovalPrompt({
          command: "npm run test:browser",
          reason: "Check the new sheet heights in the browser tests.",
        }),
      ),
  },
  {
    name: "MergeDialog",
    group: "Review",
    height: 380,
    readme:
      "The modal confirmation of a merge. It names the branch, the commits and the files, and it says that the merge can be undone. The confirm button is the verb.",
    render: () =>
      stage(
        380,
        0,
        null,
        MergeDialog({
          branch: "main",
          commits: 3,
          files: 4,
          note: "main moves forward to the task's last commit. You can undo it while main has no other commits.",
        }),
      ),
  },
  {
    name: "ProposalRow",
    group: "Review",
    height: 250,
    readme:
      "A proposed fix or rule: a checkbox, its plain sentence, a MetaLine, a Figure and a Disclosure to edit it.",
    render: () =>
      box(
        ProposalRow({
          sentence: "backend/graph_brief.rs must not use backend/lookup.rs",
          meta: "Acyclic dependencies · High",
          breaks: 1,
        }),
      ),
  },
  {
    name: "InlineError",
    group: "Feedback",
    height: 150,
    readme:
      "An error where it happened: what failed, what to do, and one button when one action fixes it. Never a toast.",
    render: () =>
      box(
        InlineError({
          title: "Cannot reach Peekumi",
          text: "Check that the server runs and that your phone is on its network.",
          action: Button({ label: "Try again" }),
        }),
      ),
  },
  {
    name: "EmptyState",
    group: "Feedback",
    height: 300,
    readme:
      "Peek in its empty state, one line that says what is empty, and one button for the next step.",
    render: () =>
      box(
        EmptyState({
          title: "No tasks yet",
          text: "Write an instruction on the map to start one.",
          action: Button({ label: "Write an instruction", variant: "primary" }),
        }),
      ),
  },
  {
    name: "Skeleton",
    group: "Feedback",
    height: 150,
    readme:
      "Grey blocks in the shape of the content, for a whole view that loads in 1 to 10 seconds.",
    render: () => box(Skeleton()),
  },
  {
    name: "Spinner",
    group: "Feedback",
    height: 90,
    readme: "A small spinner for one part that loads in 1 to 10 seconds.",
    render: () => box(Spinner("Loading source")),
  },
  {
    name: "Toast",
    group: "Feedback",
    height: 150,
    readme:
      "A passive confirmation that fades. It never holds an error or an action that is not also somewhere else. A merge or a finished task can show Peek in that state.",
    render: () =>
      box(
        Actions(
          { stack: true },
          Toast({ text: "Saved 2 drafts" }),
          Toast({ text: "Merged into main", peek: "merged" }),
        ),
      ),
  },
  {
    name: "Menu",
    group: "Feedback",
    height: 300,
    readme:
      "The context menu and select menus: surface, radius-md, shadow-float and 44px items.",
    render: () =>
      box(
        Menu([
          { icon: "ask", label: "Ask about engine.rs" },
          { icon: "comment", label: "Write an instruction" },
          { icon: "source", label: "Show source" },
          null,
          { icon: "copy", label: "Copy path" },
          { icon: "broken", label: "Forbid this dependency", danger: true },
        ]),
      ),
  },
  {
    name: "Popover",
    group: "Feedback",
    height: 220,
    readme: "A floating panel for the key and the comparison menu.",
    render: () =>
      box(
        Popover(
          { title: "Comparison" },
          Select({ label: "Branch", value: "main" }),
          Select({ label: "Compare with", value: "Previous commit" }),
        ),
      ),
  },
  {
    name: "Dialog",
    group: "Feedback",
    height: 280,
    readme:
      "A modal dialog over the scrim, for a decision that needs the owner's full attention.",
    render: () =>
      stage(
        280,
        0,
        null,
        Dialog({
          title: "Allow all commands?",
          body: Note(
            "The agent can then run any command with your account's permissions.",
          ),
          actions: [
            Button({ label: "Allow all commands", variant: "primary" }),
            Button({ label: "Cancel" }),
          ],
        }),
      ),
  },
  {
    name: "Peek",
    group: "Feedback",
    height: 760,
    readme:
      "The mascot shows the state of the app and of the agent, and what the agent does now. Each state is one class from frontend/peek.js. At most one Peek moves on a screen. With reduced motion, every state holds still.",
    render: () =>
      box(
        frame("h3", "gallery-title", "What the agent does"),
        frame(
          "div",
          "gallery-peeks",
          ...PEEK_ACTIVITY.map(([state, text]) => peekCell(state, text)),
        ),
        frame("h3", "gallery-title", "States"),
        frame(
          "div",
          "gallery-peeks",
          ...PEEK_STATES.map(([state, text]) => peekCell(state, text)),
          peekCell("idle", "The app icon", true),
        ),
      ),
  },
  {
    name: "ChangeTray",
    group: "Shell",
    height: 120,
    readme:
      "The changes that wait to go to an agent, as one button at the end of the sheet title row. Every way to make a change adds to it, and it opens the send sheet (Flows, F2).",
    render: () =>
      box(
        SheetTitleRow({
          icon: "obj-file",
          name: "engine.rs",
          kind: "File",
          end: ChangeTray({ count: 2 }),
        }),
      ),
  },
  {
    name: "Choices",
    group: "Basics",
    height: 300,
    readme:
      "One choice from a short list, as rows with a check on the chosen one. Name each choice by the question that it answers, as in the comparison choices.",
    render: () =>
      box(
        Choices({
          label: "What to compare",
          value: "latest",
          options: [
            {
              value: "latest",
              title: "The last commit",
              meta: "c63a1eb with its parent, and your uncommitted work",
            },
            {
              value: "visit",
              title: "Since my last look",
              meta: "Yesterday 18:20 · 4 commits",
            },
            {
              value: "branch",
              title: "This branch against main",
              meta: "Like a pull request",
            },
          ],
        }),
      ),
  },
  {
    name: "Layout",
    group: "Content",
    height: 330,
    readme:
      "The layout parts: Text and Note for words, Stack for a column, Actions for a row of buttons, List for rows, and Group for a heading with its content. A screen uses these parts, never a div of its own.",
    render: () =>
      box(
        Text("Text in the body style."),
        Note("A quiet note in body-sm."),
        Actions(
          {},
          Button({ label: "Approve", variant: "primary" }),
          Button({ label: "Cancel" }),
        ),
        Group(
          { title: "A group" },
          List(Row({ title: "A row" }), Row({ title: "Another row" })),
        ),
      ),
  },
];
