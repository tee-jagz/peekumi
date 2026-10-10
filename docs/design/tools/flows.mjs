/**
 * @module The proposed flows of docs/design/19-flows.md: each flow is a strip of numbered phone
 * screens, built only from frontend/ui.js, with the counts for today and for the proposal.
 * make.mjs writes one page for each flow, a page with all flows, and one artifact card each.
 */
import * as ui from "../../../frontend/ui.js";
import { fileMap, header, repoMap } from "./screens.mjs";

const {
  Actions,
  AppShell,
  Button,
  ChangeTray,
  Checkbox,
  Choices,
  Command,
  Composer,
  Dialog,
  Disclosure,
  FactGrid,
  InstructionReport,
  List,
  MetaLine,
  Note,
  PageHeader,
  ProgressSteps,
  ReviewSheet,
  Row,
  SegmentedControl,
  Select,
  SheetTitleRow,
  StatusLabel,
  Tabs,
  TextArea,
} = ui;

const FULL = 740;
const page = (sheetHeight, ...children) =>
  AppShell({
    header: header(),
    sheetHeight,
    sheet: ReviewSheet({}, ...children),
  });
const mapWith = (sheetHeight, sheet, props = {}) =>
  AppShell({
    header: header(props.header),
    map: props.map || repoMap(),
    sheetHeight,
    sheet,
  });

const CHANGE =
  "Move names_tree from engine.rs into graph_brief.rs, so lookup.rs no longer calls engine code.";

/** The send sheet: the changes, where the work starts, how it runs, and Start task. */
const sendSheet = (changes) =>
  page(
    FULL,
    PageHeader({
      title: `Send ${changes.length} ${changes.length === 1 ? "change" : "changes"}`,
      meta: MetaLine("Claude Code", "Opus · high"),
    }),
    List(
      ...changes.map(([title, place]) =>
        Row({ title, meta: place, small: true }),
      ),
    ),
    FactGrid([
      ["Starts from", "main · c63a1eb"],
      ["New branch", "peekumi/run-…"],
    ]),
    SegmentedControl({
      label: "How it runs",
      value: "background",
      options: [
        { value: "background", label: "In the background" },
        { value: "live", label: "With me" },
      ],
    }),
    Checkbox({ label: "Tell me when it is done", checked: true }),
    Disclosure({ summary: "The exact task" }),
    Button({ label: "Start task", variant: "primary", block: true }),
  );

const readyTask = () =>
  page(
    FULL,
    PageHeader({
      title: "Move names_tree",
      meta: MetaLine(
        StatusLabel({ state: "ready", text: "Ready for review" }),
        "6 min",
      ),
      state: "ready",
    }),
    FactGrid([
      ["Files changed", 2],
      ["Rule breaks added", 0],
    ]),
    InstructionReport({
      title: "Move names_tree into graph_brief.rs",
      state: "approved",
      stateText: "Done",
      report:
        "Moved names_tree and its two tests. lookup.rs now calls graph_brief::names_tree. cargo test passed.",
      commit: "c3491f5",
      files: "2 files",
    }),
    Actions(
      { stack: true },
      Button({ label: "Approve and merge", variant: "primary" }),
      Actions(
        {},
        Button({ label: "Request changes" }),
        Button({ label: "Explore changes", variant: "plain" }),
      ),
    ),
  );

/** { name, title, readme, today, proposed, steps: [{ caption, render }] } for each flow. */
export const FLOWS = [
  {
    name: "FlowChange",
    title: "Make a change",
    readme:
      "From a wish to merged code. The owner types first and chooses Ask or Add as a change at the end. Changes collect in the tray, one sheet sends them with the exact task, and Approve and merge ends the review with one confirmation.",
    today: "9 taps · 5 screens · 2 confirmations · about 15 terms",
    proposed: "6 taps · 3 screens · 2 confirmations · 7 terms",
    steps: [
      {
        caption: "Type, then choose: Ask or Add as a change.",
        render: () =>
          mapWith(
            196,
            ReviewSheet(
              {
                composer: Composer({
                  intent: true,
                  place: "engine.rs",
                  code: true,
                  value: CHANGE,
                }),
              },
              SheetTitleRow({
                icon: "obj-file",
                name: "engine.rs",
                kind: "File",
              }),
            ),
            { map: fileMap({ controls: false }) },
          ),
      },
      {
        caption: "The change waits in the tray. Add more, or send.",
        render: () =>
          mapWith(
            196,
            ReviewSheet(
              {
                composer: Composer({
                  intent: true,
                  place: "engine.rs",
                  code: true,
                }),
              },
              SheetTitleRow({
                icon: "obj-file",
                name: "engine.rs",
                kind: "File",
                end: ChangeTray({ count: 1 }),
              }),
            ),
            { map: fileMap({ controls: false }) },
          ),
      },
      {
        caption:
          "One sheet: the changes, the exact task, how it runs. Start task.",
        render: () => sendSheet([[CHANGE, "engine.rs · c63a1eb"]]),
      },
      {
        caption: "Leave the page. Peek and the live line show the work.",
        render: () =>
          page(
            FULL,
            PageHeader({
              title: "Move names_tree",
              meta: MetaLine(
                StatusLabel({ state: "working", text: "Working" }),
                "4 min",
              ),
              state: "editing",
            }),
            ProgressSteps({
              steps: [
                { text: "Read lookup.rs and graph_brief.rs", state: "done" },
                { text: "Edits graph_brief.rs", state: "now" },
                { text: "Run the tests", state: "next" },
                { text: "Check the rules", state: "next" },
              ],
              elapsed: "4 min · You can leave this page",
            }),
          ),
      },
      {
        caption: "Review. One button approves and merges.",
        render: readyTask,
      },
      {
        caption: "One confirmation, with undo after it.",
        render: () =>
          AppShell({
            header: header(),
            sheetHeight: FULL,
            sheet: ReviewSheet(
              {},
              PageHeader({
                title: "Move names_tree",
                meta: "Ready for review",
                state: "ready",
              }),
            ),
            overlay: Dialog({
              title: "Approve and merge into main?",
              body: [
                FactGrid([
                  ["Commits", 1],
                  ["Files", 2],
                ]),
                Note(
                  "You approve both instructions. main moves forward to c3491f5. You can undo the merge while main has no other commits.",
                ),
              ],
              actions: [
                Button({ label: "Approve and merge", variant: "primary" }),
                Button({ label: "Approve only" }),
                Button({ label: "Cancel", variant: "plain" }),
              ],
            }),
          }),
      },
    ],
  },
  {
    name: "FlowFix",
    title: "Fix a rule break",
    readme:
      "From a rule break on the map to a change in the tray, with no wait. Fix writes the change from the rule and the break. The task agent finds the fix. Proposed fixes stays for many breaks at once.",
    today: "11 taps · 6 screens · 3 waits",
    proposed: "5 taps to started · 3 screens · 1 wait",
    steps: [
      {
        caption: "The break shows on the selection. Tap Fix.",
        render: () =>
          mapWith(
            300,
            ReviewSheet(
              {},
              SheetTitleRow({
                icon: "obj-file",
                name: "engine.rs",
                kind: "File",
                keyLine: "Breaks backend-layers",
                keyAction: Button({ label: "Fix", variant: "plain" }),
              }),
              Tabs({ selected: "relations" }),
              List(
                Row({
                  title: "rules.rs",
                  meta: MetaLine("3 calls", "Breaks backend-layers"),
                  end: ui.Figure({ value: 2, unit: "breaks", danger: true }),
                }),
              ),
            ),
            { map: fileMap({ controls: false }) },
          ),
      },
      {
        caption: "The change is written for you. Edit it if you want.",
        render: () =>
          page(
            FULL,
            PageHeader({
              title: "Fix a rule break",
              meta: MetaLine("backend-layers", "2 calls"),
            }),
            Note("The rule: backend/engine.rs must not call backend/rules.rs."),
            TextArea({
              label: "The change",
              value:
                "Remove the 2 calls from engine.rs to rules.rs. Keep the behaviour, and keep the tests green.",
            }),
            Button({
              label: "Add as a change",
              variant: "primary",
              block: true,
            }),
            Button({ label: "Compare proposed fixes", variant: "plain" }),
          ),
      },
      {
        caption:
          "The fix joins the tray, as any change. Send, then flow Make a change.",
        render: () =>
          mapWith(
            196,
            ReviewSheet(
              {
                composer: Composer({
                  intent: true,
                  place: "engine.rs",
                  code: true,
                }),
              },
              SheetTitleRow({
                icon: "obj-file",
                name: "engine.rs",
                kind: "File",
                end: ChangeTray({ count: 2 }),
              }),
            ),
            { map: fileMap({ controls: false }) },
          ),
      },
    ],
  },
  {
    name: "FlowCompare",
    title: "What changed?",
    readme:
      "Choose what to compare by the question you have, not by base and head. Three choices cover most visits; Choose commits keeps the full control for the rest.",
    today: "3 taps to change the base · about 8 controls · 6 terms",
    proposed: "2 taps · 4 choices · 2 terms",
    steps: [
      {
        caption: "Tap the comparison line.",
        render: () =>
          mapWith(
            196,
            ReviewSheet(
              { composer: Composer({ intent: true }) },
              SheetTitleRow({
                icon: "obj-folder",
                name: "peekumi",
                kind: "Repository",
              }),
            ),
          ),
      },
      {
        caption:
          "Choose by the question. Choose commits keeps base and head for the rare case.",
        render: () =>
          mapWith(
            470,
            ReviewSheet(
              {},
              PageHeader({ title: "Compare", meta: "main" }),
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
                  {
                    value: "custom",
                    title: "Choose commits…",
                    meta: "Any base and head",
                  },
                ],
              }),
              Select({ label: "Branch", value: "main" }),
            ),
          ),
      },
    ],
  },
  {
    name: "FlowStart",
    title: "First run",
    readme:
      "One command starts Peekumi, adds the repository it runs in, asks once about phone access and prints the pairing link. Notifications are offered when the first task starts, where they help.",
    today:
      "5 to 6 commands in the right order · notifications only from the Tasks bell",
    proposed: "1 command · notifications offered at the first Start task",
    steps: [
      {
        caption: "One command in the repository.",
        render: () =>
          page(
            470,
            PageHeader({ title: "Terminal", meta: "~/projects/visalytics" }),
            Command(
              "$ peekumi\nAdd this repository (visalytics)? Y\nOpen Peekumi on your phone with Tailscale? Y\n\nOpen this link on your phone:\nhttps://mac.tail1234.ts.net/#token=…",
            ),
            Note(
              "Each question has a default. Run peekumi doctor only when something fails.",
            ),
          ),
      },
      {
        caption: "The phone opens on the last commit, paired.",
        render: () =>
          AppShell({
            header: header({ tasksDot: null }),
            map: repoMap(),
            sheetHeight: 196,
            sheet: ReviewSheet(
              { composer: Composer({ intent: true }) },
              SheetTitleRow({
                icon: "obj-folder",
                name: "peekumi",
                kind: "Repository",
              }),
            ),
          }),
      },
    ],
  },
];
