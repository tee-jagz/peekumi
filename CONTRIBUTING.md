# Contributing to Peekumi

Thank you for your help. This guide tells you how to propose a change, how to make it and what a pull request must include. It applies to every contribution: code, documentation, a new language or a new agent provider.

All participants obey the [code of conduct](CODE_OF_CONDUCT.md). For questions, see [SUPPORT.md](SUPPORT.md).

## Before you start

1. Search the [issues](https://github.com/tee-jagz/peekumi/issues) for the same idea.
2. For a new language or a new agent provider, open an issue with the **Language support** or **Agent provider** form first. Wait for an agreement on the scope before you write code. These changes touch the analysis cache, the security model or the release bundle, so a short discussion first saves work.
3. For a small fix (a defect, a typo, a test), you can open a pull request directly.
4. Do not report a security problem in an issue. Use the private form in [SECURITY.md](SECURITY.md).

## The rules that every change keeps

Peekumi makes promises to the people who use it. A change that breaks one of these rules cannot merge:

- **Inspection is read-only.** Peekumi reads committed Git objects. It never switches the inspected checkout, pushes, changes hooks or runs the inspected code. Only an explicit owner action starts an agent, and the agent works in its own worktree.
- **Every tracked file is visible.** Binary, oversized, unsupported and restricted files stay on the map with a label. Peekumi does not hide a file that it cannot read.
- **The map uses the real folders.** Do not invent architectural layers.
- **Relationships are static and honest.** Imports, calls, implementations and inheritance come from declarations in the code, not from a run. An unresolved or ambiguous target stays unresolved or ambiguous. Do not guess a target.
- **Secrets stay private.** Restricted file names (see `restricted()` in `backend/engine.rs`) never show in Source and never go to Ask or an agent. Never commit credentials, tokens, private source or test snapshots of another repository.
- **The interface is minimal.** Status goes into existing rows as plain text, Peek and icons. Do not add cards, bands, tinted boxes, badges or shadows around a line of status. Each view has one primary button.

## Set up and test

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) tells you how to build and run Peekumi from a checkout. Run the tests that apply to your change:

| You changed | Run |
|---|---|
| The engine, the server or a script | `npm test` and `npm run test:rust` |
| The interface (`frontend/`) | `npm run test:browser`, then look at phone and desktop screenshots in `test-results/` |
| Only documentation | Check the links and the text. No test is necessary. |

Before you push, run these two commands:

- `npm run format`: Prettier and rustfmt make the layout of the code. Do not change the layout by hand.
- `npm run lint`: `clippy` with warnings as errors, and a check of the writing rules in the documents.

CI runs the format check, the lint, a secret scan, a vulnerability audit and all three test suites on each pull request. A pull request can merge only when the `checks` and `test` jobs pass.

## Write the change

- **Code documentation.** Give each module and each public function a short comment that tells its job, its inputs and outputs, and its errors and side effects: `//!` and `///` in Rust, `@module` and JSDoc in JavaScript, docstrings in Python. Keep the README of each folder true to the code.
- **Documents for people.** Write the README files, `docs/` and the skills in [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/). Use short sentences, one instruction in each sentence, active voice, simple tenses and approved words. `npm run lint` checks some of these rules. Keep commands, paths, API routes and interface labels exactly as they are. Do not use em dashes.
- **Tests.** Add a test that fails before your change and passes after it. For a defect, the test shows the defect.
- **The changelog.** Add one line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md). Write what changes for the user, not how you made it.

## Extend Peekumi

[docs/EXTENDING.md](docs/EXTENDING.md) gives the full steps and the definition of done for:

- **A new language** (a language adapter).
- **A new agent provider** for Ask, tasks or sessions.

Both have a contract in Rust and a test that checks it. If you keep the contract, the interface needs no change: it reads the names and the abilities of languages and providers from the server.

## Open a pull request

1. Make a branch from `main`. Keep one subject in each pull request.
2. Fill in the pull request form. It asks which tests you ran and which rules your change touches.
3. Use a commit message that tells what changes and why, in the imperative: "Show the commit of a restricted file", not "Fixed bug".
4. A maintainer reviews the change. After the review, the maintainer merges it into `main`.

## Licence

Peekumi uses the [Apache License 2.0](LICENSE). When you submit a contribution, you agree that it is licensed under the same licence (section 5 of the licence). You do not sign a separate agreement.
