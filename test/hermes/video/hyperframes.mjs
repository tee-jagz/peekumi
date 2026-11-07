/** @module Render the identity overlay with the requested HyperFrames engine. */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { run } from "./run.mjs";
const here = import.meta.dirname;
if (!process.env.PEEKUMI_VIDEO_BROWSER)
  throw Error("Set PEEKUMI_VIDEO_BROWSER to a headless Chrome executable");
const artifacts = path.resolve(
  here,
  "../../../test-results/hermes/framework-demo",
);
const project = path.join(artifacts, "hyperframes");
const output = path.join(artifacts, "public/brand");
await mkdir(project, { recursive: true });
await mkdir(output, { recursive: true });
await copyFile(path.join(here, "brand.html"), path.join(project, "index.html"));
await copyFile(
  path.join(here, "node_modules/gsap/dist/gsap.min.js"),
  path.join(project, "gsap.min.js"),
);
console.log(
  await run(
    path.join(here, "node_modules/.bin/hyperframes"),
    [
      "render",
      project,
      "--output",
      output,
      "--format",
      "png-sequence",
      "--fps",
      "60",
      "--workers",
      "1",
      "--no-browser-gpu",
      "--experimental-fast-capture=false",
      "--low-memory-mode",
    ],
    {
      env: {
        ...process.env,
        HYPERFRAMES_NO_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        HYPERFRAMES_BROWSER_PATH: process.env.PEEKUMI_VIDEO_BROWSER,
      },
    },
  ),
);
console.log("HyperFrames identity frames: " + output);
