# Pilot outreach draft

> Status: Draft only. Send nothing without explicit owner approval.

## Target profile

Recruit 5 to 8 hands-on reviewers who match these criteria:

1. Tech lead, staff engineer, or CTO in a small engineering team (2 to 25 engineers).
2. Reviews pull requests or branches written by coding agents (Claude Code, Codex, Cursor, Devin, or Copilot) at least three times a week.
3. Ships code in Python, TypeScript, or Rust with an existing CI pipeline.
4. Has felt the pain of trusting a green check or an agent summary that hid a skipped test, stale CI run, or weakened assertion.

## Where to find them

- Direct network of founders, CTOs, and staff leads already using Claude Code or Codex daily.
- Small-team engineering communities and local founder groups.
- Maintainers of active open-source Python or TypeScript projects who review AI-assisted PRs.

## Outreach message (short version)

Subject: Quick 45-minute code review test on real agent PRs

Hi [Name],

I am building Peekumi, a review tool that sits next to GitHub and CI when you inspect coding-agent changes. It keeps four things apart: what Peekumi checked itself in a sandbox, what CI reported for that exact commit, what the agent claimed, and what nobody checked.

I am running a small pilot with 5 to 8 engineering leads who review agent PRs every week. In a 45-minute session, you review a short set of real agent changes, half with your normal GitHub + CI setup and half with Peekumi. We measure review time and whether subtle check gaps get caught.

No setup on your production repos is required for the session. If it proves useful, you can try it on one of your own PRs afterward.

Would you have 45 minutes next week?

Thanks,
[Your name]
