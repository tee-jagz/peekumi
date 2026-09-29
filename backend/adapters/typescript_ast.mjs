// Syntax parser only: never execute inspected code.
import ts from "typescript";
import { createHash } from "node:crypto";
const hash = (value) => createHash("sha256").update(value).digest("hex");
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
