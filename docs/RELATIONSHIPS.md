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

Rules apply only to resolved relationships. “0 observed violations” is not proof of compliance. The panel reports external/unresolved/ambiguous relationships and files with analysis gaps.

For each rule, the panel shows how many relationships the rule checked, how many broke it, and how many in its scope stayed unresolved. Peekumi warns about a group that matches no file and a rule that checked no relationship. A typo in a pattern can make a rule pass silently, so read these warnings first.

The panel also lists the breaks that the comparison adds. Such a relationship breaks a rule on the after side, but not on the before side. Old breaks are not in this list, so a review shows only what the change did. A task shows the breaks that it adds before **Approve** and in the merge sheet. On a relationship, **Forbid this dependency** starts an instruction that asks for a rule against it.

**Propose fixes**, the primary button under the rule summary, opens the Proposed fixes page. First, Peekumi groups the breaks at the commit by the rule and by the declaration that they reach. Then the agent that you chose for Ask reads the code, with these groups as its context, and proposes the fixes. It uses the same read-only lookups as Ask, and it changes nothing. A good proposal names what to move, where it goes, which callers change and which group in `.peekumi.json` gets a new file. If the agent fails, try again, or use Peekumi's groups as the proposals. Select the fixes to make, edit their text, and clear the ones to leave out. **Send to an agent** saves the selected fixes as draft instructions and opens the task form with them selected. **Save as drafts** only saves them.

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
