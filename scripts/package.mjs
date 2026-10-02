#!/usr/bin/env node
/** @module Builds a platform archive from the tested executable and current Node runtime. Never includes user state. */
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "peekumi-package-"));
try {
  const version = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ).version;
  const name = `peekumi-${version}-${process.platform}-${process.arch}`;
  const destination = join(temporary, name);
  execFileSync(
    process.execPath,
    [join(root, "scripts/manage.mjs"), "install", destination],
    {
      stdio: "inherit",
      env: { ...process.env, PEEKUMI_HOME: join(temporary, "state") },
    },
  );
  const out = resolve(process.argv[2] || join(root, "dist"));
  await mkdir(out, { recursive: true });
  const archive = join(out, name + ".tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", temporary, name]);
  const hash = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(archive + ".sha256", `${hash}  ${name}.tar.gz\n`);
  console.log(archive);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
