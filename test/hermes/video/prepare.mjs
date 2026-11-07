/** @module Prepare source footage, yt-dlp intake and exact existing Google narration timings. */
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import path from "node:path";
import { run } from "./run.mjs";
const root = path.resolve(import.meta.dirname, "../../../test-results/hermes");
const folder = path.join(root, "framework-demo"),
  publicDir = path.join(folder, "public");
await mkdir(publicDir, { recursive: true });
const capture = JSON.parse(
  await readFile(path.join(folder, "capture.json"), "utf8"),
);
const voice = JSON.parse(
  await readFile(path.join(root, "benefit-demo/chapters.json"), "utf8"),
);
if (
  !capture.nudge_received ||
  capture.measurements.length !== 2 ||
  capture.measurements.some(
    (run) => run.test_exit !== 0 || run.export_exit !== 0,
  )
)
  throw Error("Real gate and successful measurements required");
const source = path.join(folder, "source.mp4");
await run("ffmpeg", [
  "-y",
  "-v",
  "error",
  "-i",
  path.join(folder, "native.webm"),
  "-an",
  "-vf",
  "tpad=stop_mode=clone:stop_duration=1,format=yuv420p",
  "-c:v",
  "libx264",
  "-preset",
  "fast",
  "-crf",
  "16",
  "-color_range",
  "tv",
  "-movflags",
  "+faststart",
  source,
]);
// Exercise the URL importer against our own source. Nothing is served outside loopback.
const size = (await stat(source)).size;
const server = createServer((req, res) => {
  if (req.url !== "/source.mp4") {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": size });
  if (req.method === "HEAD") res.end();
  else createReadStream(source).pipe(res);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  console.log(
    await run("yt-dlp", [
      "--ignore-config",
      "--no-playlist",
      "--no-progress",
      "--force-overwrites",
      "-o",
      path.join(publicDir, "native.mp4"),
      `http://127.0.0.1:${server.address().port}/source.mp4`,
    ]),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (
  digest(await readFile(source)) !==
  digest(await readFile(path.join(publicDir, "native.mp4")))
)
  throw Error("yt-dlp changed the source bytes");
await copyFile(voice.audio, path.join(publicDir, "narration.m4a"));
let start = 0;
const intro = capture.chapters[0];
const chapters = voice.clips.map((clip) => {
  const recorded = capture.chapters.find((chapter) => chapter.id === clip.id);
  const drift = (recorded.start - intro.start) / 1000 - start;
  if (Math.abs(drift) > 0.15)
    throw Error("Native recording drifts from narration: " + clip.id);
  const chapter = {
    id: clip.id,
    title: clip.title,
    detail: clip.detail,
    start,
    seconds: clip.seconds,
    drift,
    targets: recorded.targets,
  };
  start += clip.seconds;
  return chapter;
});
const graph = chapters[0].targets.graph,
  gx = graph.x + graph.width / 2;
const key = (at, z, x, y) => ({ at, z, x, y });
const c = (id) => chapters.find((chapter) => chapter.id === id).start;
const keys = [
  key(0, 1, 800, 500),
  key(2.2, 1.28, gx, 400),
  key(c("drill") + 0.2, 1.28, gx, 400),
  key(c("drill") + 1.6, 1.48, gx, 455),
  key(c("drill") + 4.3, 1.48, gx, 455),
  key(c("drill") + 5.5, 1.42, 540, 390),
  key(c("rule") + 0.3, 1.42, 540, 390),
  key(c("rule") + 1.7, 1.48, gx, 430),
  key(c("rule") + 4.6, 1.48, gx, 430),
  key(c("rule") + 5.7, 1.55, gx, 580),
  key(c("repair") + 0.4, 1.55, gx, 580),
  key(c("repair") + 1.7, 1.48, 540, 520),
  key(c("verify") + 0.2, 1.48, 540, 520),
  key(c("verify") + 1.5, 1.48, gx, 545),
  key(c("verify") + 2.6, 1.6, gx, 610),
  key(c("verify") + 6.3, 1.6, gx, 610),
  key(c("verify") + 7.7, 1.28, gx, 400),
  key(start + 0.1, 1.28, gx, 400),
].map((item) => ({
  ...item,
  x: Math.max(800 / item.z, Math.min(1600 - 800 / item.z, item.x)),
  y: Math.max(500 / item.z, Math.min(1000 - 500 / item.z, item.y)),
}));
const metadata = JSON.parse(
  await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    voice.audio,
  ]),
);
const sourceStart = (intro.start - capture.firstFrameTime) / 1000;
const props = {
  fps: 60,
  duration: Number(metadata.format.duration),
  sourceStart,
  playbackRate: 1,
  chapters,
  camera: keys,
  actions: capture.actions.map((action) => ({
    ...action,
    at: (action.time - intro.start) / 1000,
  })),
  cursorAnnotation: true,
  googleAudioSource: voice.audio,
  whisper: false,
  sourceFrames: capture.sourceFrames,
  measurements: capture.measurements,
};
await writeFile(
  path.join(folder, "edit.json"),
  JSON.stringify(props, null, 2) + "\n",
);
console.log(
  `Prepared ${chapters.length} sections; continuous source at 1x; max drift ${Math.max(...chapters.map((chapter) => Math.abs(chapter.drift))).toFixed(3)}s; Google audio unchanged.`,
);
