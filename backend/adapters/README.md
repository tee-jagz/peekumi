# Language adapters

Language adapters translate source syntax into a shared model of symbols, documentation, explicit types and imports. Rust, Python and TypeScript implement the same LanguageAdapter contract; the repository engine handles Git access, caching and comparisons independently of language.

- `mod.rs`: interface, registry, capabilities and shared resolution context.
- `rust.rs`: native syn parsing and conventional Rust module resolution.
- `python.rs` and `python_ast.py`: Python AST parsing and package import resolution.
- `typescript.rs` and `typescript_ast.mjs`: JavaScript, TypeScript and Svelte script parsing and import resolution.

Each implementation declares supported extensions, limitations, parser identity, batch analysis and import resolution. Register new implementations in `all()`. Adapters never expand or execute inspected code. Missing interpreters and parse failures remain explicit file-level results.

The frontend exposes the selected adapter and its capabilities under Details. Documentation is extracted, not generated, and types are not inferred.
