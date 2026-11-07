---
name: peekumi
description: Check change impact, frozen dependency rules and measured Python CRAP with Peekumi.
---

# Peekumi Risk Map

Call `peekumi_impact(path_or_symbol)` before you edit a file or declaration.
Read its dependents, frozen rules, findings and limits.
The baseline includes files that were already dirty before this turn.
Do not claim that you created those changes.

Call `peekumi_measure()` to measure coverage after an edit or a test change.
Do not run a coverage command by hand.
The tool runs the configured commands in a new private copy of the exact snapshot.
For an existing changed function, it also measures the frozen baseline if needed.
Each revision has its own copy and coverage report.
Failed baseline tests keep the before score unknown.
It records command failures as failed evidence.
It binds the report to the source SHA that the copy contains.
An edit in the checkout during measurement does not change that evidence.

Fix new rule breaks and rule changes.
Add tests or simplify a changed function when its CRAP exceeds the threshold.
Then call `peekumi_measure()` again.
Read the new evidence before you say that the repair passes.
Unknown coverage is not zero coverage.
An unavailable or incomplete check does not pass.

If a finding must stay, call `peekumi_impact` with `path_or_symbol`, `finding_id` and `reason`.
Use a specific reason that the owner can review.
This records an exception. The finding stays visible.
An explanation alone cannot clear a finding.

The gate uses the API outcome.
At the nudge cap, open findings become `exhausted` after the final refresh.
The pane says that the agent stopped.
Shell-only edits can skip the gate, but the final refresh still checks them.
If Peekumi is unavailable, report that limit in your answer.
