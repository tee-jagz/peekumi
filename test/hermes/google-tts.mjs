/** @module Google Gemini speech for the review video. Sends narration text only; caches verified WAV files. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const speechModel = "gemini-3.8-flash-tts";
export const speechVoice = "Charon";
const style =
  "Natural British English product narrator. Warm, clear and conversational, with confident technical delivery. Brisk but unhurried, about 175 words per minute. Use short pauses between sentences. No announcer voice, no exaggerated drama. Pronounce Peekumi as peek-oo-mee and Hermes as her-meez. Read only the supplied transcript.";

/** Generate one chapter using the explicitly configured Google API key. No fallback or hidden retries. */
export async function narrate(text, folder) {
  const digest = createHash("sha256")
    .update(JSON.stringify([speechModel, speechVoice, style, text]))
    .digest("hex");
  await mkdir(folder, { recursive: true });
  const filename = path.join(folder, digest + ".wav");
  try {
    const cached = await readFile(filename);
    if (
      cached.toString("ascii", 0, 4) === "RIFF" &&
      cached.toString("ascii", 8, 12) === "WAVE"
    )
      return filename;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key)
    throw Error(
      "Configure GEMINI_API_KEY or GOOGLE_API_KEY for the requested Google narration",
    );
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(120000),
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        model: speechModel,
        input: [
          {
            type: "user_input",
            content: [
              {
                type: "text",
                text,
                annotations: [{ type: "speech_metadata", style }],
              },
            ],
          },
        ],
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice: speechVoice }] },
      }),
    },
  );
  if (!response.ok) {
    // Do not print upstream bodies, request headers or the credential.
    throw Error("Google speech request returned HTTP " + response.status);
  }
  const body = await response.json();
  const audio = (body.steps || [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content || [])
    .filter((item) => item.type === "audio")
    .at(-1);
  if (!audio?.data) throw Error("Google did not return narration audio");
  const bytes = Buffer.from(audio.data, "base64");
  if (
    bytes.length > 24 * 1024 * 1024 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  )
    throw Error("Google speech response is not a bounded WAV file");
  await writeFile(filename, bytes);
  await writeFile(
    filename + ".json",
    JSON.stringify(
      {
        provider: "Google Gemini",
        model: speechModel,
        voice: speechVoice,
        script_hash: digest,
        bytes: bytes.length,
      },
      null,
      2,
    ) + "\n",
  );
  return filename;
}
