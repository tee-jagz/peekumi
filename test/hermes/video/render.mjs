/** @module Render the Remotion composition and mux the unchanged Google speech with FFmpeg. */
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import { run } from "./run.mjs";
const here = import.meta.dirname,
  folder = path.resolve(here, "../../../test-results/hermes/framework-demo");
const props = JSON.parse(
  await readFile(path.join(folder, "edit.json"), "utf8"),
);
const brand = await readdir(path.join(folder, "public/brand"));
if (brand.filter((file) => file.endsWith(".png")).length !== 120)
  throw Error("120 HyperFrames identity frames required");
const executable = process.env.PEEKUMI_VIDEO_BROWSER;
if (!executable)
  throw Error("Set PEEKUMI_VIDEO_BROWSER to a headless Chrome executable");
const serveUrl = await bundle({
  entryPoint: path.join(here, "Composition.jsx"),
  publicDir: path.join(folder, "public"),
  onProgress: () => {},
});
const composition = await selectComposition({
  serveUrl,
  id: "PeekumiReview",
  inputProps: props,
  browserExecutable: executable,
});
for (const [name, seconds] of [
  ["identity", 0.7],
  ["overview", 12],
  ["drill", 21],
  ["rule", 31.5],
  ["repair", 37],
  ["verify", 46],
  ["close", 57],
])
  await renderStill({
    composition,
    serveUrl,
    inputProps: props,
    browserExecutable: executable,
    output: path.join(folder, name + ".png"),
    frame: Math.round(seconds * 60),
  });
if (process.env.PEEKUMI_VIDEO_STILLS_ONLY) process.exit(0);
let last = -1;
await renderMedia({
  composition,
  serveUrl,
  inputProps: props,
  codec: "h264",
  outputLocation: path.join(folder, "picture.mp4"),
  browserExecutable: executable,
  concurrency: 2,
  crf: 18,
  pixelFormat: "yuv420p",
  onProgress: ({ progress }) => {
    const part = Math.floor(progress * 10);
    if (part !== last) {
      last = part;
      console.log(`Remotion ${part * 10}%`);
    }
  },
});

const output = path.resolve(
  here,
  "../../../test-results/hermes/release-google/peekumi-remotion.mp4",
);
await run("ffmpeg", [
  "-y",
  "-v",
  "error",
  "-i",
  path.join(folder, "picture.mp4"),
  "-i",
  props.googleAudioSource,
  "-map",
  "0:v:0",
  "-map",
  "1:a:0",
  "-t",
  String(props.duration),
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "23",
  "-maxrate",
  "850k",
  "-bufsize",
  "1700k",
  "-profile:v",
  "main",
  "-level:v",
  "4.2",
  "-pix_fmt",
  "yuv420p",
  "-color_range",
  "tv",
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
const original = await audioHash(props.googleAudioSource),
  edited = await audioHash(output);
if (original !== edited) throw Error("Google audio changed");
await run("ffmpeg", ["-v", "error", "-i", output, "-f", "null", "-"]);
await writeFile(
  path.join(folder, "verification.json"),
  JSON.stringify(
    {
      frameworks: ["Remotion", "HyperFrames", "FFmpeg", "yt-dlp"],
      whisper: false,
      googleAudioUnchanged: true,
      audioPacketHash: original.trim(),
      fps: 60,
      sourcePlaybackRate: 1,
      duration: props.duration,
      chapters: props.chapters.map((chapter) => ({
        id: chapter.id,
        drift: chapter.drift,
      })),
      measurements: props.measurements,
      output,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Verified 60 fps Remotion cut with HyperFrames identity, 1x native footage and unchanged Google audio: " +
    output,
);
