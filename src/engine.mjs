import { readFileSync } from "node:fs";
import { AnalysisIndex } from "./analysis-index.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const pythonScript = fileURLToPath(new URL("./python_ast.py", import.meta.url));
const MAX_SOURCE = 512 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");
export function command(
  executable,
  args,
  { input, cwd, timeout = 30000 } = {},
) {
  return new Promise((resolve, reject) => {
    const process = spawn(executable, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = [],
      errors = [];
    const timer = setTimeout(() => {
      process.kill();
      reject(new Error(`${executable} timed out`));
    }, timeout);
    process.stdout.on("data", (data) => output.push(data));
    process.stderr.on("data", (data) => errors.push(data));
    process.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    process.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(output));
      else
        reject(
          new Error(
            Buffer.concat(errors).toString() || `${executable} exited ${code}`,
          ),
        );
    });
    process.stdin.on("error", () => {});
    process.stdin.end(input);
  });
}
export function restricted(file) {
  const name = path.posix.basename(file).toLowerCase();
  return (
    (/^\.env($|\.)/.test(name) && !/\.(example|sample|template)$/.test(name)) ||
    /\.(pem|key|p12|pfx)$/.test(name) ||
    /^(id_rsa|id_ed25519|credentials\.json)$/.test(name)
  );
}
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
const statusOf = (a, b) =>
  !a ? "added" : !b ? "removed" : a === b ? "unchanged" : "changed";
export class Repository {
  constructor(
    directory,
    { python = process.env.STRATA_PYTHON || "python3", cacheDirectory } = {},
  ) {
    this.directory = path.resolve(directory);
    this.python = python;
    this.cache = new Map();
    this.buildQueue = Promise.resolve();
    this.stats = { parsed: 0, reused: 0, snapshots: 0 };
    this.index = new AnalysisIndex(cacheDirectory, hash(this.directory));
    this.parserVersion = hash(
      readFileSync(fileURLToPath(import.meta.url)) +
        readFileSync(pythonScript) +
        ts.version,
    );
    this.pythonIdentity = null;
  }
  async git(...args) {
    return command("git", ["-C", this.directory, ...args]);
  }
  async resolve(ref) {
    if (
      typeof ref !== "string" ||
      !ref ||
      ref.startsWith("-") ||
      ref.length > 200
    )
      throw new Error("Invalid Git revision");
    return (
      await this.git(
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${ref}^{commit}`,
      )
    )
      .toString()
      .trim();
  }
  async metadata() {
    const [root, branch, log] = await Promise.all([
      this.git("rev-parse", "--show-toplevel"),
      this.git("branch", "--show-current"),
      this.git(
        "log",
        "--first-parent",
        "-80",
        "--format=%H%x00%h%x00%s%x00%aI%x00%P%x00",
        "HEAD",
      ),
    ]);
    const values = log.toString().trim().split("\0");
    const commits = [];
    for (let i = 0; i + 4 < values.length; i += 5)
      commits.push({
        sha: values[i].trim(),
        short: values[i + 1],
        subject: values[i + 2],
        time: values[i + 3],
        parent: values[i + 4].split(" ")[0] || null,
      });
    return {
      name: path.basename(root.toString().trim()),
      branch: branch.toString().trim() || "detached HEAD",
      commits,
    };
  }
  async snapshot(ref) {
    const sha = await this.resolve(ref);
    if (!this.cache.has(sha)) {
      const pending = this.buildQueue
        .then(() => this.buildSnapshot(sha))
        .catch((error) => {
          this.cache.delete(sha);
          throw error;
        });
      this.buildQueue = pending.catch(() => {});
      this.cache.set(sha, pending);
      if (this.cache.size > 6)
        this.cache.delete(this.cache.keys().next().value);
    }
    return this.cache.get(sha);
  }
  metrics() {
    return { ...this.stats };
  }
  close() {
    this.index.close();
  }
  async buildSnapshot(sha) {
    this.stats.snapshots++;
    this.pythonIdentity ||= command(this.python, ["--version"]).then(
      (output) => this.python + ":" + output.toString().trim(),
      () => this.python + ":unavailable",
    );
    const pythonIdentity = await this.pythonIdentity;
    const cacheKey = (entry) =>
      this.parserVersion +
      ":" +
      (entry.path.endsWith(".py") ? pythonIdentity : "typescript") +
      ":" +
      path.extname(entry.path) +
      ":" +
      entry.oid;
    const entries = (await this.git("ls-tree", "-rlz", sha))
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t"),
          [mode, type, oid, size] = line.slice(0, tab).trim().split(/\s+/);
        return {
          path: line.slice(tab + 1),
          mode,
          type,
          oid,
          size: Number(size) || 0,
          symbols: [],
          imports: [],
          deps: [],
        };
      });
    const candidates = [];
    for (const entry of entries) {
      if (restricted(entry.path)) entry.analysis = "restricted · source hidden";
      else if (entry.mode === "120000")
        entry.analysis = "symlink · not followed";
      else if (entry.type !== "blob")
        entry.analysis = "submodule · not expanded";
      else if (entry.size > MAX_SOURCE)
        entry.analysis = "large file · source omitted";
      else candidates.push(entry);
    }
    if (candidates.length) {
      const data = await command(
        "git",
        ["-C", this.directory, "cat-file", "--batch"],
        { input: candidates.map((f) => f.oid).join("\n") + "\n" },
      );
      let offset = 0;
      const pythonFiles = [];
      for (const entry of candidates) {
        const newline = data.indexOf(10, offset);
        const size = Number(
          data.subarray(offset, newline).toString().split(" ")[2],
        );
        const raw = data.subarray(newline + 1, newline + 1 + size);
        offset = newline + size + 2;
        if (raw.includes(0)) {
          entry.analysis = "binary · source omitted";
          continue;
        }
        entry.source = raw.toString("utf8");
        if (/\.(?:py|[cm]?[jt]sx?|svelte)$/.test(entry.path)) {
          const cached = this.index.get(cacheKey(entry));
          if (cached) {
            Object.assign(entry, cached);
            this.stats.reused++;
          } else if (entry.path.endsWith(".py")) pythonFiles.push(entry);
          else {
            const analysis = jsAnalyze(entry.path, entry.source);
            this.index.set(cacheKey(entry), analysis);
            Object.assign(entry, analysis);
            this.stats.parsed++;
          }
        } else entry.analysis = "file-level analysis";
      }
      if (pythonFiles.length) {
        try {
          const results = JSON.parse(
            (
              await command(this.python, [pythonScript], {
                input: JSON.stringify(pythonFiles.map((f) => f.source)),
                timeout: 20000,
              })
            ).toString(),
          );
          pythonFiles.forEach((entry, index) => {
            this.index.set(cacheKey(entry), results[index]);
            Object.assign(entry, results[index]);
            this.stats.parsed++;
          });
        } catch (error) {
          pythonFiles.forEach((entry) => {
            entry.analysis = "Python unavailable · file-level analysis";
          });
        }
      }
    }
    this.index.flush();
    const files = Object.fromEntries(
      entries.map((entry) => [entry.path, entry]),
    );
    const pythonModules = new Map();
    for (const entry of entries.filter((f) => f.path.endsWith(".py"))) {
      const module = entry.path.replace(/\.py$/, "").replace(/\/__init__$/, "");
      const parts = module.split("/");
      for (let i = 0; i < parts.length; i++) {
        const key = parts.slice(i).join(".");
        pythonModules.set(key, [...(pythonModules.get(key) || []), entry.path]);
      }
    }
    for (const entry of entries) {
      const dependencies = new Set();
      for (const item of entry.imports) {
        let found = [];
        if (entry.path.endsWith(".py")) {
          if (item.level) {
            const folder = entry.path
              .split("/")
              .slice(0, -item.level)
              .join("/");
            const stem = path.posix.join(
              folder,
              item.specifier.replaceAll(".", "/"),
            );
            const stems = [
              stem,
              ...(item.names || [])
                .filter((n) => n !== "*")
                .map((n) => path.posix.join(stem, n)),
            ];
            found = stems
              .flatMap((s) => [s + ".py", s + "/__init__.py"])
              .filter((p) => files[p]);
          } else {
            const specs = [
              item.specifier,
              ...(item.names || []).map((n) => `${item.specifier}.${n}`),
            ];
            for (const spec of specs) {
              const options = pythonModules.get(spec) || [];
              // Resolve only unique paths; ambiguous imports stay unresolved.
              if (options.length === 1) found.push(options[0]);
            }
          }
        } else {
          let stem;
          if (item.specifier.startsWith("."))
            stem = path.posix.normalize(
              path.posix.join(path.posix.dirname(entry.path), item.specifier),
            );
          else if (item.specifier.startsWith("$lib/")) {
            const index = entry.path.indexOf("/src/");
            if (index >= 0)
              stem =
                entry.path.slice(0, index) +
                "/src/lib/" +
                item.specifier.slice(5);
          }
          if (stem) {
            const stems = [stem, stem.replace(/\.js$/, ".ts")];
            found = stems
              .flatMap((s) => [
                s,
                ...[
                  ".ts",
                  ".tsx",
                  ".js",
                  ".jsx",
                  ".mjs",
                  ".svelte",
                  "/index.ts",
                  "/index.js",
                ].map((ext) => s + ext),
              ])
              .filter((p) => files[p])
              .slice(0, 1);
          }
        }
        item.resolved = [...new Set(found)];
        for (const target of found)
          if (target !== entry.path) dependencies.add(target);
      }
      entry.deps = [...dependencies].sort();
    }
    return { sha, files };
  }
  async compare(baseRef, headRef, { view = "full", path: selectedPath } = {}) {
    const [base, head] = await Promise.all([
      this.snapshot(baseRef),
      this.snapshot(headRef),
    ]);
    const files = [
      ...new Set([...Object.keys(base.files), ...Object.keys(head.files)]),
    ]
      .filter((file) => selectedPath === undefined || file === selectedPath)
      .sort()
      .map((file) => {
        const before = base.files[file],
          after = head.files[file],
          current = after || before;
        const a = Object.fromEntries(
          (before?.symbols || []).map((s) => [s.name, s]),
        );
        const b = Object.fromEntries(
          (after?.symbols || []).map((s) => [s.name, s]),
        );
        const symbols = [
          ...new Set([...Object.keys(a), ...Object.keys(b)]),
        ].map((name) => ({
          name,
          kind: (b[name] || a[name]).kind,
          start: (b[name] || a[name]).start,
          end: (b[name] || a[name]).end,
          status: statusOf(a[name]?.hash, b[name]?.hash),
          before: a[name] ? { start: a[name].start, end: a[name].end } : null,
        }));
        return {
          path: file,
          status: statusOf(
            before && before.mode + before.oid,
            after && after.mode + after.oid,
          ),
          size: current.size,
          analysis: current.analysis,
          ...(view === "overview"
            ? {
                symbolCount: symbols.length,
                symbolPreview: symbols
                  .slice(0, 22)
                  .map((s) => ({ status: s.status })),
              }
            : { symbols }),
          deps: after?.deps || [],
          beforeDeps: before?.deps || [],
          ...(view === "overview" ? {} : { imports: current.imports }),
          readable: typeof current.source === "string",
        };
      });
    return { base: base.sha, head: head.sha, files };
  }
  async source(baseRef, headRef, file) {
    const [base, head] = await Promise.all([
      this.snapshot(baseRef),
      this.snapshot(headRef),
    ]);
    if (!base.files[file] && !head.files[file])
      throw new Error("File not present in comparison");
    const before = base.files[file],
      after = head.files[file];
    const readable = [before, after]
      .filter(Boolean)
      .every((f) => typeof f.source === "string");
    const patch = readable
      ? (
          await this.git(
            "--no-pager",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=4",
            base.sha,
            head.sha,
            "--",
            `:(literal)${file}`,
          )
        ).toString()
      : "";
    return {
      path: file,
      before: before?.source ?? null,
      after: after?.source ?? null,
      patch,
      analysis: (after || before).analysis,
      symbols: (await this.compare(base.sha, head.sha, { path: file })).files[0]
        .symbols,
      imports: (after || before).imports,
      details: {
        before: before
          ? {
              ...before.details,
              symbols: before.symbols.map((symbol) => ({
                name: symbol.name,
                ...symbol.details,
              })),
            }
          : null,
        after: after
          ? {
              ...after.details,
              symbols: after.symbols.map((symbol) => ({
                name: symbol.name,
                ...symbol.details,
              })),
            }
          : null,
      },
    };
  }
}
