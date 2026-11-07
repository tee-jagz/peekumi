/** @module Match the approved Google narration to magnified, measured native UI targets. */
import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../test-results/hermes");
const folder = path.join(root, "focused-demo");
const output = path.resolve(
  process.argv[2] || path.join(root, "native-demo-focused.mp4"),
);
await mkdir(folder, { recursive: true });
const evidence = JSON.parse(
  await readFile(path.join(root, "native-visuals.json"), "utf8"),
);
const speech = JSON.parse(
  await readFile(path.join(root, "google-demo/chapters.json"), "utf8"),
);
if (
  !evidence.nudge_received ||
  evidence.measurements.length !== 2 ||
  speech.clips.length !== 8
)
  throw Error(
    "Verified native evidence and the original eight narration chapters are required",
  );
if (
  evidence.measurements.some(
    (run) => run.test_exit !== 0 || run.export_exit !== 0,
  )
)
  throw Error("The narration requires two successful measurements");

function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (part) => (stdout += part));
    child.stderr.on("data", (part) => (stderr += part));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(stdout) : reject(Error(program + ": " + stderr)),
    );
  });
}
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const union = (rects) => {
  const x = Math.min(...rects.map((r) => r.x)),
    y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
};
function rect(view, keys) {
  return union(
    keys.map((key) => {
      if (!view.targets[key]) throw Error("Missing recorded UI target: " + key);
      return view.targets[key];
    }),
  );
}
function crop(view, keys, padding = 32, minimum = [0, 0]) {
  const area = rect(view, keys);
  const graphKeys = [
    "graph",
    "refund",
    "uiFile",
    "dbFile",
    "uiFolder",
    "dbFolder",
    "edge",
    "edgePath",
  ];
  const bounds =
    keys.every((key) => graphKeys.includes(key)) && view.targets.graph
      ? view.targets.graph
      : { x: 0, y: 0, ...view.viewport };
  const width = Math.min(
    bounds.width,
    Math.max(area.width + padding * 2, minimum[0]),
  );
  const height = Math.min(
    bounds.height,
    Math.max(area.height + padding * 2, minimum[1]),
  );
  return {
    x: Math.max(
      bounds.x,
      Math.min(
        bounds.x + bounds.width - width,
        area.x + area.width / 2 - width / 2,
      ),
    ),
    y: Math.max(
      bounds.y,
      Math.min(
        bounds.y + bounds.height - height,
        area.y + area.height / 2 - height / 2,
      ),
    ),
    width,
    height,
  };
}
const mapContext = ["uiFolder", "dbFolder", "uiFile", "dbFile", "refund"];
const imageCache = new Map();
async function dataUrl(filename) {
  if (!imageCache.has(filename))
    imageCache.set(
      filename,
      "data:image/png;base64," + (await readFile(filename)).toString("base64"),
    );
  return imageCache.get(filename);
}

// Each beat follows one spoken clause. Coordinates come from the native DOM at capture time.
const chapters = [
  [
    {
      at: 0,
      view: "findings",
      context: ["graph"],
      focus: ["graph"],
      caption: "This is the code map inside Hermes.",
      note: "Folders contain files. Files contain functions.",
    },
    {
      at: 3.0,
      view: "findings",
      context: mapContext,
      focus: ["refund", "edgePath"],
      caption: "Changed code. Dependency rules. Measured risk.",
      note: "The outlined refund node and red dependency edge are the two findings.",
    },
    {
      at: 7.0,
      kind: "service",
      view: "findings",
      caption: "A local Peekumi service supplies this analysis.",
      note: "Required setup: Peekumi service + crapper + Python coverage tools.",
    },
  ],
  [
    {
      at: 0,
      view: "added",
      context: ["code"],
      focus: ["code"],
      padding: 35,
      minimum: [750, 220],
      caption: "Hermes adds the refund function.",
      note: "A close-up of the actual code addition in Hermes.",
    },
    {
      at: 3.5,
      view: "first-measure",
      context: ["tool"],
      focus: ["tool"],
      minimum: [720, 150],
      caption: "The existing tests pass.",
      note: "Actual measurement receipt: test exit 0 · coverage export exit 0.",
    },
    {
      at: 6.0,
      view: "findings",
      context: mapContext,
      focus: ["refund"],
      caption: "Now inspect the new code on the graph.",
      note: "Passing tests do not establish that refund was exercised.",
    },
  ],
  [
    {
      at: 0,
      view: "findings",
      context: mapContext,
      focus: ["refund"],
      caption: "The changed refund node is red.",
      note: "Red risk dot + red 42 · selected function: refund().",
    },
    {
      at: 2.3,
      view: "findings",
      context: ["score", "metrics"],
      focus: ["metrics"],
      padding: 60,
      minimum: [360, 180],
      caption: "Complexity 6. Test coverage 0%.",
      note: "This is the AFTER evidence for the selected refund function.",
    },
    {
      at: 5.5,
      view: "findings",
      context: ["score", "metrics"],
      focus: ["score"],
      padding: 60,
      minimum: [360, 180],
      caption: "Risk 42 exceeds the configured limit of 30.",
      note: "Lower is better. The zero coverage makes this function risky.",
    },
  ],
  [
    {
      at: 0,
      view: "findings",
      context: mapContext,
      focus: ["edgePath"],
      caption: "The red edge is a forbidden dependency.",
      note: "shop/ui/cart.py imports shop/db/orders.py.",
    },
    {
      at: 5.9,
      view: "rule",
      context: ["rule", "import"],
      focus: ["import"],
      padding: 45,
      minimum: [500, 190],
      caption: "Select that edge: here is the rule and import.",
      note: "ui-no-db was frozen before the agent edited the code.",
    },
  ],
  [
    {
      at: 0,
      kind: "gate",
      view: "findings",
      caption: "The finish gate sends both findings back.",
      note: "Actual pre_verify feedback, excerpted from the native turn.",
    },
    {
      at: 3.1,
      view: "repair-import",
      context: ["code"],
      focus: ["code"],
      padding: 20,
      minimum: [750, 150],
      caption: "The diff shows the forbidden import being removed.",
      note: "Red diff line: from shop.db.orders import save.",
    },
    {
      at: 5.6,
      view: "repair-tests",
      context: ["code"],
      focus: ["code"],
      padding: 40,
      minimum: [750, 160],
      caption: "Hermes adds a test that calls refund.",
      note: "The new test_refunds exercises the refund branches.",
    },
    {
      at: 7.8,
      view: "repair-measure",
      context: ["tool"],
      focus: ["tool"],
      minimum: [720, 150],
      caption: "Then it runs a fresh measurement.",
      note: "A new source snapshot and coverage run verify the repair.",
    },
  ],
  [
    {
      at: 0,
      view: "passed",
      context: ["uiFolder", "uiFile", "refund"],
      focus: ["refund"],
      padding: 35,
      minimum: [400, 270],
      caption: "Back on the graph: refund is green.",
      note: "Green risk dot + score 6 · the selected refund function.",
    },
    {
      at: 2.5,
      view: "passed",
      context: ["score", "metrics"],
      focus: ["metrics", "score"],
      padding: 60,
      minimum: [360, 180],
      caption: "Coverage is 100%. Risk falls from 42 to 6.",
      note: "Complexity remains 6. The added coverage lowers the risk score.",
    },
    {
      at: 7.0,
      view: "passed",
      context: ["status", "findings"],
      focus: ["status", "findings"],
      padding: 35,
      minimum: [0, 155],
      caption: "The rule break is gone: no open findings.",
      note: "The API now returns passed.",
    },
    {
      at: 9.6,
      view: "passed",
      context: ["source", "run"],
      focus: ["source", "run"],
      padding: 55,
      minimum: [360, 170],
      caption: "These IDs identify the source and the test run.",
      note: "The outcome comes from evidence for an exact source snapshot.",
    },
  ],
  [
    {
      at: 0,
      view: "passed",
      context: ["uiFolder", "refund"],
      focus: ["refund"],
      padding: 35,
      minimum: [400, 270],
      caption: "This release measures Python risk.",
      note: "refund() is Python and has measured evidence.",
    },
    {
      at: 2.2,
      view: "unsupported",
      context: ["file"],
      focus: ["file"],
      padding: 45,
      minimum: [430, 190],
      caption: "TypeScript stays visible, with an unknown score.",
      note: "The question mark means unavailable, not zero.",
    },
    {
      at: 4.0,
      view: "unsupported",
      context: ["reason"],
      focus: ["reason"],
      padding: 50,
      minimum: [430, 160],
      caption: "The evidence panel states the limit explicitly.",
      note: "CRAP not available for this language.",
    },
  ],
  [
    {
      at: 0,
      view: "passed",
      context: ["graph"],
      focus: ["refund"],
      caption: "The graph leads.",
      note: "It shows what changed and where the risk sits.",
    },
    {
      at: 1.5,
      view: "repair-import",
      context: ["code"],
      focus: ["code"],
      padding: 20,
      minimum: [750, 150],
      caption: "The diff explains the repair.",
      note: "Inspect code only when you need the supporting detail.",
    },
    {
      at: 3.3,
      kind: "comparison",
      view: "passed",
      caption: "Fresh evidence verifies the improvement.",
      note: "The same frozen rules. A new source snapshot and measurement.",
    },
  ],
];

const stage = { width: 1216, height: 560 };
const chapterNames = [
  "Peekumi inside Hermes",
  "Add refunds, then measure",
  "Finding 1 · Refund has no test coverage",
  "Finding 2 · The UI imports the database",
  "The gate requests a repair",
  "Fresh evidence confirms the repair",
  "Unsupported risk stays unknown",
  "Verified improvement · 42 → 6",
];
async function sourcePanel(
  view,
  area,
  focus = [],
  width = stage.width,
  height = stage.height,
) {
  const scale = Math.min(width / area.width, height / area.height);
  const insetLeft = (width - area.width * scale) / 2;
  const insetTop = (height - area.height * scale) / 2;
  const left = -area.x * scale;
  const top = -area.y * scale;
  const highlights = focus
    .map((key) => {
      const target = view.targets[key];
      if (
        !target ||
        target.x < area.x - 1 ||
        target.y < area.y - 1 ||
        target.x + target.width > area.x + area.width + 1 ||
        target.y + target.height > area.y + area.height + 1
      )
        throw Error("Highlight escapes the magnified source: " + key);
      return `<div class="highlight" style="left:${left + target.x * scale - 12}px;top:${top + target.y * scale - 6}px;width:${target.width * scale + 24}px;height:${target.height * scale + 12}px"></div>`;
    })
    .join("");
  return `<div class="source-panel" style="width:${width}px;height:${height}px"><div class="crop-content" style="position:absolute;overflow:hidden;left:${insetLeft}px;top:${insetTop}px;width:${area.width * scale}px;height:${area.height * scale}px"><img class="source" src="${await dataUrl(view.image)}" style="left:${left}px;top:${top}px;width:${view.viewport.width * scale}px;height:${view.viewport.height * scale}px">${highlights}</div><div class="zoom-label">MAGNIFIED NATIVE VIEW · ${scale.toFixed(1)}×</div></div>`;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
});
const frames = [],
  cues = [];
let timeline = 0;
try {
  for (const [index, beats] of chapters.entries()) {
    const seconds = Number(
      await run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        path.join(root, "google-demo", `scene-${index}.mp4`),
      ]),
    );
    for (const [beatIndex, beat] of beats.entries()) {
      const duration = (beats[beatIndex + 1]?.at || seconds) - beat.at;
      if (duration <= 0.4) throw Error("Narration beat has no reading time");
      const view = evidence.views[beat.view];
      let area = null,
        content;
      if (beat.kind === "gate") {
        const lines = evidence.gate_feedback
          .split(/\\n|\n/)
          .filter((line) => line.startsWith("shop/"));
        if (lines.length !== 2) throw Error("Expected two real gate findings");
        content = `<div class="explanation"><div class="eyebrow">ACTUAL HERMES HOOK FEEDBACK · EXCERPT</div><h1>Hermes tries to finish → Peekumi returns 2 findings</h1>${lines.map((line, i) => `<div class="finding"><b>${i + 1}</b><span>${escape(line)}</span></div>`).join("")}<div class="instruction">Fix the findings → run peekumi_measure again</div></div>`;
      } else if (beat.kind === "service") {
        content = `<div class="explanation"><div class="eyebrow">HOW THE VIEW GETS ITS EVIDENCE</div><h1>The pane is inside Hermes.</h1><div class="connection"><div>Hermes plugin<br><small>Hooks · tools · graph pane</small></div><span>↔</span><div>Local Peekumi service<br><small>Snapshots · frozen rules · CRAP</small></div></div><p>Peekumi is a required local dependency.<br>The browser app can stay closed.</p></div>`;
      } else if (beat.kind === "comparison") {
        const before = evidence.views.findings,
          after = evidence.views.passed;
        content = `<div class="comparison"><div><h2>FIRST RUN · refund untested</h2>${await sourcePanel(before, crop(before, ["score", "metrics"], 45, [360, 220]), ["score", "metrics"], 590, 440)}</div><div><h2>SECOND RUN · refund tested</h2>${await sourcePanel(after, crop(after, ["score", "metrics"], 45, [360, 220]), ["score", "metrics"], 590, 440)}</div></div>`;
      } else {
        area = crop(
          view,
          beat.context,
          beat.padding ?? 26,
          beat.minimum || [0, 0],
        );
        content = await sourcePanel(view, area, beat.focus);
      }
      const insetWidth = 180,
        insetHeight = 126;
      const thumbScale = Math.min(
        insetWidth / view.viewport.width,
        insetHeight / view.viewport.height,
      );
      const thumbLeft = (insetWidth - view.viewport.width * thumbScale) / 2,
        thumbTop = (insetHeight - view.viewport.height * thumbScale) / 2;
      const context = `<div class="context"><div>ORIGINAL HERMES WINDOW</div><div class="thumb"><img src="${await dataUrl(view.image)}" style="left:${thumbLeft}px;top:${thumbTop}px;width:${view.viewport.width * thumbScale}px;height:${view.viewport.height * thumbScale}px">${area ? `<span style="left:${thumbLeft + area.x * thumbScale}px;top:${thumbTop + area.y * thumbScale}px;width:${area.width * thumbScale}px;height:${area.height * thumbScale}px"></span>` : ""}</div></div>`;
      await page.setContent(
        `<style>*{box-sizing:border-box}body{margin:0;background:#101827;color:#f8fafc;font-family:Arial,sans-serif}.disclosure{height:32px;padding:9px 32px;background:#080f1b;color:#b8c8df;font-size:12px}.heading{height:80px;padding:23px 32px;font-size:25px;font-weight:700;display:flex;justify-content:space-between;gap:20px}.heading small{font-size:14px;color:#96abc8;font-weight:400;padding-top:6px}.stage{margin:0 32px;width:1216px;height:560px;background:#edf2f9;border-radius:12px;overflow:hidden}.source-panel{position:relative;overflow:hidden;background:#f8fafc}.source{position:absolute;max-width:none}.highlight{position:absolute;border:4px solid #2563eb;border-radius:10px;box-shadow:0 0 0 3px #fff9;pointer-events:none}.zoom-label{position:absolute;top:12px;left:14px;background:#15366eee;color:white;border-radius:5px;padding:7px 11px;font-size:12px;letter-spacing:.5px}.caption{margin:23px 32px 0;width:970px;min-height:100px;font-size:35px;line-height:1.2;font-weight:700;letter-spacing:-.4px}.note{margin:12px 32px 0;max-width:970px;color:#bdcbe0;font-size:20px;line-height:1.35}.context{position:absolute;right:32px;top:696px;font-size:10px;letter-spacing:.5px;color:#b8c8df}.thumb{margin-top:7px;position:relative;width:180px;height:126px;background:#263348;border:1px solid #4d6385;border-radius:5px;overflow:hidden}.thumb img{position:absolute}.thumb span{position:absolute;border:2px solid #60a5fa}.explanation{height:560px;padding:38px 50px;color:#16233b;background:#f8fafc}.eyebrow{font-size:15px;color:#456082;letter-spacing:1px;font-weight:700}h1{font-size:35px;line-height:1.2;max-width:1100px;margin:22px 0 30px}.finding{display:flex;align-items:center;gap:20px;border-top:1px solid #c9d7e7;padding:18px 0;font:22px/1.5 ui-monospace,monospace}.finding b{display:grid;place-items:center;flex-shrink:0;width:40px;height:40px;border-radius:50%;background:#2563eb;color:white;font:24px Arial}.instruction{font-size:24px;color:#174a9a;font-weight:700;margin-top:20px}.connection{display:flex;align-items:center;justify-content:space-around;gap:25px;font-size:29px;font-weight:700;margin:40px 0}.connection>div{padding:26px;border:2px solid #7190bd;border-radius:12px;background:white}.connection small{font-size:20px;color:#456082;font-weight:400;line-height:2}.connection>span{font-size:45px;color:#2563eb}.explanation p{font-size:25px;line-height:1.4}.comparison{display:flex;gap:16px;padding:8px;color:#13243c}.comparison h2{font-size:22px;margin:15px 16px 17px}.comparison>div{width:590px}.comparison .zoom-label{display:none}.progress{position:absolute;left:32px;right:32px;bottom:15px;height:3px;background:#2c405f}.progress span{display:block;background:#60a5fa;height:3px}</style><div class="disclosure">EDITED NATIVE EVIDENCE · Zooms and highlights added · Scripted agent provider · Original Google TTS voice</div><div class="heading"><span>${escape(chapterNames[index])}</span><small>CHAPTER ${index + 1} / 8</small></div><div class="stage">${content}</div><div class="caption">${escape(beat.caption)}</div><div class="note">${escape(beat.note)}</div>${context}<div class="progress"><span style="width:${((index + beatIndex / beats.length) / 8) * 100}%"></span></div>`,
      );
      await page
        .locator("img")
        .evaluateAll((nodes) =>
          Promise.all(nodes.map((node) => node.decode())),
        );
      const layout = await page.locator(".caption,.note").evaluateAll((nodes) =>
        nodes.map((node) => ({
          bottom: node.getBoundingClientRect().bottom,
          right: node.getBoundingClientRect().right,
        })),
      );
      if (layout.some((item) => item.bottom > 870 || item.right > 1020))
        throw Error(
          "An explanatory caption overlaps the context inset or timeline",
        );
      const filename = path.join(
        folder,
        `chapter-${index + 1}-beat-${beatIndex + 1}.png`,
      );
      await page.screenshot({ path: filename });
      frames.push({ filename, duration });
      cues.push({
        chapter: index + 1,
        start: timeline + beat.at,
        end: timeline + beat.at + duration,
        view: beat.view,
        focus: beat.focus || [],
        crop: area,
        caption: beat.caption,
        note: beat.note,
        frame: path.basename(filename),
      });
    }
    timeline += seconds;
    console.log("Matched narration chapter " + (index + 1));
  }
} finally {
  await browser.close();
}

const voiceSource = path.join(root, "native-demo-google.mp4");
const duration = Number(
  await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    voiceSource,
  ]),
);
if (duration >= 90 || Math.abs(timeline - duration) > 0.5)
  throw Error(
    "The visual timeline must match the original narration and stay below 90 seconds",
  );
const concat = path.join(folder, "frames.ffconcat");
await writeFile(
  concat,
  "ffconcat version 1.0\n" +
    frames
      .map(
        (frame) =>
          "file '" +
          frame.filename.replaceAll("'", "'\\''") +
          "'\nduration " +
          frame.duration,
      )
      .join("\n") +
    "\nfile '" +
    frames.at(-1).filename.replaceAll("'", "'\\''") +
    "'\n",
);
await run("ffmpeg", [
  "-y",
  "-loglevel",
  "error",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  concat,
  "-i",
  voiceSource,
  "-map",
  "0:v:0",
  "-map",
  "1:a:0",
  "-t",
  String(duration),
  "-r",
  "24",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "copy",
  "-movflags",
  "+faststart",
  output,
]);
const audioHash = (file) =>
  run("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-map",
    "0:a:0",
    "-c:a",
    "copy",
    "-f",
    "hash",
    "-hash",
    "sha256",
    "-",
  ]);
const originalHash = await audioHash(voiceSource),
  focusedHash = await audioHash(output);
if (originalHash !== focusedHash)
  throw Error("The approved voice track must remain unchanged");
await run("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
await writeFile(
  path.join(folder, "cues.json"),
  JSON.stringify(
    {
      duration,
      audio_unchanged: true,
      audio_packet_hash: originalHash.trim(),
      scripted_provider: true,
      source: "Measured native element rectangles and actual gate feedback",
      cues,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Focused edit: ${duration.toFixed(1)} seconds; ${cues.length} visual cues; original Google audio unchanged. ${output}`,
);
