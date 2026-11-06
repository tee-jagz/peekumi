/** @module Native Hermes pane for revision-bound Peekumi risk evidence. Uses only the public SDK. */
import React, { useEffect, useMemo, useState } from "react";
import { host, useValue, Button, EmptyState } from "@hermes/plugin-sdk";

const h = React.createElement;
const colors = {
  passed: "var(--ui-green)",
  findings: "var(--ui-red)",
  exhausted: "var(--ui-red)",
  exception: "var(--ui-yellow)",
  incomplete: "var(--ui-text-tertiary)",
  unavailable: "var(--ui-text-tertiary)",
};
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
const short = (value) => (value ? value.slice(0, 10) : "unknown");
const riskColor = (value, threshold) =>
  value == null
    ? colors.incomplete
    : value > threshold
      ? colors.findings
      : value > threshold / 2
        ? colors.exception
        : colors.passed;

/** Use real folders as layout lanes. Every symbol stays attached to its source file. */
function layout(data) {
  const nodes = data.nodes || [];
  const files = nodes.filter((n) => n.kind === "file");
  const folderOf = (n) =>
    n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : ".";
  const groups = [...new Set(files.map(folderOf))].sort((a, b) => {
    const changed = (folder) =>
      files.some((n) => folderOf(n) === folder && n.changed);
    return (
      Number(changed(b)) - Number(changed(a)) ||
      b.split("/").length - a.split("/").length ||
      a.localeCompare(b)
    );
  });
  const positions = new Map();
  const lanes = groups.map((path, index) => {
    const x = 28 + index * 230;
    let y = 82;
    const entries = [];
    for (const file of files.filter(
      (n) =>
        (n.path.includes("/")
          ? n.path.slice(0, n.path.lastIndexOf("/"))
          : ".") === path,
    )) {
      // The map keeps empty package files; the pane gives them the same compact row as other files.
      positions.set(file.id, { x, y, width: 202, height: 40 });
      entries.push(file);
      y += 52;
      for (const symbol of nodes.filter((n) => n.parent === file.id)) {
        positions.set(symbol.id, { x: x + 12, y, width: 190, height: 35 });
        entries.push(symbol);
        y += 43;
      }
      y += 14;
    }
    return { path, x, height: y + 12, entries };
  });
  return {
    lanes,
    positions,
    width: Math.max(520, groups.length * 230 + 36),
    height: Math.max(300, ...lanes.map((lane) => lane.height)),
  };
}

function Evidence({ label, value }) {
  return h(
    "div",
    { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 11 } },
    h(
      "span",
      { style: { color: "var(--ui-text-tertiary)", minWidth: 62 } },
      label,
    ),
    h("span", { title: value || "No evidence", style: mono }, short(value)),
  );
}

function Score({ title, value }) {
  if (!value || value.state !== "measured")
    return h(
      "div",
      { style: { flex: 1, minWidth: 0 } },
      h(
        "div",
        {
          style: {
            fontSize: 10,
            color: "var(--ui-text-tertiary)",
            marginBottom: 6,
          },
        },
        title,
      ),
      h(
        "div",
        { style: { fontSize: 20, fontWeight: 600 } },
        value?.state || "unknown",
      ),
      value?.reason &&
        h(
          "div",
          {
            style: {
              fontSize: 11,
              marginTop: 5,
              color: "var(--ui-text-tertiary)",
            },
          },
          value.reason,
        ),
    );
  return h(
    "div",
    { style: { flex: 1, minWidth: 0 } },
    h(
      "div",
      {
        style: {
          fontSize: 10,
          color: "var(--ui-text-tertiary)",
          marginBottom: 6,
        },
      },
      title,
    ),
    h(
      "div",
      { style: { fontSize: 27, fontWeight: 650, letterSpacing: -1 } },
      value.crap,
    ),
    h(
      "div",
      {
        style: {
          fontSize: 11,
          color: "var(--ui-text-secondary)",
          margin: "3px 0 9px",
        },
      },
      `CC ${value.complexity} · coverage ${value.coverage}%`,
    ),
    h(Evidence, { label: "Source", value: value.snapshot }),
    h(Evidence, { label: "Run", value: value.run_id }),
    h(Evidence, { label: "Report", value: value.report_hash }),
  );
}

/** Draw bundled SVG from API nodes. No embedding or access to host markup is used. */
function Graph({ data, selected, select, zoom }) {
  const graph = useMemo(() => layout(data), [data]);
  return h(
    "div",
    {
      style: {
        overflow: "auto",
        flex: 1,
        minHeight: 180,
        position: "relative",
        borderTop: "1px solid var(--ui-stroke-secondary)",
        borderBottom: "1px solid var(--ui-stroke-secondary)",
      },
    },
    h(
      "svg",
      {
        role: "img",
        "aria-label": "Repository dependency map",
        width: graph.width * zoom,
        height: graph.height * zoom,
        viewBox: `0 0 ${graph.width} ${graph.height}`,
        style: { display: "block", minWidth: "100%" },
      },
      h(
        "defs",
        null,
        h(
          "pattern",
          {
            id: "peekumi-grid",
            width: 18,
            height: 18,
            patternUnits: "userSpaceOnUse",
          },
          h("circle", {
            cx: 1,
            cy: 1,
            r: 0.65,
            fill: "var(--ui-stroke-secondary)",
          }),
        ),
      ),
      h("rect", { width: "100%", height: "100%", fill: "url(#peekumi-grid)" }),
      graph.lanes.map((lane) =>
        h(
          "g",
          { key: lane.path },
          h("rect", {
            x: lane.x - 9,
            y: 22,
            width: 220,
            height: lane.height - 8,
            rx: 12,
            fill: "var(--ui-bg-chrome)",
            fillOpacity: 0.45,
            stroke: "var(--ui-stroke-secondary)",
          }),
          h(
            "text",
            {
              x: lane.x + 3,
              y: 51,
              fill: "var(--ui-text-secondary)",
              style: { ...mono, fontSize: 12 },
            },
            lane.path,
          ),
        ),
      ),
      [...(data.edges || [])]
        .sort(
          (a, b) =>
            Number(Boolean(a.rule_break)) - Number(Boolean(b.rule_break)),
        )
        .map((edge) => {
          const source = graph.positions.get(edge.source);
          const target = graph.positions.get(edge.target);
          if (!source || edge.kind !== "imports") return null;
          const broken = edge.rule_break;
          if (!target)
            return h(
              "text",
              {
                key: edge.id,
                x: source.x + 8,
                y: source.y - 5,
                fill: colors.incomplete,
                fontSize: 9,
              },
              `unresolved: ${String(edge.label || "target").slice(0, 30)}`,
            );
          const forward = target.x >= source.x;
          const a = {
            x: source.x + (forward ? source.width : 0),
            y: source.y + 20,
          };
          const b = {
            x: target.x + (forward ? 0 : target.width),
            y: target.y + 20,
          };
          const direction = forward ? 1 : -1;
          const corridor = Math.min(a.y, b.y) - 33;
          const path = `M ${a.x} ${a.y} C ${a.x + direction * 12} ${a.y}, ${a.x + direction * 12} ${corridor}, ${a.x + direction * 30} ${corridor} L ${b.x - direction * 30} ${corridor} C ${b.x - direction * 12} ${corridor}, ${b.x - direction * 12} ${b.y}, ${b.x} ${b.y}`;
          return h(
            "g",
            {
              key: edge.id,
              role: broken ? undefined : "button",
              tabIndex: broken ? undefined : 0,
              "aria-label": broken
                ? undefined
                : `${edge.source} depends on ${edge.target}`,
              onClick: () => select({ ...edge, kind: "edge" }),
              onKeyDown: (event) => {
                if (event.key === "Enter") select({ ...edge, kind: "edge" });
              },
              style: { cursor: "pointer" },
            },
            h("path", {
              d: path,
              fill: "none",
              stroke: "transparent",
              strokeWidth: 14,
            }),
            h("path", {
              d: path,
              fill: "none",
              stroke: broken ? colors.findings : "var(--ui-accent)",
              strokeWidth: broken ? 2.5 : 1.25,
              opacity: broken ? 1 : 0.48,
              strokeDasharray: broken ? "6 5" : undefined,
            }),
            h("circle", {
              cx: b.x,
              cy: b.y,
              r: broken ? 3.5 : 2,
              fill: broken ? colors.findings : "var(--ui-accent)",
            }),
            broken &&
              h(
                "g",
                {
                  role: "button",
                  tabIndex: 0,
                  "aria-label": `Rule ${broken.rule} at line ${broken.line}`,
                  onClick: () => select({ ...edge, kind: "edge" }),
                  onKeyDown: (event) => {
                    if (event.key === "Enter")
                      select({ ...edge, kind: "edge" });
                  },
                },
                h("circle", {
                  cx: (a.x + b.x) / 2,
                  cy: corridor,
                  r: 7,
                  fill: "var(--ui-bg-chrome)",
                  stroke: colors.findings,
                  strokeWidth: 1.5,
                }),
                h(
                  "text",
                  {
                    x: (a.x + b.x) / 2,
                    y: corridor + 3,
                    textAnchor: "middle",
                    fontSize: 9,
                    fill: colors.findings,
                  },
                  "!",
                ),
              ),
          );
        }),
      graph.lanes.flatMap((lane) =>
        lane.entries.map((node) => {
          const p = graph.positions.get(node.id);
          const color = riskColor(node.crap, data.threshold || 30);
          const symbol = node.kind === "symbol";
          const active = selected?.id === node.id;
          const label =
            node.name.length > 22 ? node.name.slice(0, 21) + "…" : node.name;
          const annotation =
            !symbol &&
            (node.analysis?.includes("restricted")
              ? "restricted · source hidden"
              : !node.path.endsWith(".py")
                ? "CRAP not available"
                : node.analysis?.includes("symlink")
                  ? "symlink · not followed"
                  : "");
          return h(
            "g",
            {
              key: node.id,
              role: "button",
              tabIndex: 0,
              "aria-label": `${node.path}${symbol ? "::" + node.name : ""}`,
              onClick: () => select(node),
              onKeyDown: (event) => {
                if (event.key === "Enter") select(node);
              },
              style: { cursor: "pointer" },
            },
            h("rect", {
              ...p,
              rx: symbol ? 7 : 9,
              fill: "var(--ui-bg-chrome)",
              stroke: active
                ? "var(--ui-text-primary)"
                : node.changed
                  ? color
                  : "var(--ui-stroke-secondary)",
              strokeWidth: active || node.changed ? 1.8 : 1,
            }),
            h("circle", {
              cx: p.x + 13,
              cy: p.y + p.height / 2,
              r: symbol ? 3 : 4,
              fill: color,
            }),
            h(
              "title",
              null,
              node.path + " · " + (node.reason || node.analysis || ""),
            ),
            h(
              "text",
              {
                x: p.x + 25,
                y: p.y + p.height / 2 + (annotation ? -2 : 4),
                fill: "var(--ui-text-primary)",
                style: {
                  ...mono,
                  fontSize: symbol ? 10.5 : 11,
                  fontWeight: symbol ? 400 : 600,
                },
              },
              label,
            ),
            annotation &&
              h(
                "text",
                {
                  x: p.x + 25,
                  y: p.y + 33,
                  fill: colors.incomplete,
                  fontSize: 8,
                },
                annotation,
              ),
            h(
              "text",
              {
                x: p.x + p.width - 10,
                y: p.y + p.height / 2 + 4,
                textAnchor: "end",
                fill: color,
                style: { ...mono, fontSize: 10 },
              },
              node.crap == null ? "?" : node.crap,
            ),
          );
        }),
      ),
    ),
  );
}

function Inspector({ node, data }) {
  if (!node)
    return h(EmptyState, {
      title: "Inspect the evidence",
      description:
        "Select a declaration for scores, or a red edge for the rule and import line.",
      className: "min-h-32",
    });
  if (node.kind === "edge")
    return h(
      "div",
      { style: { padding: "17px 20px" } },
      h(
        "div",
        { style: { fontSize: 11, color: colors.findings, marginBottom: 7 } },
        node.rule_break ? "FROZEN RULE EVIDENCE" : "DEPENDENCY",
      ),
      h(
        "div",
        { style: { fontWeight: 600, fontSize: 15 } },
        node.rule_break?.rule || node.kind,
      ),
      h(
        "p",
        { style: { fontSize: 12, color: "var(--ui-text-secondary)" } },
        node.rule_break?.message || `${node.source} → ${node.target}`,
      ),
      node.rule_break &&
        h(
          "pre",
          {
            style: {
              ...mono,
              fontSize: 12,
              whiteSpace: "pre-wrap",
              color: colors.findings,
            },
          },
          `${node.rule_break.source.path}:${node.rule_break.line}\n${node.rule_break.import_line}`,
        ),
    );
  const functions = node.kind === "symbol" ? [node] : node.functions || [];
  return h(
    "div",
    {
      style: {
        padding: "17px 20px",
        minHeight: 200,
        flexShrink: 0,
        maxHeight: 265,
        overflow: "auto",
      },
    },
    h(
      "div",
      {
        style: {
          fontSize: 10,
          letterSpacing: 1.3,
          color: "var(--ui-text-tertiary)",
          marginBottom: 8,
        },
      },
      "DECLARATION EVIDENCE",
    ),
    h(
      "div",
      {
        style: {
          ...mono,
          fontSize: 12,
          overflowWrap: "anywhere",
          marginBottom: 14,
        },
      },
      node.path + (node.kind === "symbol" ? "::" + node.name : ""),
    ),
    !functions.length &&
      h(
        "div",
        { style: { fontSize: 12, color: "var(--ui-text-tertiary)" } },
        node.reason || node.analysis || "No function declarations",
      ),
    functions.map((fn) =>
      h(
        "div",
        { key: fn.id, style: { marginBottom: 16 } },
        node.kind !== "symbol" &&
          h(
            "div",
            { style: { ...mono, fontSize: 12, marginBottom: 10 } },
            fn.name,
          ),
        h(
          "div",
          { style: { display: "flex", gap: 25 } },
          h(Score, { title: "BEFORE", value: fn.before }),
          h(Score, { title: "AFTER", value: fn.after }),
        ),
      ),
    ),
    (data.findings || [])
      .filter(
        (f) =>
          f.exception && (f.path === node.path || f.source?.path === node.path),
      )
      .map((finding) =>
        h(
          "p",
          { key: finding.id, style: { color: colors.exception, fontSize: 12 } },
          `Exception: ${finding.exception}`,
        ),
      ),
  );
}

export function RiskPane({ ctx }) {
  const focused = useValue(
    host.state.focusedStoredSessionId || host.state.activeSessionId,
  );
  const active = useValue(host.state.activeSessionId);
  const session = focused || active;
  const profile = useValue(host.state.profile);
  const [data, setData] = useState({
    status: "unavailable",
    limits: ["Waiting for a pre-edit baseline"],
  });
  const [selected, select] = useState(null);
  const [zoom, setZoom] = useState(0.9);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    setData({
      status: "unavailable",
      limits: [
        session ? "Loading evidence" : "Select a registered repository session",
      ],
    });
    select(null);
    const load = async () => {
      if (!session) return;
      try {
        const result = await ctx.rest(
          "/map?session_id=" + encodeURIComponent(session),
        );
        if (alive) {
          setData(result);
          select((old) => result.nodes?.find((n) => n.id === old?.id) || null);
        }
      } catch {
        if (alive)
          setData({
            status: "unavailable",
            limits: ["Peekumi did not answer"],
          });
      }
    };
    load();
    const timer = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [ctx, session, profile, refresh]);
  const status = colors[data.status] ? data.status : "unavailable";
  return h(
    "section",
    {
      "aria-label": "Peekumi Risk Map",
      style: {
        color: "var(--ui-text-primary)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 500,
        overflowY: "auto",
        fontFamily: "inherit",
      },
    },
    h(
      "header",
      { style: { padding: "20px 20px 15px" } },
      h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 13,
          },
        },
        h(
          "div",
          {
            style: {
              fontSize: 10,
              letterSpacing: 2,
              color: "var(--ui-text-tertiary)",
            },
          },
          "PEEKUMI / RISK MAP",
        ),
        h(
          Button,
          {
            variant: "ghost",
            size: "sm",
            onClick: () => setRefresh((n) => n + 1),
            "aria-label": "Refresh evidence",
          },
          "Refresh",
        ),
      ),
      h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: 9,
            marginBottom: 6,
          },
        },
        h("span", {
          style: {
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: colors[status],
          },
        }),
        h(
          "strong",
          {
            style: {
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: -0.5,
              color: colors[status],
            },
          },
          status,
        ),
        h(
          "span",
          {
            style: {
              marginLeft: "auto",
              fontSize: 11,
              color: "var(--ui-text-tertiary)",
            },
          },
          `${data.findings?.length || 0} open finding${data.findings?.length === 1 ? "" : "s"}`,
        ),
      ),
      h(
        "div",
        {
          style: {
            fontSize: 12,
            color: "var(--ui-text-secondary)",
            marginBottom: 15,
          },
        },
        status === "exhausted"
          ? "The agent stopped with findings still open."
          : "Frozen rules. Measured risk. Exact revisions.",
      ),
      h(
        "div",
        { style: { display: "flex", flexWrap: "wrap", gap: "6px 25px" } },
        h(Evidence, { label: "Baseline", value: data.baseline_sha }),
        h(Evidence, { label: "Snapshot", value: data.snapshot_sha }),
        h(Evidence, { label: "Coverage", value: data.coverage_sha }),
      ),
    ),
    h(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "7px 20px",
          fontSize: 10,
          color: "var(--ui-text-tertiary)",
        },
      },
      h("span", null, "● outlined = changed"),
      h("span", { style: { color: colors.findings } }, "- - rule break"),
      h("span", null, "? unknown"),
      h("span", { style: { marginLeft: "auto" } }, "CRAP"),
      h(
        Button,
        {
          variant: "ghost",
          size: "sm",
          "aria-label": "Zoom out",
          onClick: () => setZoom((z) => Math.max(0.5, z - 0.1)),
        },
        "−",
      ),
      h(
        Button,
        {
          variant: "ghost",
          size: "sm",
          "aria-label": "Zoom in",
          onClick: () => setZoom((z) => Math.min(1.8, z + 0.1)),
        },
        "+",
      ),
    ),
    data.nodes?.length
      ? h(Graph, { data, selected, select, zoom })
      : h(EmptyState, {
          title: status,
          description: data.limits?.[0] || "No map evidence",
        }),
    h(Inspector, {
      node:
        selected ||
        data.nodes?.find(
          (n) =>
            n.kind === "symbol" && n.changed && n.crap > (data.threshold || 30),
        ),
      data,
    }),
    h(
      "footer",
      {
        style: {
          padding: "10px 20px 14px",
          borderTop: "1px solid var(--ui-stroke-secondary)",
          fontSize: 10,
          color: "var(--ui-text-tertiary)",
          maxHeight: 85,
          overflow: "auto",
        },
      },
      (data.limits || []).map((limit, index) =>
        h("div", { key: index, style: { paddingBottom: 4 } }, String(limit)),
      ),
      data.peekumi_url &&
        h(
          "a",
          {
            href: data.peekumi_url,
            target: "_blank",
            rel: "noreferrer",
            style: { color: "var(--ui-accent)" },
          },
          "Open in Peekumi ↗",
        ),
    ),
  );
}

export default {
  id: "peekumi-risk-map",
  name: "Peekumi Risk Map",
  register(ctx) {
    ctx.register({
      id: "risk-map",
      area: "panes",
      title: "Risk Map",
      data: { placement: "right", width: "460px" },
      render: () => h(RiskPane, { ctx }),
    });
  },
};
