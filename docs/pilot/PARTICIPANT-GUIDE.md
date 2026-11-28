# Peekumi verification pilot guide

Thank you for taking part in this review study.

## Purpose

This study compares how accurately and quickly you decide on coding-agent changes with two setups:

- **Control:** GitHub pull request view, CI status, and an AI reviewer summary.
- **Treatment:** Peekumi with its four-part review sheet (Peekumi checks, CI, Agent claims, and Blind spots), sandboxed checks, and CRAP scores.

## Session format

1. You review 20 short change cases in a counterbalanced order.
2. Half of the cases use the control setup. The other half use Peekumi.
3. For each case, choose one decision:
   - `approve`: ready to merge as shown.
   - `request-changes`: send back to the agent before merging.
   - `defer`: need more information before deciding.
4. Work at your normal review pace. Accuracy matters more than speed.

## What the study logs

The pilot script records only raw facts:

- Participant ID and assigned tool order.
- Case ID, tool used, decision, and elapsed seconds.
- Whether the case contained planted false evidence (stale CI, skipped check, or weakened test).
- Optional follow-up field for whether a merged real PR was later reverted.

## Running the session script

```sh
node scripts/pilot/run-pilot.mjs --participant p01 --log pilot-results.jsonl
```

To test the script without live input:

```sh
node scripts/pilot/run-pilot.mjs --dry-run
```

## Success criteria

- Zero approvals on cases with planted false evidence when using Peekumi.
- Median review time at least 25 percent faster with Peekumi (reported both overall and for clean cases separately).
- At least two participating teams bring an additional real PR without a prompt.
