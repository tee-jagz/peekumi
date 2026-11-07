/** @module Verify delivery cadence, source audio and real browser playback. */
import { readFile, writeFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import assert from "node:assert/strict";
import { run } from "./run.mjs";
const here = import.meta.dirname,
  root = path.resolve(here, "../../../test-results/hermes");
const folder = path.join(root, "framework-demo"),
  file = path.join(root, "release-google/peekumi-remotion.mp4");
const metadata = JSON.parse(
  await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_name,pix_fmt,r_frame_rate,nb_frames",
    "-of",
    "json",
    file,
  ]),
);
const video = metadata.streams.find((stream) => stream.codec_name === "h264");
assert.equal(video.r_frame_rate, "60/1");
assert.equal(video.pix_fmt, "yuv420p");
assert.ok(Number(metadata.format.duration) < 90);
assert.ok((await stat(file)).size < 8 * 1024 * 1024);
const times = (
  await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_frames",
    "-show_entries",
    "frame=best_effort_timestamp_time",
    "-of",
    "csv=p=0",
    file,
  ])
)
  .split("\n")
  .map((value) => parseFloat(value))
  .filter(Number.isFinite);
for (let index = 1; index < times.length; index++)
  assert.ok(
    Math.abs(times[index] - times[index - 1] - 1 / 60) < 0.0001,
    "Video cadence must stay at 60 fps",
  );
const props = JSON.parse(
  await readFile(path.join(folder, "edit.json"), "utf8"),
);
assert.equal(props.playbackRate, 1);
assert.equal(props.whisper, false);
const source = await run("ffmpeg", [
  "-v",
  "error",
  "-i",
  props.googleAudioSource,
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
const output = await run("ffmpeg", [
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
assert.equal(source, output);
const size = (await stat(file)).size;
const server = createServer((req, res) => {
  if (req.url === "/video.mp4") {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": size });
    createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end('<video src="/video.mp4" muted controls></video>');
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const require = createRequire(path.resolve(here, "../../../package.json"));
const { chromium } = require("@playwright/test");
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("video").evaluate((video) => video.play());
  await page.waitForFunction(
    () => document.querySelector("video").currentTime > 1,
    null,
    { timeout: 15000 },
  );
  assert.equal(
    await page
      .locator("video")
      .evaluate((video) => video.error?.message || null),
    null,
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
const verification = JSON.parse(
  await readFile(path.join(folder, "verification.json"), "utf8"),
);
Object.assign(verification, {
  frames: times.length,
  constantFrameRate: true,
  bytes: size,
  chromiumPlayback: "passed",
  threadPlayback: "not verified",
});
await writeFile(
  path.join(folder, "verification.json"),
  JSON.stringify(verification, null, 2) + "\n",
);
console.log(
  `Verified ${times.length} frames at 60 fps; ${Math.round((size / 1024 / 1024) * 10) / 10} MiB; original Google audio; Chromium playback passes.`,
);
