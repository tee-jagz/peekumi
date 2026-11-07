/** @module Explain the actual native recording with narration, evidence holds and required dependencies. */
import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { narrate, speechModel, speechVoice } from "./google-tts.mjs";

const root = path.resolve(import.meta.dirname, "../../test-results/hermes");
const output = path.resolve(
  process.argv[2] || path.join(root, "native-demo-google.mp4"),
);
const folder = path.join(root, "google-demo");
await mkdir(folder, { recursive: true });
const frames = JSON.parse(
  await readFile(path.join(root, "native-demo-frames.json"), "utf8"),
);
const events = JSON.parse(
  await readFile(path.join(root, "native-demo-events.json"), "utf8"),
);
const receipt = JSON.parse(
  await readFile(path.join(root, "native-demo-requests.json"), "utf8"),
);
if (!receipt.scripted_provider || !receipt.nudge_received)
  throw Error("A verified native gate recording is required");
const event = (name) => {
  const value = events.find((item) => item.name === name)?.time;
  if (!value) throw Error("Missing capture event: " + name);
  return value;
};
const first = frames[0].time;
const capture = (start, end) => {
  const selected = frames.filter(
    (frame) => frame.time >= start && frame.time < end,
  );
  if (!selected.length) throw Error("Empty native capture interval");
  return selected.map((frame, index) => ({
    filename: frame.filename,
    duration: Math.max(
      0.05,
      ((selected[index + 1]?.time || end) - frame.time) / 1000,
    ),
  }));
};
const still = (filename, duration) => [
  { filename: path.join(root, filename), duration },
];
const scenes = [
  {
    title: "Tests passed. Is the change ready?",
    card: true,
    seconds: 8,
    body: "Peekumi Risk Map for Hermes",
    detail:
      "Hermes plugin → local Peekumi service → graph, rules and measured risk",
    note: "Required: Peekumi service + crapper + Python coverage tools",
    voice:
      "This is Peekumi Risk Map inside Hermes. The graph shows changed code, dependency rules and measured risk. A local Peekumi service supplies the analysis.",
  },
  {
    title: "1 / Hermes adds refunds and runs the existing tests",
    detail:
      "Watch the left: code edit → peekumi_measure. Tests run in a private snapshot copy.",
    samples: capture(first, event("findings")),
    voice:
      "Hermes adds refunds and measures the change in a private copy. The existing tests pass. Now look at what the graph tells us.",
  },
  {
    title: "2 / The new function has zero test coverage",
    detail:
      "Look at AFTER: complexity 6 · coverage 0% · CRAP risk 42, above the limit of 30.",
    samples: still("native-findings.png", 10),
    voice:
      "The changed refund node is red. Select it: complexity six, zero test coverage, and a risk score of forty two. The limit is thirty. Lower is better.",
  },
  {
    title: "3 / The UI imports the database directly",
    detail:
      "Selected red edge: ui-no-db. The exact import breaks the rule saved before the edit.",
    samples: still("native-rule.png", 9),
    voice:
      "The red dependency edge explains the second problem. The interface now imports the database directly. Select the edge to see the frozen rule and the exact import.",
  },
  {
    title: "4 / The finish gate asks Hermes to repair both findings",
    detail:
      "Watch the left: the forbidden import is removed, tests are added, and measurement runs again.",
    samples: capture(event("rule evidence"), event("measured repair")),
    voice:
      "The finish gate sends both findings back to Hermes. The supporting diff shows the repair: remove the forbidden import, add refund tests, then measure again.",
  },
  {
    title: "5 / Fresh evidence confirms the repair",
    detail:
      "Coverage: 0% → 100% · CRAP: 42 → 6 · no new rule breaks. Source and run IDs identify the evidence.",
    samples: still("native-passed.png", 10),
    voice:
      "Back on the graph, refund is green. Coverage is now one hundred percent, and risk falls from forty two to six. The rule break is gone. Revision and run identifiers link the result to evidence.",
  },
  {
    title: "Unknown stays unknown",
    detail:
      "This release measures Python CRAP. TypeScript stays on the map with an explicit limit.",
    samples: still("native-unsupported.png", 6),
    voice:
      "This release measures Python risk. TypeScript remains visible, with its unsupported score clearly marked.",
  },
  {
    title: "Measured repair before Hermes finishes",
    card: true,
    seconds: 7,
    body: "42 → 6",
    detail:
      "More test coverage. The same frozen rules. Fresh source-bound evidence.",
    note: "Dependency: running Peekumi service. Review demo: scripted local provider; real tools, gate and measurements.",
    voice:
      "The graph leads. The diff explains the repair. Peekumi verifies the result before Hermes finishes.",
  },
];

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

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 1040 },
  deviceScaleFactor: 1,
});
const clips = [];
let total = 0;
try {
  for (const [index, scene] of scenes.entries()) {
    const stem = path.join(folder, "scene-" + index);
    await writeFile(stem + ".txt", scene.voice + "\n");
    const narration = await narrate(
      scene.voice,
      path.join(root, "google-tts-cache"),
    );
    const audio = Number(
      await run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        narration,
      ]),
    );
    const samples = scene.samples || [
      { filename: null, duration: scene.seconds },
    ];
    let seconds = samples.reduce((sum, sample) => sum + sample.duration, 0);
    if (seconds < audio + 0.8) {
      samples.at(-1).duration += audio + 0.8 - seconds;
      seconds = audio + 0.8;
    }
    total += seconds;
    const concat = ["ffconcat version 1.0"];
    for (const [sampleIndex, sample] of samples.entries()) {
      const png = `${stem}-${sampleIndex}.png`;
      const image = sample.filename
        ? "data:image/" +
          (sample.filename.endsWith(".png") ? "png" : "jpeg") +
          ";base64," +
          (await readFile(sample.filename)).toString("base64")
        : "";
      await page.setContent(
        `<style>*{box-sizing:border-box}body{margin:0;background:#101827;color:#f8fafc;font-family:Arial,sans-serif}.disclosure{height:32px;padding:8px 20px;font-size:13px;background:#080f1b;color:#cbd5e1}img{display:block;width:1280px;height:900px}.caption{height:108px;padding:18px 28px;background:#101827;border-top:3px solid #60a5fa}.title{font-size:26px;font-weight:700;margin-bottom:10px}.detail{font-size:19px;color:#cbd5e1}.card{height:900px;padding:130px 84px;display:flex;flex-direction:column;justify-content:center}.card .title{font-size:49px;line-height:1.15;max-width:1050px}.body{font-size:68px;font-weight:700;color:#93c5fd;margin:35px 0}.card .detail{font-size:27px;line-height:1.5;max-width:1050px}.note{font-size:21px;color:#94a3b8;margin-top:45px;line-height:1.5;max-width:1050px}</style><div class="disclosure">EDITED NATIVE DEMO · Scripted local provider · Real Hermes tools, gate, coverage and CRAP · Google TTS narration</div>${scene.card ? `<div class="card"><div class="title">${scene.title}</div><div class="body">${scene.body}</div><div class="detail">${scene.detail}</div><div class="note">${scene.note}</div></div>` : `<img src="${image}">`}<div class="caption"><div class="title">${scene.card ? "Peekumi Risk Map / Hermes Desktop" : scene.title}</div><div class="detail">${scene.card ? "Required: running Peekumi service, pinned crapper and Python coverage tools" : scene.detail}</div></div>`,
      );
      await page
        .locator("img")
        .evaluateAll((nodes) =>
          Promise.all(nodes.map((node) => node.decode())),
        );
      await page.screenshot({ path: png });
      concat.push(
        "file '" + png.replaceAll("'", "'\\''") + "'",
        "duration " + sample.duration,
      );
    }
    concat.push(concat.at(-2));
    await writeFile(stem + ".ffconcat", concat.join("\n") + "\n");
    await run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      stem + ".ffconcat",
      "-i",
      narration,
      "-t",
      String(seconds),
      "-vf",
      "fps=12,format=yuv420p",
      "-af",
      "loudnorm=I=-16:TP=-1.5:LRA=11,apad",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      stem + ".mp4",
    ]);
    clips.push({
      title: scene.title,
      seconds,
      narration: scene.voice,
      file: stem + ".mp4",
    });
    console.log(
      `Chapter ${index + 1}: ${seconds.toFixed(1)}s · ${scene.title}`,
    );
  }
} finally {
  await browser.close();
}
if (total >= 90) throw Error("Explained demo exceeds 90 seconds: " + total);
const concat = path.join(folder, "clips.ffconcat");
await writeFile(
  concat,
  "ffconcat version 1.0\n" +
    clips
      .map((clip) => "file '" + clip.file.replaceAll("'", "'\\''") + "'")
      .join("\n") +
    "\n",
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
  "-c",
  "copy",
  "-movflags",
  "+faststart",
  output,
]);
await writeFile(
  path.join(folder, "chapters.json"),
  JSON.stringify(
    {
      edited_native_capture: true,
      scripted_provider: true,
      narration_provider: "Google Gemini",
      narration_model: speechModel,
      narration_voice: speechVoice,
      estimated_seconds: total,
      clips,
    },
    null,
    2,
  ) + "\n",
);
console.log("Explained native demo: " + output);
