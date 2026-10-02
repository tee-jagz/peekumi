# Relationships and dependency rules

Peekumi shows static declaration relationships and the evidence behind them. A call edge identifies a declaration that syntax refers to; it does not prove which implementation executes at runtime.

## Adapter contract

Rust, Python and TypeScript adapters emit `calls`, `implements` and `inherits` candidates with source symbol, target expression and source line. Import relationships reuse the adapter's existing import resolution. The common `resolve_relationship` contract uses the committed path/symbol index and the adapter's language-specific import resolver. The engine records resolved, ambiguous or unresolved outcomes and retains candidate targets for ambiguity.

- Rust extracts calls in named functions and impl methods, explicit trait implementations and supertraits. Direct local and qualified/imported names resolve when the declaration matches uniquely. Receiver dispatch requires type information and remains unresolved. Closure bodies, macros and inline-module import resolution are not analyzed. Conditional compilation is not evaluated.
- Python extracts calls in top-level functions and class methods, plus explicit base classes. Named local functions and imported aliases can resolve. Dynamic receiver calls stay unresolved; nested function/lambda bodies are omitted rather than attributed to their enclosing function. Python structural protocols are not inferred as implementations.
- TypeScript/JavaScript extract named functions, top-level function-valued variables and class methods, plus `extends`/`implements` clauses. Named imports and namespace imports can resolve. This is not compiler type checking: dynamic receivers, overload dispatch, default-export alias following and re-export chains are not resolved. Nested function bodies are omitted. Svelte extraction is limited to script blocks.

A matching name must have a compatible declaration kind. Shadowed names are conservatively unresolved; multiple matching declarations remain ambiguous. Unknown targets never become guessed edges. Installed helper failures and parse errors remain visible as analysis gaps.

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

Rules prohibit the specified directed relationship from any file in the source group to any file in the destination groups. Groups can overlap and do not change the real directory hierarchy. An implementation edge points from the implementing type to its interface/trait; inheritance points from child to parent. Frontend HTTP calls are not source imports or inferred backend calls.

Paths are repository-relative. `*` matches within one segment; `**` crosses directories; `**/` also matches zero directories; `?` matches one byte within a segment. No regexes, negation, absolute paths or parent traversal. Configuration is limited to 64 KiB, 100 groups/rules, 100 patterns per group and 256 bytes per pattern. Unknown fields, groups, kinds and duplicate rule IDs produce configuration errors rather than an apparently clean result.

Rules apply only to resolved relationships. “0 observed violations” is not proof of compliance: the panel reports external/unresolved/ambiguous relationships and files with analysis gaps. Missing configuration says “not configured.” Invalid configuration is shown as an error. A rule edit alone can change a relationship's comparison status.

## Inspecting evidence

Open Dependencies to filter imports, calls, implementations or inheritance, or show violations only. Select a symbol to focus incoming/outgoing relationships. Resolved edges appear on the map; uncertainty stays in an expandable list. Selecting a card emphasises its own edges by direction, accent for what it uses and teal for what uses it, and fades unrelated edges and cards. Implementations are dotted, inheritance dashed and violations red with a badge on the source card. Before/After switches both the graph and rule outcomes.

Open a file to see source evidence and unresolved reasons; evidence buttons open the source declaration in the appropriate revision. Imports currently provide file-level evidence, while calls and heritage include line numbers. Dense function maps draw calls for the selected symbol; other edges are capped at 40 and the evidence list shows the first 200 records, with an explicit count. Select a symbol or relationship kind to narrow larger lists.

The initial map transfers compact file-pair tuples (paths, kind, before/after counts and rule evidence). Ordinary import pairs already arrive with file metadata and are not duplicated. Same-file pairs are sent in this overview only when they carry rule evidence. Full symbol relationships are fetched when opening a file. Repeated call sites share a stable relation identity with a list of source lines, so adding blank lines does not create relationship churn. Renames still appear as removal/addition; no runtime tracing or cross-language call inference is performed.
