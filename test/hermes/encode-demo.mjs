/** @module Encode native screencast frames with a visible scripted-provider disclosure. */
import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../test-results/hermes");
const output = path.resolve(
  process.argv[2] || path.join(root, "native-demo.mp4"),
);
const frames = JSON.parse(
  await readFile(path.join(root, "native-demo-frames.json"), "utf8"),
);
const events = JSON.parse(
  await readFile(path.join(root, "native-demo-events.json"), "utf8").catch(
    () => "[]",
  ),
);
const lines = ["ffconcat version 1.0"];
let duration = 0;
for (let index = 0; index < frames.length; index++) {
  const frame = frames[index],
    next = frames[index + 1];
  let seconds = next ? Math.max(0.05, (next.time - frame.time) / 1000) : 2;
  for (const event of events)
    if (event.time >= frame.time && (!next || event.time < next.time))
      seconds += event.hold || 3;
  duration += seconds;
  lines.push(
    "file '" + frame.filename.replaceAll("'", "'\\''") + "'",
    `duration ${seconds}`,
  );
}
if (duration >= 90)
  throw Error(`Demo duration ${duration.toFixed(1)} seconds exceeds the limit`);
lines.push("file '" + frames.at(-1).filename.replaceAll("'", "'\\''") + "'");
const concat = path.join(root, "native-demo.ffconcat");
await writeFile(concat, lines.join("\n") + "\n");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 28 },
  deviceScaleFactor: 1,
});
await page.setContent(
  "<style>*{box-sizing:border-box}body{margin:0;background:#111827;color:#fff;font:12px Arial,sans-serif;padding:7px 12px}</style>Scripted local provider · Real Hermes tools, gate, coverage and CRAP evidence · No external model",
);
const caption = path.join(root, "native-demo-caption.png");
await page.screenshot({ path: caption });
await browser.close();
await new Promise((resolve, reject) => {
  const child = spawn(
    "ffmpeg",
    [
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
      caption,
      "-filter_complex",
      "[0:v][1:v]overlay=0:0",
      "-r",
      "12",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      output,
    ],
    { stdio: "inherit" },
  );
  child.on("error", reject);
  child.on("exit", (code) =>
    code === 0 ? resolve() : reject(Error("Video encoder failed")),
  );
});
console.log(`Native demo: ${duration.toFixed(1)} seconds. ${output}`);
