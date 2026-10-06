#!/usr/bin/env node
/**
 * @module Prints the notes of a GitHub release: how to install, then the section of
 * CHANGELOG.md for that version. The Distribution workflow gives them to `gh release create`.
 *
 * Usage: `node scripts/release-notes.mjs 0.2.0`. A version with no section in the changelog
 * is an error, so a release never goes out without notes.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const version = (process.argv[2] || "").replace(/^v/, "");
if (!version) {
  console.error("Usage: node scripts/release-notes.mjs <version>");
  process.exit(2);
}
const root = path.resolve(import.meta.dirname, "..");
const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
const lines = changelog.split("\n");
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md has no section for ${version}.`);
  process.exit(1);
}
let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
if (end < 0) end = lines.length;
// The section's own heading is the release title; the notes start after it.
const section = lines.slice(start + 1, end).join("\n").trim();

process.stdout.write(`## Install

\`\`\`sh
curl -fsSL https://raw.githubusercontent.com/tee-jagz/peekumi/main/install.sh | sh
peekumi repo add /path/to/repo
peekumi start
peekumi pair    # prints the link to open on your phone
\`\`\`

The archives below are for macOS and Linux (x64 and ARM64, glibc 2.34+). Each archive has a \`.sha256\` file, and the installer checks it. See [setup](https://github.com/tee-jagz/peekumi/blob/main/docs/SETUP.md) and the [user guide](https://github.com/tee-jagz/peekumi/blob/main/docs/USER-GUIDE.md).

${section}
`);
