/** @module Edit continuous native Hermes footage with smooth camera moves and approved narration. */
import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import { benefitStory } from "./benefit-story.mjs";

const root = path.resolve(import.meta.dirname, "../../test-results/hermes");
const benefits = process.env.PEEKUMI_DEMO_STORY === "benefits";
const folder = path.join(root, benefits ? "benefit-demo" : "motion-demo");
const output = path.resolve(
  process.argv[2] ||
    path.join(
      root,
      benefits ? "native-demo-benefits.mp4" : "native-demo-motion.mp4",
    ),
);
await mkdir(folder, { recursive: true });
const recording = JSON.parse(
  await readFile(
    path.join(
      root,
      benefits
        ? "benefit-capture/recording.json"
        : "motion-capture/recording.json",
    ),
    "utf8",
  ),
);
const speech = JSON.parse(
  await readFile(
    path.join(
      root,
      benefits ? "benefit-demo/chapters.json" : "google-demo/chapters.json",
    ),
    "utf8",
  ),
);
if (
  !recording.nudge_received ||
  recording.measurements.length !== 2 ||
  recording.measurements.some(
    (run) => run.test_exit !== 0 || run.export_exit !== 0,
  )
)
  throw Error(
    "The motion edit requires two successful native measurements and real gate feedback",
  );
if (recording.frames.length < 160)
  throw Error("A continuous native motion capture is required");
function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(stdout) : reject(Error(program + ": " + stderr)),
    );
  });
}
const escape = (text) =>
  String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const center = (box) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});
const sourceSize = JSON.parse(
  await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    recording.frames[0].filename,
  ]),
).streams[0];
const pixelScale = sourceSize.width / recording.viewport.width;
if (Math.abs(sourceSize.height / recording.viewport.height - pixelScale) > 0.01)
  throw Error("Native capture aspect ratio changed");
const full = { x: 800, y: 500, z: 1 };
const key = (at, z, box) => ({ at, z, ...center(box) });
// Camera moves are editorial. Every source frame comes from the native recording.
const technicalScenes = [
  {
    id: "intro",
    title: "Peekumi Risk Map inside Hermes",
    detail:
      "The graph leads. A local Peekumi service supplies the rules and measured risk.",
    camera: (t, s) => [
      { at: 0, ...full },
      key(2, 1.35, t.graph),
      key(s - 1, 1.4, t.graph),
      { at: s, ...full },
    ],
  },
  {
    id: "add",
    title: "Hermes adds refunds and measures the change",
    detail:
      "Actual code edits and tool calls. Tests run in a private snapshot copy.",
    camera: (t, s) => [
      { at: 0, ...full },
      { at: 1.2, z: 1.55, x: 410, y: 400 },
      { at: s - 1, z: 1.55, x: 410, y: 560 },
      { at: s, ...full },
    ],
  },
  {
    id: "risk",
    title: "Select refund: complexity 6 · coverage 0% · risk 42",
    detail: "The new function is untested. The configured risk limit is 30.",
    camera: (t, s) => [
      { at: 0, ...full },
      key(1.2, 1.6, t.refund),
      key(3.7, 2.05, t.metrics),
      key(s - 1, 2.05, t.score),
      { at: s, ...full },
    ],
  },
  {
    id: "rule",
    title: "Select the red edge to inspect the rule break",
    detail:
      "UI → database is forbidden. The inspector shows ui-no-db and the exact import.",
    camera: (t, s) => [
      { at: 0, ...full },
      key(1.3, 1.7, t.edge),
      key(6.3, 1.9, t.import),
      key(s - 0.7, 1.9, t.import),
      { at: s, ...full },
    ],
  },
  {
    id: "repair",
    title: "The gate sends both findings back to Hermes",
    detail:
      "Watch the actual repair: remove the import, add refund tests, measure again.",
    camera: (t, s) => [
      { at: 0, ...full },
      { at: 1, z: 1.55, x: 420, y: 420 },
      { at: s - 1, z: 1.55, x: 420, y: 650 },
      { at: s, ...full },
    ],
  },
  {
    id: "verify",
    title: "Fresh evidence: coverage 100% · risk 42 → 6",
    detail:
      "The graph is green. No open findings. Source and run IDs identify the evidence.",
    camera: (t, s) => [
      { at: 0, ...full },
      key(1.2, 1.6, t.refund),
      key(4, 2, t.metrics),
      key(8.2, 1.45, t.status),
      key(10.3, 1.9, t.source),
      { at: s, ...full },
    ],
  },
  {
    id: "unknown",
    title: "Unsupported risk stays unknown",
    detail:
      "Select the TypeScript file. Its unsupported score is explicit, with a reason.",
    camera: (t, s) => [
      { at: 0, ...full },
      key(1.2, 1.65, t.file),
      key(3.7, 1.9, t.reason),
      { at: s, ...full },
    ],
  },
  {
    id: "close",
    title: "The graph leads. The diff explains. Evidence verifies.",
    detail:
      "Measured improvement: CRAP 42 → 6. Real tools and tests; scripted agent provider.",
    camera: (t, s) => [
      { at: 0, ...full },
      key(2, 1.3, t.graph),
      { at: s, ...full },
    ],
  },
];
const scenes = benefits
  ? benefitStory.map((scene) => {
      const original = technicalScenes.find((item) => item.id === scene.id);
      if (scene.id === "overview")
        return {
          ...scene,
          camera: (t, seconds) => [
            { at: 0, ...full },
            key(1.5, 1.45, t.graph),
            key(seconds - 1, 1.6, t.file),
            { at: seconds, ...full },
          ],
        };
      if (scene.id === "drill")
        return {
          ...scene,
          camera: (t, seconds) => [
            { at: 0, ...full },
            key(1.1, 1.6, t.file),
            key(3.2, 1.8, t.refund),
            { at: seconds - 1.8, z: 1.55, x: 350, y: 350, region: "diff" },
            { at: seconds, ...full },
          ],
        };
      if (scene.id === "verify")
        return {
          ...scene,
          camera: (t, seconds) => [
            { at: 0, ...full },
            key(1, 1.6, t.refund),
            key(2.3, 2, t.metrics),
            key(seconds - 2.1, 2, t.metrics),
            key(seconds - 0.9, 1.45, t.status),
            { at: seconds, ...full },
          ],
        };
      return {
        ...original,
        ...scene,
        camera: (t, seconds) => {
          const reference = {
            intro: 9.92,
            rule: 10.67,
            repair: 10.04,
            verify: 13.92,
            close: 7,
          }[scene.id];
          return original.camera(t, reference).map((point) => ({
            ...point,
            at: (point.at * seconds) / reference,
          }));
        },
      };
    })
  : technicalScenes;
// Smoothstep interpolation avoids abrupt camera starts and stops.
function curve(points, property) {
  let expression = String(points.at(-1)[property]);
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i],
      b = points[i + 1];
    const u = `((on/25-${a.at})/${b.at - a.at})`;
    const smooth = `(${u}*${u}*(3-2*${u}))`;
    expression = `if(lt(on/25,${b.at}),${a[property]}+(${b[property] - a[property]})*${smooth},${expression})`;
  }
  return expression;
}
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const clips = [],
  proof = [];
let timeline = 0;
try {
  for (const [index, scene] of scenes.entries()) {
    const captured = recording.chapters.find(
      (chapter) => chapter.id === scene.id,
    );
    if (!captured) throw Error("Missing native motion chapter: " + scene.id);
    const seconds = benefits
      ? speech.clips[index].seconds
      : Number(
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
    const previous = recording.frames.findLast(
      (frame) => frame.time <= captured.start,
    );
    const frames = [
      ...(previous ? [previous] : []),
      ...recording.frames.filter(
        (frame) => frame.time > captured.start && frame.time < captured.end,
      ),
    ];
    const unique = new Set(
      await Promise.all(
        frames.map(async (frame) =>
          createHash("sha256")
            .update(await readFile(frame.filename))
            .digest("hex"),
        ),
      ),
    );
    if (frames.length < 8 || unique.size < 8)
      throw Error("The chapter must contain real native motion: " + scene.id);
    const sourceSeconds = (captured.end - captured.start) / 1000;
    const list = ["ffconcat version 1.0"];
    for (const [i, frame] of frames.entries()) {
      const start = Math.max(captured.start, frame.time),
        end = frames[i + 1]?.time || captured.end;
      list.push(
        "file '" + frame.filename.replaceAll("'", "'\\''") + "'",
        "duration " + Math.max(0.001, (end - start) / 1000),
      );
    }
    list.push("file '" + frames.at(-1).filename.replaceAll("'", "'\\''") + "'");
    const concat = path.join(folder, scene.id + ".ffconcat");
    await writeFile(concat, list.join("\n") + "\n");
    await page.setContent(
      `<style>*{box-sizing:border-box}body{margin:0;background:#101827;color:white;font-family:Arial,sans-serif}.top{height:28px;padding:7px 18px;font-size:12px;color:#c7d5e8;background:#080f1b}.bottom{position:absolute;top:828px;height:72px;width:1280px;padding:9px 22px;border-top:2px solid #60a5fa}.title{font-size:23px;font-weight:700;white-space:nowrap}.detail{font-size:16px;color:#cbd5e1;margin-top:6px;white-space:nowrap}</style><div class="top">NATIVE HERMES RECORDING · Scripted provider · Time edited · Camera and cursor annotations · ${benefits ? "Google TTS · Charon" : "Original Google voice"}</div><div class="bottom"><div class="title">${escape(scene.title)}</div><div class="detail">${escape(scene.detail)}</div></div>`,
    );
    if (
      await page
        .locator(".title,.detail")
        .evaluateAll((nodes) =>
          nodes.some((node) => node.scrollWidth > node.clientWidth),
        )
    )
      throw Error("Motion caption overflows");
    const top = path.join(folder, "header.png"),
      bottom = path.join(folder, scene.id + "-caption.png");
    await page.screenshot({
      path: top,
      clip: { x: 0, y: 0, width: 1280, height: 28 },
    });
    await page.screenshot({
      path: bottom,
      clip: { x: 0, y: 828, width: 1280, height: 72 },
    });
    const graph = recording.chapters.find((chapter) => chapter.id === "intro")
      .targets.graph;
    const points = scene.camera(captured.targets, seconds).map((point) => {
      // Keep evidence close-ups centred on the pane instead of the neighbouring chat.
      if (
        !["add", "repair"].includes(scene.id) &&
        point.region !== "diff" &&
        point.z > 1
      ) {
        const width = recording.viewport.width / point.z;
        point.x =
          width >= graph.width
            ? graph.x + graph.width / 2
            : Math.max(
                graph.x + width / 2,
                Math.min(graph.x + graph.width - width / 2, point.x),
              );
      }
      return { ...point, x: point.x * pixelScale, y: point.y * pixelScale };
    });
    const zoom = curve(points, "z"),
      x = curve(points, "x"),
      y = curve(points, "y");
    const camera = `zoompan=z='${zoom}':x='max(0,min(iw-iw/zoom,(${x})-iw/zoom/2))':y='max(0,min(ih-ih/zoom,(${y})-ih/zoom/2))':d=1:s=1280x800:fps=25`;
    const clip = path.join(folder, scene.id + ".mp4");
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
      top,
      "-i",
      bottom,
      "-filter_complex",
      `[0:v]setpts=(PTS-STARTPTS)*${seconds / sourceSeconds},fps=25,scale=in_range=auto:out_range=tv,${camera},pad=1280:900:0:28:color=0x101827[v];[v][1:v]overlay=0:0[h];[h][2:v]overlay=0:828`,
      "-t",
      String(seconds),
      "-r",
      "25",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "19",
      "-pix_fmt",
      "yuv420p",
      "-color_range",
      "tv",
      "-movflags",
      "+faststart",
      clip,
    ]);
    await run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-ss",
      String(seconds / 2),
      "-i",
      clip,
      "-frames:v",
      "1",
      path.join(folder, scene.id + "-preview.png"),
    ]);
    clips.push(clip);
    proof.push({
      id: scene.id,
      start: timeline,
      seconds,
      native_frames: frames.length,
      distinct_native_frames: unique.size,
      source_seconds: sourceSeconds,
      camera: points,
    });
    timeline += seconds;
    console.log(
      `Motion chapter ${scene.id}: ${frames.length} native frames → ${seconds.toFixed(2)}s`,
    );
  }
} finally {
  await browser.close();
}
const list = path.join(folder, "clips.ffconcat");
await writeFile(
  list,
  "ffconcat version 1.0\n" +
    clips
      .map((file) => "file '" + file.replaceAll("'", "'\\''") + "'")
      .join("\n") +
    "\n",
);
const voice = benefits
  ? speech.audio
  : path.join(root, "native-demo-google.mp4");
const duration = Number(
  await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    voice,
  ]),
);
if (duration >= 90 || Math.abs(timeline - duration) > 0.5)
  throw Error("Motion timeline must match approved narration under 90 seconds");
await run("ffmpeg", [
  "-y",
  "-v",
  "error",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  list,
  "-i",
  voice,
  "-map",
  "0:v:0",
  "-map",
  "1:a:0",
  "-t",
  String(duration),
  "-c",
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
const original = await audioHash(voice),
  edited = await audioHash(output);
if (original !== edited)
  throw Error(
    "The narration source audio must remain unchanged during video editing",
  );
await run("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
await writeFile(
  path.join(folder, "verification.json"),
  JSON.stringify(
    {
      duration,
      story: benefits ? "benefits" : "technical",
      narration_provider: "Google Gemini",
      narration_voice: "Charon",
      audio_unchanged: true,
      audio_packet_hash: original.trim(),
      source:
        "Continuous native Hermes screencast with actual user selections, edits and tool updates",
      native_frames: recording.frames.length,
      scripted_provider: true,
      nudge_received: recording.nudge_received,
      measurements: recording.measurements,
      chapters: proof,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Native motion demo: ${duration.toFixed(1)} seconds; ${recording.frames.length} source frames; Google narration copied unchanged. ${output}`,
);
