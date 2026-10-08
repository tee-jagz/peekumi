import test from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fixture } from "./workflow-support.mjs";

test("the newest commit carries the uncommitted changes as a snapshot, and the repository stays as it was", async (t) => {
  const f = await fixture({
    files: {
      ".gitignore": "secret.txt\n",
      "notes.txt": "Notes\n",
    },
  });
  t.after(() => f.close());
  const head = (await f.git("rev-parse", "HEAD")).toString().trim();
  const repo = async () => f.req("/api/repo");

  // A clean checkout has no uncommitted changes.
  assert.equal((await repo()).commits[0].uncommitted, undefined);

  await writeFile(
    path.join(f.dir, "module.py"),
    '"""Fixture module."""\ndef run():\n    return 2\n',
  );
  await writeFile(path.join(f.dir, "added.py"), "def added():\n    return 3\n");
  await unlink(path.join(f.dir, "notes.txt"));
  await writeFile(path.join(f.dir, "secret.txt"), "ignored\n");
  await symlink("/etc/passwd", path.join(f.dir, "link.txt"));
  // One change is staged: the snapshot shows the files as they are on the disk.
  await f.git("add", "added.py");
  const before = {
    status: (await f.git("status", "--porcelain")).toString(),
    // Read after `git status`, which may refresh the index.
    objects: (await f.git("count-objects", "-v")).toString(),
    refs: (await f.git("for-each-ref")).toString(),
    index: (await stat(path.join(f.dir, ".git", "index"))).mtimeMs,
  };

  const first = await repo();
  assert.equal(first.commits[0].sha, head);
  assert.equal(first.initialHead, head);
  const snapshot = first.commits[0].uncommitted;
  assert.deepEqual(snapshot.paths, [
    "added.py",
    "link.txt",
    "module.py",
    "notes.txt",
  ]);
  await assert.rejects(
    f.git("cat-file", "-e", snapshot.sha),
    "the snapshot is not in the repository's own objects",
  );
  assert.equal(
    (await repo()).commits[0].uncommitted.sha,
    snapshot.sha,
    "the same files give the same snapshot",
  );

  const compare = await f.req(`/api/compare?base=${head}&head=${snapshot.sha}`);
  const status = Object.fromEntries(
    compare.files
      .filter((file) => file.status !== "unchanged")
      .map((file) => [file.path, file.status]),
  );
  assert.deepEqual(status, {
    "added.py": "added",
    "link.txt": "added",
    "module.py": "changed",
    "notes.txt": "removed",
  });
  const source = await f.req(
    `/api/source?base=${head}&head=${snapshot.sha}&path=module.py`,
  );
  assert.match(source.patch, /^\+    return 2$/m);
  const link = await f.req(
    `/api/source?base=${head}&head=${snapshot.sha}&path=link.txt`,
  );
  assert.doesNotMatch(
    JSON.stringify(link),
    /root:/,
    "a link is read as a link, not followed",
  );

  // An instruction can be about uncommitted code; the task says that the agent lacks it.
  const comment = await f.req("/api/comments", {
    text: "Name the new function better",
    sha: snapshot.sha,
    anchor: { kind: "file", path: "added.py" },
  });
  assert.equal(comment.uncommitted, true);
  const preview = await f.req("/api/runs/preview", {
    agent: "claude",
    commentIds: [comment.id],
  });
  assert.match(preview.task, /uncommitted changes of the owner/);

  // Peekumi changed nothing in the repository: index, files, objects and refs. The index
  // comes first, because the test's own `git status` can refresh it.
  assert.equal(
    (await stat(path.join(f.dir, ".git", "index"))).mtimeMs,
    before.index,
  );
  assert.equal(
    (await f.git("status", "--porcelain")).toString(),
    before.status,
  );
  assert.equal((await f.git("count-objects", "-v")).toString(), before.objects);
  assert.equal((await f.git("for-each-ref")).toString(), before.refs);
  assert.equal(
    await readFile(path.join(f.dir, "secret.txt"), "utf8"),
    "ignored\n",
  );

  // A change makes a new snapshot; a clean checkout has none again.
  await writeFile(path.join(f.dir, "added.py"), "def added():\n    return 4\n");
  assert.notEqual((await repo()).commits[0].uncommitted.sha, snapshot.sha);
  await f.git("reset", "-q", "--hard");
  await rm(path.join(f.dir, "link.txt"));
  await rm(path.join(f.dir, "secret.txt"));
  await rm(path.join(f.dir, "added.py"), { force: true });
  assert.equal((await repo()).commits[0].uncommitted, undefined);
});
