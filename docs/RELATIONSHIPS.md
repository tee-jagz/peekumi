# Relationships and dependency rules

Peekumi shows static declaration relationships and the evidence for them. A call edge identifies a declaration that the syntax refers to. It does not prove which implementation executes at runtime.

## Adapter contract

The Rust, Python and TypeScript adapters emit `calls`, `implements` and `inherits` candidates. Each candidate has a source symbol, a target expression and a source line. Import relationships use the import resolution that the adapter already has. The common `resolve_relationship` contract uses the committed path/symbol index and the language-specific import resolver of the adapter. The engine records resolved, ambiguous or unresolved outcomes. For an ambiguous outcome, it keeps the candidate targets.

- Rust extracts calls in named functions and impl methods. It also extracts explicit trait implementations and supertraits. Direct local names and qualified/imported names resolve when the declaration matches uniquely. Receiver dispatch needs type information and stays unresolved. Peekumi does not analyze closure bodies, macros or import resolution in inline modules. It does not evaluate conditional compilation.
- Python extracts calls in top-level functions and class methods. It also extracts explicit base classes. Named local functions and imported aliases can resolve. Dynamic receiver calls stay unresolved. Peekumi omits the bodies of nested functions and lambdas, and it does not attribute them to the function that contains them. Peekumi does not infer Python structural protocols as implementations.
- TypeScript/JavaScript extract named functions, top-level variables with function values and class methods. They also extract `extends`/`implements` clauses. Named imports and namespace imports can resolve. This is not compiler type checking. Peekumi does not resolve dynamic receivers, overload dispatch or re-export chains, and it does not follow default-export aliases. Peekumi omits nested function bodies, and Svelte extraction uses only script blocks.

A name that matches must have a compatible declaration kind. Peekumi conservatively keeps shadowed names unresolved. If more than one declaration matches, the result stays ambiguous. Peekumi never changes unknown targets into guessed edges. Failures of installed helpers and parse errors stay visible as analysis gaps.

## Rules

Commit a `.peekumi.json` at the repository root. The viewer never executes the file or reads uncommitted edits. Each side of a comparison uses its own configuration.

```json
{
  "version": 1,
  "groups": {
    "domain": ["backend/domain/**"],
    "adapters": ["backend/adapters/**"]
  },
  "rules": [
    {
      "id": "domain-no-adapters",
      "from": "domain",
      "to": ["adapters"],
      "kinds": ["imports", "calls"],
      "message": "Domain code must depend on a port, not a concrete adapter."
    }
  ]
}
```

A rule has one of three forms. Each form applies only to the relationship `kinds` of the rule:

- `from` and `to`: a file in the `from` group must not use a file in a `to` group.
- `from` and `only`: a file in the `from` group can use only files in the `from` group or in an `only` group. A file in a new folder is outside the allowed groups until you add it. Thus, this form also catches code in places that nobody planned.
- `layers`: a list of groups, from the top layer to the bottom layer. A file in a layer must not use a file in a layer above it. A file that is in no layer is not checked.

```json
{ "id": "services-only", "from": "services", "only": ["store", "shared"], "kinds": ["imports", "calls"] }
{ "id": "layered", "layers": ["routes", "services", "store"], "kinds": ["imports", "calls"] }
```

Groups can overlap, and they do not change the real directory hierarchy. An implementation edge points from the type that implements to its interface/trait. Inheritance points from child to parent. Frontend HTTP calls are not source imports or inferred backend calls.

Paths are relative to the repository. `*` matches in one segment, and `**` crosses directories. `**/` also matches zero directories. `?` matches one byte in a segment. Patterns do not support regexes, negation, absolute paths or parent traversal.

The configuration has these limits: 64 KiB, 100 groups/rules, 100 patterns for each group and 256 bytes for each pattern. Unknown fields, groups, kinds and duplicate rule IDs cause configuration errors, not a result that looks clean.

Rules apply only to resolved relationships. A file that uses itself, for example a call inside one file, never breaks a rule. “0 observed violations” is not proof of compliance. The panel reports external/unresolved/ambiguous relationships and files with analysis gaps.

For each rule, the panel shows how many relationships the rule checked, how many broke it, and how many in its scope stayed unresolved. Peekumi warns about a group that matches no file and a rule that checked no relationship. A typo in a pattern can make a rule pass silently, so read these warnings first.

The panel also lists the breaks that the comparison adds. Such a relationship breaks a rule on the after side, but not on the before side. Old breaks are not in this list, so a review shows only what the change did. A task shows the breaks that it adds before **Approve** and in the merge sheet. On a relationship, **Forbid this dependency** starts an instruction that asks for a rule against it.

**Propose fixes**, the primary button under the rule summary, opens the Proposed fixes page. First, Peekumi groups the breaks at the commit by the rule and by the declaration that they reach. Then the agent that you chose for Ask reads the code, with these groups as its context, and proposes the fixes. It uses the same read-only lookups as Ask, and it changes nothing. A good proposal names what to move, where it goes, which callers change and which group in `.peekumi.json` gets a new file. If the agent fails, try again, or use Peekumi's groups as the proposals. Select the fixes to make, edit their text, and clear the ones to leave out. **Send to an agent** saves the selected fixes as draft instructions and opens the task form with them selected. **Save as drafts** only saves them.

**Propose rules**, under the rule summary, opens the Proposed rules page. The agent that you chose for Ask audits the architecture and proposes new rules. It uses the same read-only lookups as Ask, and it changes nothing. It gets a high-level view first: the map of folders and files, the folder descriptions, the dependency cycles that exist now and the current `.peekumi.json`. A cycle is a fault, so the agent can propose a rule against it without copying the design of the code. Then it reads the READMEs, the module documentation and the entry points.

The agent gets each rule from the job of each part and from an engineering principle, not from the imports that exist now. The code can already contain mistakes, and a rule must not copy them. A rule that the code breaks now can be a good rule: the breaks show the work to do. The agent proposes only rules that the engine can check, and it puts each rule under one principle. The principles are Layering, Acyclic dependencies, Dependency inversion, Open-closed, Separation of concerns, Encapsulation, Stable dependencies and Test isolation.

The agent also gets the rules that earlier audits proposed. It proposes only a rule that is missing and needed: the rule must stop a mistake that is likely in this repository and costly. It does not propose a rule that a current rule or an earlier proposal states, fully or in part. An audit can find that nothing is missing, and that is a good result. The agent proposes at most five rules, the most valuable first. Each rule has one plain sentence with the file or folder names, for example "frontend/model.js must not use other frontend files". It has a value: high, medium or low. When the code breaks the rule now, the agent says what a fix costs. It also says whether the break looks like a mistake or a design that you chose.

The page shows the rules in two sections. **Finds a problem now** has the rules that the code breaks now. A break can be a mistake, or a design that you chose: then leave the rule out. **Guards against future mistakes** has the rules that nothing breaks now. In each section, the most valuable rules come first. When one rule in the list covers another, the other rule shows under it as **Also covers**, so each idea shows once.

The audit runs on the server in the background, and it can take a few minutes. You can leave the page. When notifications are on, Peekumi tells you when the rules are ready.

Each audit adds to a saved list for the repository, and it replaces nothing. Peekumi finds a duplicate by what a rule checks, not by its name. Two rules are the same when they have the same form, kinds and files. A rule with the same ID as a saved rule also counts as that rule. So does a rule with the same files and at least one kind in common. A duplicate counts once. No rule is selected at first. Your selection stays with the list, also after the next audit.

Peekumi leaves out a proposal that checks the same files as a current rule. It also leaves out a proposal that a current rule already covers: each break of the proposal would also break that rule. When a proposal uses a group name that `.peekumi.json` has, the rule uses the patterns in the file now. A warning says so when the patterns are different.

Peekumi tries each rule at the commit on the map, without a commit to `.peekumi.json`. Each rule shows how many relationships it checks, its breaks now and the warnings about its groups. It also shows how many relationships it **cannot check**: a relationship that Peekumi cannot resolve never breaks a rule. So "no break" is only as good as that number. Peekumi leaves out a proposal that the engine refuses, and it says why. Select the rules to add. **Edit rule** shows the rule and its groups as JSON. When you leave the box, Peekumi tries the rule again, and you cannot select a rule that the engine refuses. **Add N rules with an agent** saves each selected rule as a draft instruction on `.peekumi.json` and opens the task form. The agent adds the rules in its own worktree, and you review the result as usual. **Save as drafts** only saves them.

Each task agent gets the rules in its task and a `check_rules` tool. The tool compares the work that the agent committed with the start commit, and it returns the breaks that the work adds. The task tells the agent to fix each added break, or to explain it in its report. If there is no configuration, the panel shows “not configured.” Peekumi shows an invalid configuration as an error. A change to a rule alone can change the comparison status of a relationship.

### Principles as rules

A rule forbids one group of files from using another group. With this, you can state several engineering principles. Peekumi then marks each break on the map, and each agent task contains the rules.

| Principle | Rule pattern |
| --- | --- |
| Dependency inversion: layers | Put the layers in order. Forbid each layer to use a layer above it, for example `store` → `services` and `routes`. |
| Dependency inversion: abstractions | Put the interfaces in one group and the implementations in another. Forbid the callers to use the implementations. |
| Acyclic dependencies | A complete order of layers also prevents cycles between those groups. For two modules: if A uses B, forbid B → A. |
| Stable dependencies | Forbid shared code (`shared`, `utils`, `lib`) to use feature groups. |
| Encapsulation | Make a group for the internals of a module, and a group for the other modules. Patterns have no exclusion, so name the other modules. |
| Composition over inheritance | Forbid only `inherits` from your code to concrete base classes. Keep `implements`, so code can still implement an interface. |
| Separation of concerns | Forbid the user interface to use the data store directly, and forbid production code to use test code. |

These rules do not measure size, complexity or duplicated code, so they cannot state KISS or DRY. They do not apply to libraries outside the repository. To keep code away from a library, put the library behind your own module, and forbid the use of that module.

Peekumi's own `.peekumi.json` uses some of these patterns. The analysis code does not use the agent workflow. The shared frontend modules do not use the feature modules. The product code does not use the test code.

## Inspecting evidence

Open Dependencies to filter imports, calls, implementations or inheritance, or to show only violations. Select a symbol to focus on its incoming/outgoing relationships. Resolved edges show on the map, and uncertain relationships stay in a list that you can expand.

When you select a card, Peekumi highlights the edges of that card by direction: accent for what it uses, teal for what uses it. It also fades unrelated edges and cards. Implementations are dotted, inheritance is dashed and violations are red, with a badge on the source card. Before/After changes both the graph and the rule outcomes.

Open a file to see the source evidence and the reasons for unresolved relationships. Evidence buttons open the source declaration in the applicable revision. Imports currently give file-level evidence, but calls and heritage include line numbers. Dense function maps draw the calls for the selected symbol. Other edges have a limit of 40, and the evidence list shows the first 200 records with an explicit count. To make larger lists shorter, select a symbol or a relationship kind.

The initial map transfers compact file-pair tuples (paths, kind, before/after counts and rule evidence). Ordinary import pairs already arrive with file metadata, and Peekumi does not send them two times. This overview contains same-file pairs only when they carry rule evidence. Peekumi fetches the full symbol relationships when you open a file.

Repeated call sites share a stable relation identity with a list of source lines. Thus, added blank lines do not cause relationship churn. Renames still show as a removal and an addition. Peekumi does no runtime tracing or cross-language call inference.
