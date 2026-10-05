/** @module Syntax-only JavaScript, TypeScript and Svelte helper using the TypeScript compiler parser. Reads JSON batches and never executes inspected code. */
// Syntax parser only: never execute inspected code.
import ts from "typescript";
import { createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(value).digest("hex");
/** Extracts explicit heritage and conservative lexical calls without loading project code. */
function relationships(tree, symbols) {
  const result = [],
    bindings = new Map(),
    names = new Set(symbols.map((s) => s.name));
  for (const node of tree.statements)
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text,
        clause = node.importClause;
      if (clause?.name)
        bindings.set(clause.name.text, { specifier, name: "default" });
      const bound = clause?.namedBindings;
      if (bound && ts.isNamespaceImport(bound))
        bindings.set(bound.name.text, { specifier, namespace: true });
      if (bound && ts.isNamedImports(bound))
        for (const e of bound.elements)
          bindings.set(e.name.text, {
            specifier,
            name: (e.propertyName || e.name).text,
          });
    }
  const writes = new Set();
  function writesVisit(n) {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(n.left)
    )
      writes.add(n.left.text);
    if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
        n.operator,
      ) &&
      ts.isIdentifier(n.operand)
    )
      writes.add(n.operand.text);
    ts.forEachChild(n, writesVisit);
  }
  writesVisit(tree);
  function record(owner, expression, kind, blocked = new Set(), klass = null) {
    const target = expression.getText(tree),
      entry = {
        source: owner,
        target,
        kind,
        line:
          tree.getLineAndCharacterOfPosition(expression.getStart(tree)).line +
          1,
      };
    const root = target.split(".")[0],
      binding = bindings.get(root);
    // this.method() in a class member: a method of that class (or unresolved).
    const own = klass && /^this\.([A-Za-z_$][\w$]*)$/.exec(target);
    if (own) entry.lookup = { method: { type: klass, fields: [], name: own[1] } };
    else if (blocked.has(root) || writes.has(root))
      entry.reason = "Name is shadowed or assigned in this scope";
    else if (binding && names.has(root))
      entry.reason = "Conflicting local and imported declarations";
    else if (binding && target === root && !binding.namespace)
      entry.lookup = { import: binding, name: binding.name };
    else if (binding?.namespace && target.startsWith(root + "."))
      entry.lookup = { import: binding, name: target.slice(root.length + 1) };
    else if (names.has(target) && ts.isIdentifier(expression))
      entry.lookup = { local: target };
    else
      entry.reason =
        "Dynamic receiver, external name or unsupported lexical binding";
    result.push(entry);
  }
  function calls(owner, node, klass = null) {
    if (!node.body) return;
    const blocked = new Set();
    function bind(name) {
      if (ts.isIdentifier(name)) blocked.add(name.text);
      else if (name?.elements)
        for (const e of name.elements) if (e.name) bind(e.name);
    }
    for (const p of node.parameters || []) bind(p.name);
    function locals(n) {
      if (
        ts.isVariableDeclaration(n) ||
        ts.isParameter(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isClassDeclaration(n)
      )
        bind(n.name);
      ts.forEachChild(n, locals);
    }
    locals(node.body);
    function visit(n) {
      if (ts.isFunctionLike(n) || ts.isClassDeclaration(n)) return;
      if (ts.isCallExpression(n) || ts.isNewExpression(n))
        record(owner, n.expression, "calls", blocked, klass);
      ts.forEachChild(n, visit);
    }
    visit(node.body);
  }
  for (const node of tree.statements) {
    if (ts.isFunctionDeclaration(node))
      calls(node.name?.text || "default", node);
    if (ts.isVariableStatement(node))
      for (const d of node.declarationList.declarations)
        if (
          d.initializer &&
          (ts.isArrowFunction(d.initializer) ||
            ts.isFunctionExpression(d.initializer))
        )
          calls(d.name.getText(tree), d.initializer);
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      const owner = node.name?.text || "default";
      for (const h of node.heritageClauses || [])
        for (const type of h.types)
          record(
            owner,
            type.expression,
            h.token === ts.SyntaxKind.ImplementsKeyword
              ? "implements"
              : "inherits",
          );
      for (const m of node.members || [])
        if (
          ts.isMethodDeclaration(m) ||
          ts.isConstructorDeclaration(m) ||
          ts.isGetAccessor(m) ||
          ts.isSetAccessor(m)
        )
          calls(owner + "." + (m.name?.getText(tree) || "constructor"), m, owner);
    }
  }
  return result;
}

/** Extracts symbols, documentation, explicit declarations and static import specifiers from one source file. Svelte parsing preserves original line positions while excluding markup and non-code script blocks. Returns explicit parse diagnostics when syntax is invalid. */
function jsAnalyze(file, source) {
  const svelte = file.endsWith(".svelte");
  // Preserve line numbers while excluding markup from TypeScript parsing.
  let text = source;
  if (svelte) {
    const chars = source.split("").map((c) => (c === "\n" ? "\n" : " "));
    for (const match of source.matchAll(
      /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi,
    )) {
      const tag = match[0].slice(0, match[0].indexOf(">") + 1);
      const type = tag.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1];
      if (
        type &&
        !["module", "text/javascript", "application/javascript"].includes(type)
      )
        continue;
      const offset = match.index + match[0].indexOf(">") + 1;
      // String indices, rather than code points, must match parser offsets.
      for (let i = 0; i < match[1].length; i++) chars[offset + i] = match[1][i];
    }
    text = chars.join("");
  }
  const tree = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") || file.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  );
  if (tree.parseDiagnostics.length)
    return {
      symbols: [],
      imports: [],
      analysis:
        "parse error: " +
        ts.flattenDiagnosticMessageText(
          tree.parseDiagnostics[0].messageText,
          " ",
        ),
    };
  const symbols = [],
    imports = [];
  const printer = ts.createPrinter({ removeComments: true });
  const commentText = (comment) =>
    typeof comment === "string"
      ? comment
      : comment?.map((part) => part.text || "").join("") || "";
  function details(node, name, kind) {
    const callable =
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
        ? node.initializer
        : node;
    const docs =
      node.jsDoc ||
      (ts.isVariableDeclaration(node) ? node.parent?.parent?.jsDoc : null) ||
      [];
    const tags = docs.flatMap((doc) => [...(doc.tags || [])]);
    const returns = tags.find((tag) =>
      ["returns", "return"].includes(tag.tagName.text),
    );
    const result = {
      description: docs
        .map((doc) => commentText(doc.comment))
        .filter(Boolean)
        .join("\n\n"),
      provenance: "TypeScript / JSDoc declarations",
    };
    const params = callable.parameters;
    if (params) {
      result.parameters = params.map((param) => {
        const tag = tags.find(
          (tag) =>
            tag.tagName.text === "param" &&
            tag.name?.getText(tree) === param.name.getText(tree),
        );
        return {
          name: (param.dotDotDotToken ? "..." : "") + param.name.getText(tree),
          type:
            param.type?.getText(tree) ||
            tag?.typeExpression?.type?.getText(tree) ||
            null,
          optional: !!param.questionToken || !!tag?.isBracketed,
          default: param.initializer?.getText(tree) ?? null,
          description: commentText(tag?.comment),
        };
      });
      result.returns =
        callable.type?.getText(tree) ||
        returns?.typeExpression?.type?.getText(tree) ||
        null;
      result.returnDescription = commentText(returns?.comment);
      result.async = !!callable.modifiers?.some(
        (mod) => mod.kind === ts.SyntaxKind.AsyncKeyword,
      );
      result.signature =
        (result.async ? "async " : "") +
        name +
        (callable.typeParameters?.length
          ? "<" +
            callable.typeParameters.map((p) => p.getText(tree)).join(", ") +
            ">"
          : "") +
        "(" +
        params.map((p) => p.getText(tree)).join(", ") +
        ")" +
        (result.returns ? ": " + result.returns : "");
    } else {
      result.type = node.type?.getText(tree) || null;
      result.bases =
        node.heritageClauses?.map((clause) => clause.getText(tree)) || [];
      result.signature =
        kind +
        " " +
        name +
        (result.type ? ": " + result.type : "") +
        (result.bases.length ? " " + result.bases.join(" ") : "");
      result.fields =
        node.members
          ?.filter(
            (member) =>
              ts.isPropertyDeclaration(member) ||
              ts.isPropertySignature(member),
          )
          .map((member) => ({
            name: member.name.getText(tree),
            type: member.type?.getText(tree) || null,
            optional: !!member.questionToken,
          })) || [];
    }
    return result;
  }
  // Body only: the code a declaration runs or contains, without signature or documentation.
  // Class bodies are their methods; their typed fields belong to the signature.
  function bodyOf(node) {
    if (ts.isClassDeclaration(node))
      return node.members
        .filter((member) => !ts.isPropertyDeclaration(member))
        .map((member) => printer.printNode(ts.EmitHint.Unspecified, member, tree))
        .join("\n");
    const part = ts.isVariableDeclaration(node)
      ? node.initializer
      : ts.isTypeAliasDeclaration(node)
        ? node.type
        : node.body;
    return part ? printer.printNode(ts.EmitHint.Unspecified, part, tree) : "";
  }
  function add(node, name, kind) {
    symbols.push({
      name,
      kind,
      start: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      end: tree.getLineAndCharacterOfPosition(node.end).line + 1,
      details: details(node, name, kind),
      hash: hash(
        printer.printNode(ts.EmitHint.Unspecified, node, tree) +
          JSON.stringify(details(node, name, kind)),
      ),
      body: hash(bodyOf(node)),
    });
  }
  for (const node of tree.statements) {
    if (ts.isFunctionDeclaration(node))
      add(node, node.name?.text || "default", "function");
    if (ts.isClassDeclaration(node)) {
      const name = node.name?.text || "default";
      add(node, name, "class");
      for (const member of node.members)
        if (
          ts.isMethodDeclaration(member) ||
          ts.isConstructorDeclaration(member) ||
          ts.isGetAccessor(member) ||
          ts.isSetAccessor(member)
        )
          add(
            member,
            `${name}.${member.name?.getText(tree) || "constructor"}`,
            "method",
          );
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
      add(node, node.name.text, "type");
    if (ts.isVariableStatement(node))
      for (const declaration of node.declarationList.declarations) {
        add(
          declaration,
          declaration.name.getText(tree),
          declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) ||
              ts.isFunctionExpression(declaration.initializer))
            ? "function"
            : "variable",
        );
      }
  }
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.push({ specifier: node.moduleSpecifier.text });
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(tree) === "require") &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      imports.push({ specifier: node.arguments[0].text });
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return {
    symbols,
    imports,
    relationships: relationships(tree, symbols),
    details: {
      description: (ts.getLeadingCommentRanges(text, 0) || [])
        .map((range) => text.slice(range.pos, range.end))
        .filter((comment) => /@(?:module|fileoverview|file)\b/.test(comment))
        .map((comment) =>
          comment
            .replace(/^\/\*\*?|\*\/$/g, "")
            .replace(/^\s*\* ?/gm, "")
            .replace(/@(?:module|fileoverview|file)\b/g, "")
            .trim(),
        )
        .join("\n\n"),
      provenance: "JSDoc module comment",
    },
    analysis: svelte
      ? "Svelte script AST · template at file level"
      : "TypeScript AST",
  };
}

if (process.argv.includes("--version"))
  console.log(ts.version + ":" + process.version);
else {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const part of process.stdin) input += part;
  process.stdout.write(
    JSON.stringify(
      JSON.parse(input).map((file) => jsAnalyze(file.path, file.source)),
    ),
  );
}
