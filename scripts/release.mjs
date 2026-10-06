#!/usr/bin/env node
/**
 * @module Prepares a release: sets the new version everywhere and dates the changelog.
 *
 * Usage: `npm run release -- 0.3.0 [--dry-run]`.
 *
 * It sets the version in package.json, package-lock.json, Cargo.toml and Cargo.lock, and it
 * changes `## [Unreleased]` in CHANGELOG.md into `## [0.3.0] - <today>` under a new, empty
 * `## [Unreleased]`. It refuses a version that is not newer than the current one, and an
 * empty Unreleased section, because a release must have notes (scripts/release-notes.mjs).
 * It runs no Git command: RELEASING.md gives the steps after it. `--dry-run` prints the
 * changes and writes nothing. `PEEKUMI_RELEASE_ROOT` selects another folder, for tests.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(
  process.env.PEEKUMI_RELEASE_ROOT || path.join(import.meta.dirname, ".."),
);
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const next = (args.find((a) => !a.startsWith("--")) || "").replace(/^v/, "");
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};
const parse = (v) => v.split(".").map(Number);
if (!/^\d+\.\d+\.\d+$/.test(next))
  fail("give the new version as MAJOR.MINOR.PATCH, for example 0.3.0");

const read = (name) => readFile(path.join(root, name), "utf8");
const pkg = JSON.parse(await read("package.json"));
const current = pkg.version;
const [a, b] = [parse(next), parse(current)];
const newer = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
if (newer <= 0)
  fail(`${next} is not newer than the current version ${current}`);

const changes = new Map();
// package.json and package-lock.json: the version of this package only.
pkg.version = next;
changes.set("package.json", JSON.stringify(pkg, null, 2) + "\n");
const lock = JSON.parse(await read("package-lock.json"));
lock.version = next;
if (lock.packages?.[""]) lock.packages[""].version = next;
changes.set("package-lock.json", JSON.stringify(lock, null, 2) + "\n");

// Cargo.toml: the version in [package]; Cargo.lock: the entry of the peekumi package.
const cargo = await read("Cargo.toml");
const cargoNext = cargo.replace(
  /(\[package\][^[]*?\nversion = ")[^"]+(")/,
  `$1${next}$2`,
);
if (cargoNext === cargo) fail("Cargo.toml has no [package] version");
changes.set("Cargo.toml", cargoNext);
const cargoLock = await read("Cargo.lock");
const cargoLockNext = cargoLock.replace(
  /(\[\[package\]\]\nname = "peekumi"\nversion = ")[^"]+(")/,
  `$1${next}$2`,
);
if (cargoLockNext === cargoLock) fail("Cargo.lock has no peekumi package");
changes.set("Cargo.lock", cargoLockNext);

// CHANGELOG.md: the Unreleased section becomes the release, under a new empty one.
const changelog = await read("CHANGELOG.md");
const lines = changelog.split("\n");
const start = lines.findIndex((l) => l.trim() === "## [Unreleased]");
if (start < 0) fail("CHANGELOG.md has no ## [Unreleased] section");
let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
if (end < 0) end = lines.length;
if (!lines.slice(start + 1, end).some((l) => /^\s*-\s+\S/.test(l)))
  fail("the ## [Unreleased] section of CHANGELOG.md lists no change");
const today = new Date().toISOString().slice(0, 10);
lines.splice(start, 1, "## [Unreleased]", "", `## [${next}] - ${today}`);
changes.set("CHANGELOG.md", lines.join("\n"));

for (const [name, text] of changes) {
  if (!dry) await writeFile(path.join(root, name), text);
  console.log(`${dry ? "Would update" : "Updated"} ${name}`);
}
console.log(`
${current} → ${next}. Next steps (RELEASING.md):
  1. Read the ${next} section of CHANGELOG.md, and run npm test, npm run test:rust and npm run test:browser.
  2. git commit -am "Release ${next}"
  3. git tag -a v${next} -m "Peekumi ${next}" && git push origin main v${next}
  4. Check the draft release that the Distribution workflow makes, then publish it.`);
