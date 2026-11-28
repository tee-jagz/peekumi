/** @module Pure hierarchy, dependency and diff transformations shared by the map and review panel. */
/** Creates the repository-root navigation scope. */
export const rootScope = () => ({ kind: "repo", path: "" });
/** Returns the final segment of a repository-relative path. */
export const leaf = (path) => path.split("/").at(-1);
/** Returns the parent directory path, or an empty string for a root file. */
export const parent = (path) => path.split("/").slice(0, -1).join("/");
/** Creates a stable selection key from a node kind and its path or symbol name. */
export const keyOf = (node) => `${node.kind}:${node.path || node.name || ""}`;
/** Tests whether a repository-relative file belongs to the current repository, directory, root-file group or file scope. */
export function inScope(file, scope) {
  if (scope.kind === "repo") return true;
  if (scope.kind === "rootfiles") return !file.path.includes("/");
  return file.path === scope.path || file.path.startsWith(scope.path + "/");
}
/** Aggregates file statuses for a directory; a mixture of statuses is reported as changed. */
export function rollup(files) {
  const statuses = new Set(files.map((file) => file.status));
  return statuses.size === 1 ? [...statuses][0] : "changed";
}
/** Builds the actual next directory level, or symbols when inside a file. Loose repository files share one root-file card. */
export function children(files, scope) {
  if (scope.kind === "file") {
    const file = files.find((file) => file.path === scope.path);
    return (file?.symbols || []).map((symbol) => ({
      ...symbol,
      symbolKind: symbol.kind,
      kind: "symbol",
      path: scope.path,
      key: "symbol:" + symbol.name,
    }));
  }
  const groups = new Map();
  for (const file of files.filter((file) => inScope(file, scope))) {
    const relative = scope.path
      ? file.path.slice(scope.path.length + 1)
      : file.path;
    const first = relative.split("/")[0];
    if (!relative.includes("/") && scope.kind !== "repo") {
      groups.set("file:" + file.path, {
        ...file,
        kind: "file",
        name: first,
        key: "file:" + file.path,
      });
      continue;
    }
    const kind = !relative.includes("/") ? "rootfiles" : "folder";
    const path =
      kind === "rootfiles" ? "" : (scope.path ? scope.path + "/" : "") + first;
    const key = kind + ":" + path;
    if (!groups.has(key))
      groups.set(key, {
        key,
        kind,
        path,
        name: kind === "rootfiles" ? "Repository files" : first,
        files: [],
      });
    groups.get(key).files.push(file);
  }
  return [...groups.values()]
    .map((node) =>
      node.files ? { ...node, status: rollup(node.files) } : node,
    )
    .sort(
      (a, b) =>
        (a.kind === "file") - (b.kind === "file") ||
        a.name.localeCompare(b.name),
    );
}
/** Rolls before/after file imports into visible directory or file edges, retaining external-scope neighbours and underlying file pairs. */
export function connections(files, scope, relationships = []) {
  const fileMap = new Map(files.map((file) => [file.path, file]));
  function represent(path, symbol = "") {
    if (
      scope.kind === "file" &&
      path === scope.path &&
      symbol &&
      fileMap.get(path)?.symbols?.some((s) => s.name === symbol)
    )
      return { key: "symbol:" + symbol, kind: "symbol", name: symbol, path };
    if (scope.kind === "file" && path === scope.path)
      return { key: "boundary", kind: "boundary", path, name: leaf(path) };
    if (scope.kind === "file")
      return {
        key: "stub:" + path,
        kind: "stub",
        path,
        targetKind: "file",
        name: leaf(path),
      };
    if (inScope({ path }, scope)) {
      const relative = scope.path ? path.slice(scope.path.length + 1) : path;
      if (!relative.includes("/")) {
        if (scope.kind === "repo")
          return {
            key: "rootfiles:",
            kind: "rootfiles",
            path: "",
            name: "Repository files",
          };
        return { key: "file:" + path, kind: "file", path, name: leaf(path) };
      }
      const target =
        (scope.path ? scope.path + "/" : "") + relative.split("/")[0];
      return {
        key: "folder:" + target,
        kind: "folder",
        path: target,
        name: leaf(target),
      };
    }
    const prefix = parent(scope.path);
    const target =
      prefix && path.startsWith(prefix + "/")
        ? prefix + "/" + path.slice(prefix.length + 1).split("/")[0]
        : path.split("/")[0];
    return {
      key: "stub:" + target,
      kind: "stub",
      path: target,
      targetKind: fileMap.has(target) ? "file" : "folder",
      name: leaf(target),
    };
  }
  const edges = new Map();
  const facts = [],
    importEvidence = new Map();
  for (const r of relationships)
    for (const phase of ["before", "after"]) {
      const fact = r[phase];
      if (fact?.kind !== "imports") continue;
      for (const target of fact.targets || []) {
        const key = JSON.stringify([phase, fact.source.path, target.path]);
        importEvidence.set(key, [
          ...(importEvidence.get(key) || []),
          ...(fact.violations || []),
        ]);
      }
    }

  for (const file of files)
    for (const phase of ["before", "after"])
      for (const target of file[phase === "before" ? "beforeDeps" : "deps"] ||
        []) {
        const evidence =
          importEvidence.get(JSON.stringify([phase, file.path, target])) || [];
        facts.push({
          phase,
          from: file.path,
          to: target,
          kind: "imports",
          violations: evidence,
        });
      }
  for (const relation of relationships)
    for (const phase of ["before", "after"]) {
      const r = relation[phase];
      if (!r || r.kind === "imports" || r.resolution !== "resolved") continue;
      facts.push({
        phase,
        from: r.source.path,
        to: r.targets[0].path,
        fromSymbol: r.source.symbol,
        toSymbol: r.targets[0].symbol,
        kind: r.kind,
        changed: relation.status === "changed",
        violations: r.violations || [],
      });
    }
  for (const fact of facts) {
    if (
      !inScope({ path: fact.from }, scope) &&
      !inScope({ path: fact.to }, scope)
    )
      continue;
    const from = represent(fact.from, fact.fromSymbol),
      to = represent(fact.to, fact.toSymbol);
    if (from.key === to.key) continue;
    const key = from.key + "→" + to.key + ":" + fact.kind;
    if (!edges.has(key))
      edges.set(key, {
        key,
        kind: "edge",
        relationshipKind: fact.kind,
        from,
        to,
        before: new Set(),
        after: new Set(),
        pairs: new Map(),
        violationsBefore: [],
        violationsAfter: [],
      });
    const edge = edges.get(key),
      pairKey = JSON.stringify([
        fact.from,
        fact.fromSymbol,
        fact.to,
        fact.toSymbol,
      ]);
    edge.evidenceChanged ||= !!fact.changed;
    edge[fact.phase].add(pairKey);
    edge.pairs.set(pairKey, {
      from: fact.from,
      to: fact.to,
      fromSymbol: fact.fromSymbol,
      toSymbol: fact.toSymbol,
    });
    const violations =
      edge[fact.phase === "before" ? "violationsBefore" : "violationsAfter"];
    for (const v of fact.violations)
      if (!violations.some((existing) => existing.id === v.id))
        violations.push(v);
  }
  return [...edges.values()].map((edge) => ({
    ...edge,
    status: !edge.before.size
      ? "added"
      : !edge.after.size
        ? "removed"
        : edge.evidenceChanged ||
            JSON.stringify(edge.violationsBefore) !==
              JSON.stringify(edge.violationsAfter) ||
            edge.before.size !== edge.after.size ||
            [...edge.before].some((key) => !edge.after.has(key))
          ? "changed"
          : "unchanged",
    name: edge.from.name + " → " + edge.to.name,
  }));
}
/** Hides additions on Before and removals in the After Structure view; Changes can retain removed ghosts. */
export function visibleOnSide(node, before, lens) {
  if (before) return node.status !== "added";
  return lens !== "structure" || node.status !== "removed";
}

// Keep unified-diff headers and only the hunks touching the selected symbol.
/** Filters a unified diff to hunks overlapping the selected symbol's old or new line range. Returns the full patch when no symbol is selected; unchanged symbols return an empty patch. */
export function patchForSymbol(patch, symbol) {
  if (!symbol || symbol.status === "unchanged") return symbol ? "" : patch;
  const header = [],
    hunks = [];
  let current;
  for (const line of patch.split("\n")) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match) {
      current = {
        oldStart: +match[1],
        oldCount: +(match[2] ?? 1),
        newStart: +match[3],
        newCount: +(match[4] ?? 1),
        lines: [],
      };
      hunks.push(current);
    }
    if (current) current.lines.push(line);
    else header.push(line);
  }
  const overlaps = (start, count, range) =>
    range &&
    count > 0 &&
    start <= range.end &&
    start + count - 1 >= range.start;
  const kept = hunks.filter(
    (h) =>
      overlaps(h.oldStart, h.oldCount, symbol.before) ||
      (symbol.status !== "removed" && overlaps(h.newStart, h.newCount, symbol)),
  );
  return kept.length
    ? [...header, ...kept.flatMap((h) => h.lines)].join("\n")
    : "";
}

/** Expands compact file-pair transport into the same evidence shape used by file drill-down. */
export function expandRelationships(data) {
  if (!data.compact) return data;
  return {
    ...data,
    relationships: data.pairs.map(
      ([from, to, kind, left, right, beforeViolations, afterViolations]) => {
        const fact = (count, violations) =>
          count
            ? {
                source: { path: from, symbol: "" },
                target: to,
                targets: [{ path: to, symbol: "" }],
                kind,
                resolution: "resolved",
                violations,
                count,
              }
            : null;
        const before = fact(left, beforeViolations),
          after = fact(right, afterViolations),
          current = after || before;
        return {
          ...current,
          id: JSON.stringify([from, to, kind]),
          before,
          after,
          status: !left
            ? "added"
            : !right
              ? "removed"
              : left !== right ||
                  JSON.stringify(beforeViolations) !==
                    JSON.stringify(afterViolations)
                ? "changed"
                : "unchanged",
        };
      },
    ),
  };
}

/** The outcome of one GitHub status check (an entry of `statusCheckRollup`), from its raw
 * fields only: `passed`, `failed`, `pending`, `skipped`, `neutral` or `unknown`. A CheckRun
 * has `status` and, once completed, `conclusion`; a StatusContext has `state`. Only an
 * explicit success is `passed`. */
export function checkOutcome(check) {
  const up = (v) => String(v || "").toUpperCase();
  const statusContext =
    check.__typename === "StatusContext" ||
    (!check.__typename && check.state != null && check.conclusion == null);
  if (statusContext)
    return (
      {
        SUCCESS: "passed",
        FAILURE: "failed",
        ERROR: "failed",
        PENDING: "pending",
        EXPECTED: "pending",
      }[up(check.state)] || "unknown"
    );
  const status = up(check.status);
  if (status && status !== "COMPLETED") return "pending";
  return (
    {
      SUCCESS: "passed",
      FAILURE: "failed",
      TIMED_OUT: "failed",
      CANCELLED: "failed",
      ACTION_REQUIRED: "failed",
      STARTUP_FAILURE: "failed",
      SKIPPED: "skipped",
      NEUTRAL: "neutral",
    }[up(check.conclusion)] || "unknown"
  );
}

/** The checks that GitHub reports for a PR (`statusCheckRollup`), each with its outcome, and
 * one line about all of them. `headline` says "All N reported checks passed" only when every
 * check is an explicit success; otherwise it counts each outcome. `tone` is `good`, `bad`,
 * `wait`, `open` (some checks did not pass and did not fail) or `quiet` (no checks). */
export function summarizeChecks(rollup = []) {
  const entries = rollup.map((c) => ({
    name: c.name || c.context || "Unnamed check",
    producer: c.workflowName || (c.context ? "Status" : "") || "",
    outcome: checkOutcome(c),
    raw: [c.status, c.conclusion, c.state].filter(Boolean).join(" / "),
    url: c.detailsUrl || c.targetUrl || "",
  }));
  const counts = {};
  for (const e of entries) counts[e.outcome] = (counts[e.outcome] || 0) + 1;
  const total = entries.length;
  const order = [
    "failed",
    "pending",
    "passed",
    "skipped",
    "neutral",
    "unknown",
  ];
  const parts = order
    .filter((o) => counts[o])
    .map((o) => `${counts[o]} ${o}`)
    .join(" · ");
  if (!total)
    return {
      entries,
      counts,
      total,
      headline: "No checks reported",
      tone: "quiet",
    };
  if (counts.passed === total)
    return {
      entries,
      counts,
      total,
      headline: `All ${total} reported check${total === 1 ? "" : "s"} passed`,
      tone: "good",
    };
  return {
    entries,
    counts,
    total,
    headline: parts,
    tone: counts.failed ? "bad" : counts.pending ? "wait" : "open",
  };
}

/** Classifies a repository path that can change what a check proves: `tests`, `ci`, `config`,
 * or `null`. Matches `backend/review.rs::sensitive_kind` so PR and task views agree. */
export function sensitiveKind(path = "") {
  if (path === ".peekumi.json" || path === ".strata.json") return "config";
  const parts = path.split("/");
  const name = parts.at(-1) || "";
  const folders = parts.slice(0, -1);
  if (
    path.startsWith(".github/workflows/") ||
    path.startsWith(".circleci/") ||
    path.startsWith(".buildkite/") ||
    path === ".gitlab-ci.yml" ||
    path === "azure-pipelines.yml" ||
    name === "Jenkinsfile"
  )
    return "ci";
  const dot = name.indexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : "";
  const rest = dot > 0 ? name.slice(dot + 1) : "";
  const testFolder = folders.some((f) =>
    ["test", "tests", "__tests__", "spec"].includes(f),
  );
  const testName =
    Boolean(stem) &&
    (stem.endsWith("_test") ||
      name.includes(".test.") ||
      name.includes(".spec.") ||
      (stem.startsWith("test_") && rest === "py"));
  return testFolder || testName ? "tests" : null;
}

/** Collects changed test, CI and configuration files from a comparison's file list. */
export function tamperFiles(files = []) {
  const found = { tests: [], ci: [], config: [] };
  for (const f of files) {
    if (!f || f.status === "unchanged") continue;
    const kind = sensitiveKind(f.path);
    if (kind) found[kind].push({ path: f.path, status: f.status });
  }
  return found;
}
