import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

function parse(program, args, input) {
  return new Promise((resolve, reject) => {
    const process = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "",
      errors = "";
    process.stdout.on("data", (part) => (output += part));
    process.stderr.on("data", (part) => (errors += part));
    process.on("error", reject);
    process.on("exit", (code) =>
      code === 0 ? resolve(JSON.parse(output)) : reject(Error(errors)),
    );
    process.stdin.end(JSON.stringify(input));
  });
}

test("Python import site evidence keeps exact authored lines without running imported code", async () => {
  const [result] = await parse(
    process.env.PEEKUMI_PYTHON || "/usr/bin/python3",
    ["backend/adapters/python_ast.py"],
    ['"""Fixture."""\n\nfrom shop.db import save\nimport missing_package\n'],
  );
  assert.deepEqual(result.import_sites, [
    { specifier: "shop.db", line: 3 },
    { specifier: "missing_package", line: 4 },
  ]);
  assert.equal(result.imports[0].specifier, "shop.db");
  assert.equal(result.imports[0].line, undefined);
});

test("TypeScript import site evidence covers static exports and literal dynamic imports", async () => {
  const [result] = await parse(
    process.execPath,
    ["backend/adapters/typescript_ast.mjs"],
    [
      {
        path: "ui.ts",
        source:
          "/** @module Fixture. */\n\nimport {save} from './db';\nexport {total} from './service';\nconst lazy=()=>import('./next');\n",
      },
    ],
  );
  assert.deepEqual(result.import_sites, [
    { specifier: "./db", line: 3 },
    { specifier: "./service", line: 4 },
    { specifier: "./next", line: 5 },
  ]);
  assert.equal(result.imports[0].line, undefined);
});
