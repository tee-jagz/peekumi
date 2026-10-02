/** @module A repository whose second commit changes one declaration's signature, documentation
 * or implementation in Python, TypeScript and Rust, plus a whitespace-only edit. */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

const before = {
  "mod.py":
    'def sig(a):\n    return a\n\ndef doc(a):\n    """Old."""\n    return a\n\ndef impl(a):\n    return a\n\ndef same(a):\n    return a\n',
  "lib.ts":
    "/** Old. */\nexport function doc(a: number): number { return a; }\nexport function sig(a: number): number { return a; }\nexport function impl(a: number): number { return a; }\n",
  "lib.rs":
    "/// Old.\npub fn doc(a: u8) -> u8 { a }\npub fn sig(a: u8) -> u8 { a }\npub fn imp(a: u8) -> u8 { a }\npub struct Shape { pub a: u8 }\n",
};
const after = {
  "mod.py":
    'def sig(a, b):\n    return a\n\ndef doc(a):\n    """New."""\n    return a\n\ndef impl(a):\n    return a + 1\n\ndef same( a ):\n\n    return   a\n',
  "lib.ts":
    "/** New. */\nexport function doc(a: number): number { return a; }\nexport function sig(a: string): number { return a; }\nexport function impl(a: number): number { return a + 1; }\n",
  "lib.rs":
    "/// New.\npub fn doc(a: u8) -> u8 { a }\npub fn sig(a: u16) -> u8 { a }\npub fn imp(a: u8) -> u8 { a + 1 }\npub struct Shape { pub a: u8, pub b: u8 }\n",
};

/** Creates the two-commit repository and returns its directory; the caller removes it. */
export async function changesRepo() {
  const dir = await mkdtemp(join(tmpdir(), "strata-changes-"));
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  for (const [revision, label] of [
    [before, "before"],
    [after, "after"],
  ]) {
    for (const [file, source] of Object.entries(revision))
      await writeFile(join(dir, file), source);
    git(dir, "add", ".");
    git(dir, "commit", "-m", label);
  }
  return dir;
}
