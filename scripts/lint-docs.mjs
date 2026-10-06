#!/usr/bin/env node
/**
 * @module Checks the documents that people read against the writing rules in CONTRIBUTING.md
 * (ASD-STE100 Simplified Technical English).
 *
 * It reads the Markdown files of the repository, except the archived design context, and it
 * skips code blocks, inline code, links and HTML. Errors stop CI: an em dash, or a contraction
 * such as "don't". A sentence of more than 25 words is a warning, because STE allows a longer
 * sentence where it is necessary.
 *
 * Usage: `node scripts/lint-docs.mjs [--verbose] [files...]`. With no files, it checks all of
 * them. `--verbose` lists each long sentence. Exits with 1 when an error is found.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const SKIP = new Set([
  "node_modules",
  "target",
  "dist",
  ".git",
  ".strata",
  ".peekumi",
  "test-results",
  "reference",
  "context",
  "mockups",
]);
const LONG = 25;
// "n't", "'re", "'ve", "'ll", "'m" and "'d" after a word, and the common "'s" forms of "is".
const CONTRACTION =
  /\b(?:\w+n['’]t|\w+['’](?:re|ve|ll|m|d)|(?:it|that|there|here|what|who|let)['’]s)\b/gi;

/** Every Markdown file under `dir`, except the folders in SKIP. */
async function markdown(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await markdown(full)));
    else if (entry.name.endsWith(".md")) found.push(full);
  }
  return found;
}

/** The prose of a Markdown file, line by line: code, links, HTML and tables are blanked. */
function prose(text) {
  let fenced = false;
  return text.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return "";
    }
    if (fenced || /^\s*\|/.test(line) || /^\s{4,}\S/.test(line)) return "";
    return line
      .replace(/`[^`]*`/g, "CODE")
      .replace(/<!--.*?-->/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "URL");
  });
}

/** The sentences of a paragraph with more than LONG words. */
function longSentences(paragraph) {
  return paragraph
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .split(/(?<=[.!?:][*")]*)\s+(?=[A-Z*"(])/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).filter((w) => /\w/.test(w)).length > LONG);
}

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const named = args.filter((a) => !a.startsWith("--"));
const files = named.length
  ? named.map((f) => path.resolve(f))
  : (await markdown(root)).sort();

let errors = 0,
  warnings = 0;
for (const file of files) {
  const name = path.relative(root, file);
  const lines = prose(await readFile(file, "utf8"));
  lines.forEach((line, i) => {
    if (line.includes("—")) {
      console.log(
        `${name}:${i + 1}: error: an em dash. Use a comma, a colon, a full stop or parentheses.`,
      );
      errors++;
    }
    for (const match of line.matchAll(CONTRACTION)) {
      console.log(
        `${name}:${i + 1}: error: the contraction "${match[0]}". Write the words in full.`,
      );
      errors++;
    }
  });
  // Paragraphs: lines between blank lines, headings and list items stay with their text.
  const long = lines
    .join("\n")
    .split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.)\s)|\n(?=#)/)
    .filter((p) => !/^\s*#/.test(p))
    .flatMap((p) => longSentences(p.replace(/\n/g, " ")));
  warnings += long.length;
  if (long.length && verbose)
    for (const sentence of long)
      console.log(
        `${name}: warning: ${sentence.split(/\s+/).length} words: ${sentence.slice(0, 120)}…`,
      );
  else if (long.length)
    console.log(
      `${name}: warning: ${long.length} sentence${long.length === 1 ? "" : "s"} longer than ${LONG} words`,
    );
}
console.log(
  `${files.length} documents: ${errors} error${errors === 1 ? "" : "s"}, ${warnings} long sentence${warnings === 1 ? "" : "s"}.`,
);
process.exit(errors ? 1 : 0);
