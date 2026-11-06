/** @module Narrate the user-benefit story with the requested Google Charon voice. */
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { narrate, speechModel, speechVoice } from "./google-tts.mjs";
import { benefitStory } from "./benefit-story.mjs";
const root = path.resolve(import.meta.dirname, "../../test-results/hermes");
const folder = path.join(root, "benefit-demo");
await mkdir(folder, { recursive: true });
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
const clips = [];
for (const [index, scene] of benefitStory.entries()) {
  const wav = await narrate(
    scene.narration,
    path.join(root, "google-tts-cache"),
  );
  const duration = Number(
    await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      wav,
    ]),
  );
  const seconds = Math.ceil((duration + 0.3) * 25) / 25;
  const file = path.join(folder, `voice-${index}.wav`);
  await run("ffmpeg", [
    "-y",
    "-v",
    "error",
    "-i",
    wav,
    "-af",
    "apad",
    "-t",
    String(seconds),
    "-ar",
    "24000",
    "-ac",
    "1",
    file,
  ]);
  clips.push({ ...scene, file, seconds });
  console.log(
    "Google narration: " + scene.id + " · " + seconds.toFixed(2) + "s",
  );
}
const duration = clips.reduce((sum, clip) => sum + clip.seconds, 0);
if (duration >= 90) throw Error("The benefit story must stay below 90 seconds");
const concat = path.join(folder, "voice.ffconcat");
await writeFile(
  concat,
  "ffconcat version 1.0\n" +
    clips
      .map((clip) => "file '" + clip.file.replaceAll("'", "'\\''") + "'")
      .join("\n") +
    "\n",
);
const voice = path.join(folder, "narration.m4a");
await run("ffmpeg", [
  "-y",
  "-v",
  "error",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  concat,
  "-af",
  "loudnorm=I=-16:TP=-1.5:LRA=8",
  "-ar",
  "48000",
  "-c:a",
  "aac",
  "-b:a",
  "128k",
  voice,
]);
await writeFile(
  path.join(folder, "chapters.json"),
  JSON.stringify(
    {
      provider: "Google Gemini",
      model: speechModel,
      voice: speechVoice,
      audio: voice,
      duration,
      clips,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Benefit narration complete: " + duration.toFixed(2) + "s; " + speechVoice,
);
