/**
 * @module The full-screen mockups: phone screens of 390 × 844px and one desktop screen of
 * 1280 × 800px. Each screen is one AppShell from frontend/ui.js, built only from its parts.
 * make.mjs writes them as mockup pages and as cards of the design system artifact.
 */
import * as ui from "../../../frontend/ui.js";
import { COMPARE } from "./gallery.mjs";

const {
  Actions,
  AgentMessage,
  AppHeader,
  AppShell,
  ApprovalPrompt,
  Button,
  Code,
  Composer,
  DiffBlock,
  Disclosure,
  EdgeMark,
  EmptyState,
  FactGrid,
  Figure,
  Group,
  IconButton,
  InstructionReport,
  List,
  LiveLine,
  MapCanvas,
  MapCard,
  MapEdge,
  MergeDialog,
  MetaLine,
  PageHeader,
  ProposalRow,
  ReviewSheet,
  Row,
  SheetTitleRow,
  StatusLabel,
  StatusMarks,
  Tabs,
  TaskRow,
  Text,
  TimeRail,
  TitleEnd,
} = ui;

const FULL = 740;
export const header = (props = {}) =>
  AppHeader({
    name: "peekumi",
    comparison: props.offline
      ? ui.ComparisonLine({ offline: true })
      : COMPARE(),
    ...props,
  });

/** The repository level of the map. `rows` leaves out the lower rows; `dim` dims the unchanged. */
export function repoMap({
  agent = false,
  dim = false,
  rows = 4,
  height = 560,
} = {}) {
  const quiet = (states = []) => [
    "unchanged",
    ...(dim ? ["dim"] : []),
    ...states,
  ];
  const cards = [
    MapCard({
      name: "backend",
      x: 16,
      y: 16,
      width: 160,
      height: 124,
      description: "The Rust backend serves the API.",
      modified: 4,
      added: 2,
      files: 34,
      breaks: 2,
      states: agent ? ["agent"] : [],
      doing: "editing",
    }),
    MapCard({
      name: "frontend",
      x: 214,
      y: 16,
      width: 160,
      height: 124,
      description: "The phone interface.",
      modified: 3,
      files: 26,
    }),
    MapCard({
      name: "docs",
      x: 16,
      y: 156,
      width: 160,
      height: 84,
      modified: 2,
      files: 91,
      states: dim ? ["dim"] : [],
    }),
    MapCard({
      name: "scripts",
      x: 214,
      y: 156,
      width: 160,
      height: 84,
      files: 15,
      states: quiet(),
    }),
    MapCard({
      name: "test",
      x: 16,
      y: 256,
      width: 160,
      height: 84,
      added: 1,
      modified: 2,
      files: 42,
    }),
    MapCard({
      name: "Repository files",
      x: 214,
      y: 256,
      width: 160,
      height: 84,
      kind: "rootfiles",
      modified: 1,
      files: 21,
      uncommitted: true,
    }),
    MapCard({
      name: ".github",
      x: 16,
      y: 356,
      width: 160,
      height: 64,
      files: 10,
      states: quiet(),
    }),
    MapCard({
      name: "skills",
      x: 214,
      y: 356,
      width: 160,
      height: 64,
      files: 1,
      states: quiet(),
    }),
  ].slice(0, 2 * rows);
  return MapCanvas({
    width: 390,
    height,
    cards,
    edges: [
      MapEdge({ d: "M176 298 C 204 298, 204 120, 176 120" }),
      MapEdge({ d: "M214 198 C 192 198, 196 108, 176 108", kind: "out" }),
      MapEdge({ d: "M214 56 C 196 56, 194 64, 176 64", kind: "break" }),
    ],
    marks: [EdgeMark({ x: 195, y: 60 })],
  });
}

/** One folder at the file level, with engine.rs selected. */
export function fileMap({ controls = true } = {}) {
  return MapCanvas({
    width: 390,
    height: 300,
    controls,
    cards: [
      MapCard({
        name: "engine.rs",
        x: 16,
        y: 16,
        width: 160,
        height: 92,
        kind: "file",
        code: true,
        modified: 3,
        breaks: 2,
        states: ["selected"],
      }),
      MapCard({
        name: "rules.rs",
        x: 214,
        y: 16,
        width: 160,
        height: 76,
        kind: "file",
        code: true,
        modified: 1,
      }),
      MapCard({
        name: "relationships.rs",
        x: 214,
        y: 108,
        width: 160,
        height: 76,
        kind: "file",
        code: true,
      }),
      MapCard({
        name: "lookup.rs",
        x: 16,
        y: 124,
        width: 160,
        height: 76,
        kind: "file",
        code: true,
        modified: 1,
        states: ["dim"],
      }),
      MapCard({
        name: "worker.rs",
        x: 16,
        y: 216,
        width: 160,
        height: 64,
        kind: "file",
        code: true,
        states: ["dim", "unchanged"],
      }),
      MapCard({
        name: "push.rs",
        x: 214,
        y: 200,
        width: 160,
        height: 64,
        kind: "file",
        code: true,
        states: ["dim", "unchanged"],
      }),
    ],
    edges: [
      MapEdge({ d: "M176 44 C 196 44, 196 50, 214 50", selected: true }),
      MapEdge({
        d: "M176 70 C 198 70, 194 146, 214 146",
        kind: "out",
        selected: true,
      }),
      MapEdge({ d: "M96 124 C 96 116, 96 116, 96 108", kind: "break" }),
      MapEdge({ d: "M176 248 C 196 248, 196 232, 214 232", dim: true }),
    ],
    marks: [EdgeMark({ x: 96, y: 116 })],
  });
}

/** The agent at work in one folder: it read and changed some files and reads lookup.rs now. */
function agentMap() {
  return MapCanvas({
    width: 390,
    height: 560,
    cards: [
      MapCard({
        name: "graph_brief.rs",
        x: 16,
        y: 32,
        width: 160,
        height: 76,
        kind: "file",
        code: true,
        modified: 1,
      }),
      MapCard({
        name: "lookup.rs",
        x: 214,
        y: 32,
        width: 160,
        height: 76,
        kind: "file",
        code: true,
        states: ["agent"],
        doing: "reading",
      }),
      MapCard({
        name: "engine.rs",
        x: 16,
        y: 124,
        width: 160,
        height: 76,
        kind: "file",
        code: true,
        modified: 3,
      }),
      MapCard({
        name: "rules.rs",
        x: 214,
        y: 124,
        width: 160,
        height: 76,
        kind: "file",
        code: true,
        states: ["unchanged"],
      }),
      MapCard({
        name: "brief_test.rs",
        x: 16,
        y: 216,
        width: 160,
        height: 76,
        kind: "file",
        code: true,
        added: 1,
      }),
      MapCard({
        name: "worker.rs",
        x: 214,
        y: 216,
        width: 160,
        height: 64,
        kind: "file",
        code: true,
        states: ["unchanged"],
      }),
    ],
    edges: [
      MapEdge({ d: "M176 70 C 196 70, 194 70, 214 70" }),
      MapEdge({ d: "M96 124 C 96 116, 96 116, 96 108" }),
      MapEdge({ d: "M176 254 C 200 254, 200 92, 176 92", kind: "added" }),
    ],
  });
}

const relations = () => [
  List(
    Row({
      title: "rules.rs",
      meta: MetaLine("3 calls", "Breaks backend-layers"),
      end: Figure({ value: 2, unit: "breaks", danger: true }),
    }),
    Row({
      title: "relationships.rs",
      meta: MetaLine("Imports", "1 call"),
      end: StatusMarks({ modified: 1 }),
    }),
    Row({
      title: "lookup.rs",
      meta: "1 call",
      end: StatusMarks({ modified: 1 }),
    }),
  ),
  Button({
    label: "Propose fixes for 2 rule breaks",
    variant: "primary",
    block: true,
  }),
];

const task = () => [
  PageHeader({
    title: "Fix the graph brief cycle",
    meta: MetaLine(
      StatusLabel({ state: "ready", text: "Ready for review" }),
      "Claude Code",
    ),
    state: "ready",
  }),
  FactGrid([
    ["Files changed", 2],
    ["Commits", 1],
    ["Rule breaks added", 0],
    ["Run time", "6 min"],
  ]),
  Group(
    { title: "Instructions" },
    InstructionReport({
      title: "Move names_tree into graph_brief.rs",
      state: "approved",
      stateText: "Done",
      report:
        "Moved names_tree and its two tests. lookup.rs now calls graph_brief::names_tree. cargo test passed.",
      commit: "c3491f5",
      files: "2 files",
    }),
  ),
  Group(
    { title: "Files" },
    List(
      Row({
        title: Code("backend/graph_brief.rs"),
        small: true,
        end: StatusMarks({ added: 14, removed: 2 }),
      }),
      Row({
        title: Code("backend/lookup.rs"),
        small: true,
        end: StatusMarks({ added: 1, removed: 13 }),
      }),
    ),
  ),
  Actions(
    { stack: true },
    Button({ label: "Approve", variant: "primary" }),
    Actions(
      {},
      Button({ label: "Request changes" }),
      Button({ label: "Explore changes", variant: "plain" }),
    ),
  ),
];

/** { name, title, width, height, readme, render } for each screen. */
export const SCREENS = [
  {
    name: "ScreenMap",
    title: "Map, sheet at Peek",
    readme:
      "The repository map with the sheet at Peek height. The header, the map with its controls, and the sheet with the title row, the live line and the composer.",
    render: () =>
      AppShell({
        header: header({ tasksDot: "accent" }),
        map: repoMap({ agent: true }),
        sheetHeight: 196,
        sheet: ReviewSheet(
          { composer: Composer({}) },
          SheetTitleRow({
            icon: "obj-folder",
            name: "peekumi",
            kind: "Repository",
            end: LiveLine({
              text: "Claude Code · Edits 3 files",
              state: "editing",
              still: true,
            }),
          }),
        ),
      }),
  },
  {
    name: "ScreenAgent",
    title: "The agent at work",
    readme:
      "The agent at work in one folder. Peek's head moves to the card of the file the agent uses now, and its eye shows the activity. The live line names the activity and the file. Here the agent reads lookup.rs after it edited graph_brief.rs and created brief_test.rs.",
    render: () =>
      AppShell({
        header: header({ tasksDot: "accent" }),
        map: agentMap(),
        sheetHeight: 196,
        sheet: ReviewSheet(
          {
            composer: Composer({
              place: "backend",
              placeholder: "Ask about backend",
            }),
          },
          SheetTitleRow({
            icon: "obj-folder",
            name: "backend",
            kind: "Folder",
            end: LiveLine({
              text: "Claude Code · Reads lookup.rs",
              state: "reading",
              still: true,
            }),
          }),
        ),
      }),
  },
  {
    name: "ScreenSelection",
    title: "Selection, sheet at Half",
    readme:
      "A file selected at the folder level. Its neighbours stay clear and the rest dims. The sheet at Half height shows the key line, the tabs, Relations and the one primary action.",
    render: () =>
      AppShell({
        header: header(),
        map: fileMap({ controls: false }),
        sheetHeight: 470,
        sheet: ReviewSheet(
          {
            composer: Composer({
              place: "engine.rs",
              code: true,
              placeholder: "Ask about engine.rs",
            }),
          },
          SheetTitleRow({
            icon: "obj-file",
            name: "engine.rs",
            kind: "File",
            keyLine: "Breaks backend-layers",
          }),
          Tabs({ selected: "relations" }),
          relations(),
        ),
      }),
  },
  {
    name: "ScreenDiff",
    title: "Diff, sheet at Full",
    readme:
      "The Changes tab with the sheet at Full height: the file, its counts and a unified diff. The composer stays at the bottom.",
    render: () =>
      AppShell({
        header: header(),
        sheetHeight: FULL,
        sheet: ReviewSheet(
          {
            composer: Composer({
              place: "engine.rs",
              code: true,
              placeholder: "Ask about this change",
            }),
          },
          SheetTitleRow({
            icon: "obj-file",
            name: "engine.rs",
            kind: "File",
            end: TitleEnd("+3 −1"),
          }),
          Tabs({ selected: "changes" }),
          DiffBlock({
            file: "backend/engine.rs",
            added: 3,
            removed: 1,
            lines: [
              { kind: "@", code: "@@ -604,6 +604,9 @@ impl Repository" },
              {
                kind: " ",
                old: 604,
                new: 604,
                code: [
                  ["    pub fn "],
                  ["rule_trial", "d"],
                  ["(&mut self, head: &str) {"],
                ],
              },
              {
                kind: "-",
                old: 605,
                code: [
                  ["        let groups = "],
                  ['proposal["groups"]', "del"],
                  [";"],
                ],
              },
              {
                kind: "+",
                new: 605,
                code: [
                  ["        "],
                  ["// A clashing group name gets a new name.", "c"],
                ],
              },
              {
                kind: "+",
                new: 606,
                code: [
                  ["        let groups = "],
                  ["renamed(proposal)", "add"],
                  [";"],
                ],
              },
              {
                kind: "+",
                new: 607,
                code: [["        let used = "], ['"ui-2"', "s"], [";"]],
              },
              {
                kind: " ",
                old: 606,
                new: 608,
                code: '        let rule = &proposal["rule"];',
              },
              { collapsed: 18 },
              { kind: "@", code: "@@ -702,4 +707,4 @@ fn rename_group" },
              {
                kind: " ",
                old: 702,
                new: 707,
                code: '    if rule["from"] == from {',
              },
              {
                kind: "-",
                old: 703,
                code: [
                  ['        rule["from"] = json!('],
                  ["from", "del"],
                  [");"],
                ],
              },
              {
                kind: "+",
                new: 708,
                code: [
                  ['        rule["from"] = json!('],
                  ["to", "add"],
                  [");"],
                ],
              },
            ],
          }),
        ),
      }),
  },
  {
    name: "ScreenTime",
    title: "Time mode",
    readme:
      "Time mode: the commit strip under the header, the map at that commit, and the sheet at Peek.",
    render: () =>
      AppShell({
        header: header({ mode: "time" }),
        rail: TimeRail([
          { hash: "47a9930", subject: "Session rule check" },
          { hash: "34e5c64", subject: "Rules keep groups" },
          { hash: "c63a1eb", subject: "Fixes in background", current: true },
        ]),
        map: repoMap({ rows: 3, height: 470 }),
        sheetHeight: 230,
        sheet: ReviewSheet(
          { composer: Composer({}) },
          SheetTitleRow({
            icon: "obj-folder",
            name: "peekumi",
            kind: "Repository",
          }),
          MetaLine(Code("c63a1eb"), "Run Proposed fixes in the background"),
        ),
      }),
  },
  {
    name: "ScreenTasks",
    title: "Tasks",
    readme:
      "The Tasks page: groups in the order Needs you, Working, Ready for review, Done, and one primary action.",
    render: () =>
      AppShell({
        header: header({ tasksDot: "warning" }),
        sheetHeight: FULL,
        sheet: ReviewSheet(
          {},
          PageHeader({
            title: "Tasks",
            meta: MetaLine("1 needs you", "1 working"),
            actions: [
              IconButton({
                icon: "bellOff",
                label: "Turn on notifications",
                quiet: true,
              }),
              IconButton({ icon: "agents", label: "Agents", quiet: true }),
            ],
          }),
          Group(
            { title: "Needs you" },
            List(
              TaskRow({
                title: "Session: tidy imports",
                state: "needs",
                stateText: "Needs you",
                detail: "a command",
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
          Group(
            { title: "Ready for review" },
            List(
              TaskRow({
                title: "Fix the graph brief cycle",
                state: "ready",
                stateText: "Ready for review",
                detail: "12 min",
              }),
            ),
          ),
          Group(
            { title: "Done" },
            List(
              TaskRow({
                title: "Add fifteen proposed rules",
                state: "merged",
                stateText: "Merged into main",
                detail: "Yesterday",
              }),
              TaskRow({
                title: "Format .peekumi.json",
                state: "merged",
                stateText: "Merged into main",
                detail: "2 days",
              }),
            ),
          ),
          Button({ label: "Review 3 drafts", variant: "primary", block: true }),
        ),
      }),
  },
  {
    name: "ScreenTask",
    title: "A task",
    readme:
      "A task ready for review: the state, the facts as a FactGrid, the instruction with the agent's report, the files, and Approve as the one primary action.",
    render: () =>
      AppShell({
        header: header(),
        sheetHeight: FULL,
        sheet: ReviewSheet({}, task()),
      }),
  },
  {
    name: "ScreenSession",
    title: "Session approval",
    readme:
      "A session that waits for the owner: the agent's message, its steps, and the command to allow or deny.",
    render: () =>
      AppShell({
        header: header({ tasksDot: "warning" }),
        sheetHeight: FULL,
        sheet: ReviewSheet(
          {
            composer: Composer({
              mode: "session",
              place: "Session",
              placeholder: "Reply to Claude Code",
            }),
          },
          PageHeader({
            title: "Tidy imports",
            meta: MetaLine(
              StatusLabel({ state: "needs", text: "Needs you" }),
              "Claude Code",
            ),
            state: "thinking",
            actions: [IconButton({ icon: "stop", label: "Stop", quiet: true })],
          }),
          AgentMessage(
            "I sorted the imports in 6 files and removed 4 unused ones. Next I want to run the browser tests, because two files are frontend modules.",
            [
              { text: "Edited 6 files", state: "done" },
              { text: "cargo test", state: "done" },
            ],
          ),
          ApprovalPrompt({
            command: "npm run test:browser",
            reason: "Check the two changed frontend modules.",
          }),
        ),
      }),
  },
  {
    name: "ScreenRules",
    title: "Proposed rules",
    readme:
      "Proposed rules: plain sentences in two sections, the key number at the right, nothing selected at first, the Done list closed, and one primary action.",
    render: () =>
      AppShell({
        header: header(),
        sheetHeight: FULL,
        sheet: ReviewSheet(
          {},
          PageHeader({
            title: "Proposed rules",
            meta: MetaLine("From Claude Code", "3 open"),
            actions: [
              IconButton({
                icon: "refresh",
                label: "Audit again",
                quiet: true,
              }),
            ],
          }),
          Group(
            { title: "Finds a problem now" },
            ProposalRow({
              sentence: "backend/graph_brief.rs must not use backend/lookup.rs",
              meta: "Acyclic dependencies · High",
              breaks: 1,
              checked: true,
            }),
          ),
          Group(
            { title: "Guards against future mistakes" },
            ProposalRow({
              sentence:
                "backend/adapters/mod.rs may use only the adapters and the platform",
              meta: "Stable dependencies · High",
              checked: true,
            }),
            ProposalRow({
              sentence: "backend/ and frontend/ must not use scripts/",
              meta: "Separation of concerns · Medium",
            }),
          ),
          Disclosure({ summary: "Done (15)" }),
          Button({
            label: "Add 2 rules with an agent",
            variant: "primary",
            block: true,
          }),
        ),
      }),
  },
  {
    name: "ScreenEmpty",
    title: "Empty",
    readme:
      "The Tasks page with no tasks: Peek peeks up and looks around, one line says what is empty, and one button gives the next step.",
    render: () =>
      AppShell({
        header: header(),
        sheetHeight: FULL,
        sheet: ReviewSheet(
          {},
          PageHeader({ title: "Tasks", meta: "None yet" }),
          EmptyState({
            title: "No tasks yet",
            text: "Write an instruction on the map to start one.",
            action: Button({
              label: "Write an instruction",
              variant: "primary",
            }),
          }),
        ),
      }),
  },
  {
    name: "ScreenOffline",
    title: "Offline",
    readme:
      "The phone cannot reach the server: the header says Offline, Peek sleeps, the last map stays readable under the sheet, and one button tries again.",
    render: () =>
      AppShell({
        header: header({ offline: true }),
        map: repoMap({ dim: true }),
        sheetHeight: 330,
        sheet: ReviewSheet(
          {},
          EmptyState({
            state: "asleep",
            title: "Cannot reach Peekumi",
            text: "Check that the server runs and that your phone is on its network. The map shows the last comparison.",
            action: Button({ label: "Try again", variant: "primary" }),
          }),
        ),
      }),
  },
  {
    name: "ScreenMerge",
    title: "Merge",
    readme:
      "The merge confirmation as a modal dialog over the task, with the scrim.",
    render: () =>
      AppShell({
        header: header(),
        sheetHeight: FULL,
        sheet: ReviewSheet({}, task()),
        overlay: MergeDialog({
          branch: "main",
          commits: 1,
          files: 2,
          note: "main moves forward to c3491f5. You can undo the merge while main has no other commits.",
        }),
      }),
  },
  {
    name: "ScreenMerged",
    title: "Merged",
    readme:
      "The task after the merge: Peek's layers slide into one, the state says Merged into main, and Undo merge stays until main changes.",
    render: () =>
      AppShell({
        header: header(),
        sheetHeight: FULL,
        sheet: ReviewSheet(
          {},
          PageHeader({
            title: "Fix the graph brief cycle",
            meta: MetaLine(
              StatusLabel({ state: "merged", text: "Merged into main" }),
              "just now",
            ),
            state: "merged",
          }),
          FactGrid([
            ["Files changed", 2],
            ["Commits", 1],
            ["Rule breaks added", 0],
            ["Run time", "6 min"],
          ]),
          Text("main moved forward to ", Code("c3491f5"), "."),
          Actions(
            { stack: true },
            Button({ label: "Show on the map", variant: "primary" }),
            Button({ label: "Undo merge", variant: "plain" }),
          ),
        ),
      }),
  },
  {
    name: "ScreenDesktop",
    title: "Desktop",
    width: 1280,
    height: 800,
    readme:
      "The desktop layout: the same AppShell from 900px wide. The map is at the left, and the sheet is a right panel of 440px with the same tabs, content and composer.",
    render: () =>
      AppShell({
        header: header(),
        map: fileMap(),
        sheet: ReviewSheet(
          {
            grabber: false,
            composer: Composer({
              place: "engine.rs",
              code: true,
              placeholder: "Ask about engine.rs",
            }),
          },
          SheetTitleRow({
            icon: "obj-file",
            name: "engine.rs",
            kind: "File",
            keyLine: "Breaks backend-layers",
          }),
          Tabs({ selected: "relations" }),
          relations(),
        ),
      }),
  },
];
for (const s of SCREENS) {
  s.width ??= 390;
  s.height ??= 844;
}
