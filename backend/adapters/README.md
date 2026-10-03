# Language adapters

Language adapters change source syntax into a shared model. This model contains symbols, documentation, explicit types and imports. The Rust, Python and TypeScript adapters implement the same LanguageAdapter contract. The repository engine controls Git access, the cache and comparisons. These functions do not depend on the language.

- `mod.rs`: The interface, the registry, the capabilities and the shared resolution context.
- `rust_relationships.rs`: Call sites from the syntax, trait implementations and supertrait edges.
- `rust.rs`: Native syn parsing and resolution of conventional Rust modules.
- `python.rs` and `python_ast.py`: Python AST parsing and resolution of package imports.
- `typescript.rs` and `typescript_ast.mjs`: Parsing of JavaScript, TypeScript and Svelte scripts, and import resolution.

Each implementation declares its supported extensions, limitations and parser identity. It also declares batch analysis, import resolution and declaration-target resolution. Adapter batches contain typed relationship candidates, source lines, and lookup evidence or an unresolved reason.

Register each new implementation in `all()`. Adapters never expand or execute the inspected code. Missing interpreters and parse failures stay as explicit results for each file.

The frontend shows the selected adapter and its capabilities under Details. The adapters extract documentation; they do not generate it. They do not infer types.
