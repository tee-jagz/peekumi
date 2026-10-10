# Writing

Words are part of the design. Fewer words make the screen faster to read and easier to trust.

## Rules

- Labels have one to three words. Buttons are verbs. Links to a page are nouns.
- Sentence case everywhere.
- No paragraph under a heading to explain the screen. Show the state instead.
- A meta line has at most two items with " · ". More facts go in separate fields.
- Errors say what failed and what to do. No "Oops", no "Sorry", no "we".
- Name things the way the owner knows them: "rule breaks", not "violations"; "uncommitted changes", not "worktree snapshot".
- Say a number with its unit: "3 files", "20 breaks", "2 min".
- Do not write in Peek's voice. Peek never talks.
- Write UI text in ASD-STE100 style: short sentences, the active voice, one meaning for each word.

## Before and after

These examples come from the current app.

| Now | New |
|---|---|
| "Claude Code proposed these rules from the architecture, not from the imports that exist now. Each rule says which files must not use which. Select the rules to add; your selection stays. "Cannot check" counts relationships…" (audit.js) | Remove. The rows show each rule. Put "From Claude Code" in the page's meta line. Explain "cannot check" in the key, once. |
| "An agent writes the commit message. You check it before Peekumi commits. Then the task is brought up to date with your commit; if they conflict, the agent resolves it and you review again." (workflow.js) | Field label: "Commit message". Button: "Commit and merge". A help link "How this works" opens the steps. |
| "N instructions need your decision (flagged, or not done). Approve covers only the finished ones. After a merge, they become drafts again." (workflow.js) | A group heading: "Needs your decision (2)". The rows show each instruction's state. |
| "Separation of concerns · medium value · checks 60 relationships · cannot check 506 · 20 breaks now · drafted" (audit.js) | The figure "20 breaks" (`figure`), then a caption with two items: "Separation of concerns · Medium". The rest goes in the detail. |
| "Breaks ui-no-db · 3 calls to store.py" (app.js) | "Breaks ui-no-db" with the broken-link icon, and "3 calls to store.py" as a second line. |
| "N drafts waiting · Review task ›" (workflow.js) | A primary button "Review 3 drafts". |
| "Commit message · written by the agent, you can edit it" (workflow.js) | Label "Commit message", with the caption "From the agent". |
| "No changed symbols or items here. Open Source for file-level changes, or turn off Changes only." (app.js) | "No changes here." and one button, "Show all". |
| "Cannot reach Peekumi. Check that the server is running and your phone is connected to its network or Tailscale." (app.js) | "Cannot reach Peekumi" as the title, "Check that the server runs and your phone is on its network." as the line, and a "Try again" button. |
| "Forbid this dependency ›", "Audit again ›" | "Forbid this dependency", "Audit again". The chevron icon shows that it opens a page; no text "›". |

## Words to use

| Use | Do not use |
|---|---|
| Rule break | Violation |
| Uncommitted changes | Worktree, snapshot |
| Instruction | Comment (in the interface) |
| Task | Run (in the interface) |
| Merge into main | Apply, fast-forward |
| Needs you | Attention required |
| Cannot check | Unresolved (in the interface) |
