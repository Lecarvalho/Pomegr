import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionFileLister, listSessionFiles } from "../monitor/session-discovery.mjs";

const SETTLED = Date.now() / 1000 - 3_600;

function write(root, relative, mtimeSeconds = SETTLED) {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n");
  fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
  return file;
}

/** Age every directory past the settle window, as an idle tree would be. */
function settleDirectories(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) settleDirectories(path.join(directory, entry.name));
  }
  fs.utimesSync(directory, SETTLED, SETTLED);
}

function countingFs() {
  const counts = { readdir: 0 };
  const operations = {
    ...fs,
    readdirSync(...args) { counts.readdir += 1; return fs.readdirSync(...args); },
    promises: {
      ...fs.promises,
      readdir(...args) { counts.readdir += 1; return fs.promises.readdir(...args); },
    },
  };
  return { operations, counts };
}

async function assertEquivalent(lister, root, message) {
  const expected = listSessionFiles(root);
  assert.deepStrictEqual(lister.list(root), expected, `${message} (sync)`);
  assert.deepStrictEqual(await lister.listAsync(root), expected, `${message} (async)`);
}

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pomegr-lister-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "project-a/one.jsonl", SETTLED + 10);
  write(root, "project-a/one/subagents/agent-a.jsonl", SETTLED + 40);
  write(root, "project-a/two.jsonl", SETTLED + 20);
  write(root, "project-b/three.jsonl", SETTLED + 30);
  write(root, "project-b/notes.txt");
  write(root, "project-b/tie-a.jsonl", SETTLED + 5);
  write(root, "project-b/tie-b.jsonl", SETTLED + 5);
  // Past the six-level depth limit: excluded by every walk.
  write(root, "deep/1/2/3/4/5/6/too-deep.jsonl", SETTLED + 50);
  write(root, "deep/1/2/3/4/5/inside.jsonl", SETTLED + 1);
  fs.mkdirSync(path.join(root, "project-b", "folder.jsonl"));
  settleDirectories(root);
  return root;
}

test("cached discovery equals a full walk and rereads only changed directories", async (context) => {
  const root = fixture(context);
  const { operations, counts } = countingFs();
  const lister = createSessionFileLister({ fs: operations });
  await assertEquivalent(lister, root, "initial tree");
  assert.equal(listSessionFiles(root).some(({ file }) => file.endsWith("too-deep.jsonl")), false);

  counts.readdir = 0;
  await assertEquivalent(lister, root, "unchanged tree");
  assert.equal(counts.readdir, 0, "settled unchanged directories are not read again");

  // An append changes only the file's own modification time.
  const two = path.join(root, "project-a", "two.jsonl");
  fs.appendFileSync(two, "{}\n");
  fs.utimesSync(two, SETTLED + 90, SETTLED + 90);
  counts.readdir = 0;
  await assertEquivalent(lister, root, "appended transcript");
  assert.equal(counts.readdir, 0, "an append is observed through the file stat alone");

  write(root, "project-a/added.jsonl", SETTLED + 95);
  counts.readdir = 0;
  await assertEquivalent(lister, root, "added session");
  assert.equal(counts.readdir, 2, "only the changed directory is read, once per walk");
  counts.readdir = 0;
  await assertEquivalent(lister, root, "recently changed directory");
  assert.equal(counts.readdir, 2, "a directory changed inside the settle window is read again");
});

test("cached discovery follows removals, renames, new project directories, and removed subtrees", async (context) => {
  const root = fixture(context);
  const lister = createSessionFileLister();
  await assertEquivalent(lister, root, "initial tree");

  fs.rmSync(path.join(root, "project-b", "three.jsonl"));
  await assertEquivalent(lister, root, "removed session");

  fs.renameSync(path.join(root, "project-a", "one.jsonl"), path.join(root, "project-a", "renamed.jsonl"));
  await assertEquivalent(lister, root, "renamed session");

  write(root, "project-c/new.jsonl", SETTLED + 99);
  await assertEquivalent(lister, root, "new project directory");

  fs.rmSync(path.join(root, "project-a", "one"), { recursive: true });
  await assertEquivalent(lister, root, "removed subagent subtree");

  fs.rmSync(path.join(root, "deep"), { recursive: true });
  settleDirectories(root);
  await assertEquivalent(lister, root, "settled after removals");
});

test("a change deep in the tree is found although ancestor directories keep their modification times", async (context) => {
  const root = fixture(context);
  const { operations, counts } = countingFs();
  const lister = createSessionFileLister({ fs: operations });
  await assertEquivalent(lister, root, "initial tree");
  const ancestors = [root, path.join(root, "project-a"), path.join(root, "project-a", "one")];
  const before = ancestors.map((directory) => fs.statSync(directory).mtimeMs);
  write(root, "project-a/one/subagents/agent-b.jsonl", SETTLED + 70);
  assert.deepEqual(ancestors.map((directory) => fs.statSync(directory).mtimeMs), before,
    "only the directory that holds the new entry changes");
  counts.readdir = 0;
  await assertEquivalent(lister, root, "new file three levels down");
  assert.equal(counts.readdir, 2, "each directory's own listing is validated by its own modification time");
});

test("cached discovery keeps full-walk handling of missing and unreadable roots", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pomegr-lister-root-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lister = createSessionFileLister();
  assert.deepStrictEqual(lister.list(path.join(root, "missing")), []);
  assert.deepStrictEqual(await lister.listAsync(path.join(root, "missing")), []);
  assert.deepStrictEqual(lister.list(""), listSessionFiles(""));
  const file = write(root, "not-a-directory.jsonl");
  assert.throws(() => listSessionFiles(file));
  assert.throws(() => lister.list(file));
  await assert.rejects(lister.listAsync(file));
});
