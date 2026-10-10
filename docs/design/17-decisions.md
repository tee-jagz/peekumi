# Decisions

These choices change Peekumi's rules or look. Each one has a recommendation. They are open until the owner decides.

## D1. Glass on two parts only

`AGENTS.md` says: "preserve its glass surfaces". The audit shows glass on every button and card, and NN/g finds translucent surfaces "less legible" and "constantly pulling focus".

**Recommendation:** keep glass on the review sheet and the composer only, as layers that float over the map. Change the `AGENTS.md` line to: "Glass is for the floating sheet and composer only; everything else is opaque."

## D2. The typeface

**Decided (2026-10-09):** `Atkinson Hyperlegible Next` and `Mono`. **Changed (2026-10-10):** `Host Grotesk` for the interface and the display styles, and `JetBrains Mono` for code, with the glass strata look. **Looks** gives the reasons.

## D3. Colour-blind safe themes

**Recommendation:** ship them as a setting ("Colour-blind safe colours"), off by default. Diffs keep the green and red that developers know, and every status keeps its glyph in every theme.

## D4. Peek's role

**Decided (2026-10-09):** the owner asked for the animated Peek in the interface states. Peek shows the state of the app and of the agent, with the animations of `frontend/peek.js`. **Peek** gives the places and the rules.

## D5. The dashed outline

**Recommendation:** a dashed outline means "removed" only. Uncommitted changes get a `warning` dot, and a stub neighbour gets a plain `line` border with its name in `ink-muted`.

## D6. The desktop panel

**Recommendation:** from 900px wide, the sheet becomes a right panel of 400 to 480px, without heights or a grabber.

## D7. The accent colour

**Decided (2026-10-09):** ink black in light and mint (`#72e3c6`) in dark, as part of the look in D13. The iOS blue `#007aff` is removed.

## D8. Approve and merge as one action

**Flows**, flow 1. Today **Approve** and **Merge into main** are two steps. The owner nearly always merges after approval.

**Decided (2026-10-09):** the owner chose the recommendation and asked for the whole system to be implemented.

**Recommendation:** make **Approve and merge** the primary button. Its dialog records the approval, then merges, after one confirmation. **Approve only** stays in the same dialog, and **Undo merge** stays after it.

## D9. A composer without modes

**Flows**, flow 2. Today the owner must choose Ask, Instruction or Session before they type.

**Decided (2026-10-09):** the owner chose the recommendation and asked for the whole system to be implemented.

**Recommendation:** one field with **Ask** and **Add as a change**. A session becomes **With me** in the send sheet, and it starts with the changes in the tray as its first message.

## D10. Fix without the proposal wait

**Flows**, flow 3. Today a fix waits for the Ask agent to propose it, then goes through the task form.

**Decided (2026-10-09):** the owner chose the recommendation and asked for the whole system to be implemented.

**Recommendation:** **Fix** on the rule break line writes the change from the rule and the break, and the task agent finds the fix. **Compare proposed fixes** stays for many breaks or for options.

## D11. Compare by the question

**Flows**, flow 4. Today the owner chooses a head and a base.

**Decided (2026-10-09):** the owner chose the recommendation and asked for the whole system to be implemented.

**Recommendation:** four choices: **The last commit** (the default), **Since my last look**, **This branch against main** and **Choose commits…**. "Since my last look" keeps one time for each device.

## D12. One command to start

**Flows**, flow 6. Today the first run needs 5 to 6 commands in the right order.

**Decided (2026-10-09):** the owner chose the recommendation and asked for the whole system to be implemented.

**Recommendation:** `peekumi` with no arguments adds the repository it runs in, asks once about phone access, and prints the pairing link.

## D13. The look

**Decided (2026-10-09):** Survey in light and Strata in dark. **Changed (2026-10-10):** the owner said that Survey looked like AI output. After three studies and a high-fidelity canvas that the owner reviewed in several rounds, the owner asked to implement glass strata in both themes. **Looks** gives the reasons.
