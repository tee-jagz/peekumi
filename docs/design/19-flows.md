# Flows

A good screen in a long flow is still a long flow. This section measures the main journeys of the owner, finds the steps that the product rules need, and removes or joins the others. The mockups are in `mockups/flows.html`.

## Method

The journeys were traced from the code and from the browser tests that click through them (`test/workflow-browser.mjs`, `test/session-browser.mjs`, `test/rules-browser.mjs`, `test/navigation-browser.mjs`) in October 2026. The counts are for the shortest happy path on a phone. A step that a product rule needs is marked **kept**, with its rule.

## Flow rules

These rules apply to every new flow and to every change to a flow.

- **F1. Intent first.** The owner types what they want. Peekumi asks how to handle it only when they send it, and only when the answer changes the result.
- **F2. One road to an agent.** Every change goes into the same tray and leaves through the same send sheet. This includes an instruction, a fix, a rule, an Ask suggestion and a forbidden dependency.
- **F3. Join steps that always follow each other.** When step B always comes after step A, the owner does both with one tap, and sees the facts of B before they confirm.
- **F4. A default before a choice.** Remember the last choice, and select everything that most owners select. Ask only for what has no good default.
- **F5. A confirmation only where a rule or a loss needs it.** Everywhere else, do the action and offer undo.
- **F6. No dead end.** Each end state names its next step: merged shows the map, a stopped task shows Try again, an empty list shows how to start.
- **F7. Ask for a permission when it helps.** Offer notifications when the first task starts, not on a settings page.
- **F8. One word for one thing.** Rule break, not violation. Task, not run. Change, not draft or comment. A term that the owner does not need stays out of the interface.
- **F9. Rare paths stay out of the way.** Update with main, Commit my changes and conflicts appear only when they apply, inside the step that they block.

## 1. Make a change

The job: "I want this code to change, and I want it in main."

**Today:** 9 taps, 5 screens, 2 confirmations and about 15 terms. The owner picks the Instruction tab, saves a draft, opens **Tasks**, and taps **Review task**, **Preview task** and **Start task**. Later they tap **Approve**, **Merge into main** and **Merge**. Sending a draft needs a trip to another page. Preview and Start are two taps, although Start always follows Preview.

**Proposed** (`FlowChange`): 6 taps, 3 screens, 2 confirmations and 7 terms.

1. Type in the composer. Tap **Add as a change** (F1).
2. The tray in the sheet title row says "1 change · Send". Add more changes, or tap it (F2).
3. The send sheet shows the changes, the exact task, where it starts, and **In the background** or **With me**. Tap **Start task**. The sheet opens with the frozen preview, so the owner sees the exact task before they start it (F3).
4. Leave the page. Peek and the live line show the work.
5. Tap **Approve and merge**.
6. Confirm. **Approve only** and **Cancel** stay in the same dialog. Undo stays after the merge.

**Kept:**

- The exact, frozen task before the start ("frozen task previews", `AGENTS.md`). The send sheet is the preview.
- The approval by the owner, recorded against the exact commit (`WORKFLOW.md`). **Approve and merge** records it before the merge.
- The confirmation before a merge, fast-forward only, with undo ("after a confirmation", `AGENTS.md`).
- The commit sheet when the owner's own files are in the way, with the files and the message checked by the owner (`AGENTS.md`). It appears inside the merge step (F9).

**Removed terms:** draft, Review task, Preview task, round, requested changes, Prepare and Dispatch.

## 2. Talk to an agent

The job: "I have a question", or "I want work done with me".

**Today:** the owner must choose **Ask**, **Instruction** or **Session** from three icon tabs before they type. Each tab keeps its own unsent text. There is no path from an Ask answer to a session, or between an instruction and a session. Inside a thread the tabs are hidden.

**Proposed** (`FlowChange`, step 1):

- One field: "Ask, or describe a change". **Ask** sends a question. **Add as a change** puts the text in the tray (F1).
- A session is how a task runs, not a separate place to start. In the send sheet, **With me** starts a session with the changes as its first message. **In the background** starts a task (F2).
- An Ask answer keeps its **Add as a change** action. The suggestion goes to the tray, not to a list in another page.

**Kept:** Ask stays read-only and cannot start work ("it cannot run code, change files or state, or dispatch work", `AGENTS.md`). Only the owner's tap moves a suggestion to the tray. A session still asks before a command outside its list, and its end still sends its branch to review (`AGENTS.md`).

## 3. Fix a rule break

The job: "This break must go."

**Today:** 11 taps, 6 screens and 3 waits. The owner opens the break, then Relations, then **Propose fixes**. Peekumi groups the breaks, then the Ask agent proposes fixes in the background. The owner reviews them, sends them to the task form, and goes through flow 1.

**Proposed** (`FlowFix`): 5 taps to a started task, 3 screens and 1 wait.

1. The rule break line on the selection has **Fix**.
2. The change is written from the rule and the break: "Remove the 2 calls from engine.rs to rules.rs." The owner can edit it. **Add as a change**.
3. The fix joins the tray, as any change. Flow 1 continues.

The task agent finds the fix while it works, so the separate proposal step and its wait go away. **Compare proposed fixes** stays for an owner who wants to see options, or who has many breaks at once.

**Rules:** **Add N rules** in Proposed rules also puts its rules in the tray. The audit itself stays: the owner must choose the rules.

**Kept:** an agent changes code only in a task, in its own worktree, after the owner starts it. Breaks show before the approval and in the merge dialog.

## 4. What changed?

The job: "Show me what changed since …".

**Today:** 3 taps to change the base, and about 8 controls in the comparison popover. The owner meets 6 terms: branch, base, head, first parent, pinned base and pull request. The first screen shows about 22 controls.

**Proposed** (`FlowCompare`): 2 taps and 4 choices, named by the question.

- **The last commit** (the default: the newest commit with its parent, and the uncommitted changes).
- **Since my last look** (Peekumi keeps the time of the last visit on the device).
- **This branch against main** (the pull request view).
- **Choose commits…** keeps base and head for the rare case (F9).

Also:

- Show the sheet tabs at Peek height, so a tab does not need a drag first.
- A second tap on a declaration opens its diff, as the first tap does, not the After source.

**Kept:** the comparison never changes the checkout ("Never switch the inspected checkout", `AGENTS.md`). Commit cards show only in Time mode (`AGENTS.md`).

**Implemented:** the four choices are in the comparison popover. "Since my last look" keeps the newest commit on view for each device, repository and branch. `/api/repo` returns the merge base with main. The sheet tabs show at Peek height, and a second tap on a changed declaration opens its diff.

## 5. Is my agent done?

**Today:** notifications are only behind the bell on the Tasks page, so most owners never turn them on. The Tasks button shows "ready" for a smaller set of tasks than the **Needs you** group.

**Proposed:**

- **Tell me when it is done** in the send sheet, selected the first time. The browser asks for the permission then (F7).
- The Tasks button shows its dot for every task in **Needs you**, so the button and the list agree.

## 6. First run

**Today:** 5 to 6 commands (`doctor`, `repo add`, `start`, `share`, `pair`), in an order that the owner must know: `share` before `pair`, or the phone link is local.

**Proposed** (`FlowStart`): one command, `peekumi`, in the repository. It adds the repository, asks once about phone access with Tailscale, and prints the pairing link. Each question has a default. `peekumi doctor` stays for problems.

**Kept:** a public tunnel needs the owner's explicit yes, and the pairing link stays private (`docs/SETUP.md`).

## Faults found

The traces also found faults that are not about the number of steps.

| Fault | Where | Fix |
|---|---|---|
| **Forbid this dependency** asked the agent to add the rule and fix the code. Proposed rules asks it not to change code. | `app.js` (Forbid), `audit.js` | Corrected: Forbid adds the rule only. **Fix** on the rule break line then sends the code change. |
| Proposed fixes kept the sent fixes only in page memory. After a reload, the same fixes could be sent again. | `fixes.js` | Corrected: the page reads the server's instructions, and a fix that is already an instruction is not sent again. |
| A pinned base stays pinned in Time mode. The guide said that Time compares with the parent. | `USER-GUIDE.md` | Corrected: the frontend README keeps a chosen base across modes, and the guide now says so. |
| The guide and the comparison popover said that uncommitted work never shows. | `USER-GUIDE.md`, `index.html` | Corrected. |
| `WORKFLOW.md` used **Prepare run**, **Dispatch run** and **Stop run**. | `WORKFLOW.md` | Corrected to **Review task**, **Start task** and **Stop task**. |
| "Violation" and "rule break" mean the same thing. | Interface and docs | Use "rule break" only (F8). |

## Order of work

1. The send sheet and the tray (flow 1, steps 2 and 3). This removes the trip to Tasks for every change, and flows 2 and 3 use it.
2. **Approve and merge** (flow 1, steps 5 and 6).
3. **Fix** on the rule break line (flow 3).
4. The composer without modes, and **With me** in the send sheet (flow 2).
5. The comparison choices and the tabs at Peek height (flow 4).
6. Notifications in the send sheet (flow 5), and the one-command start (flow 6).

Each step changes one flow, moves its screens to the parts in `frontend/ui.js`, and lowers the counts in `scripts/ui-baseline.json`. **Decisions** lists the choices that the owner must make first (D8 to D12).
