import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeProvider } from "../../../../server/providers/claude/index.mjs";
import { createClaudeToolCallEvidenceReader } from "../../../../server/providers/claude/tool-call-evidence.mjs";
import { claudeGitCommandDirectories, rebaseCheckoutTarget, resolveClaudeWorkingCheckout } from "../../../../server/providers/claude/working-checkout.mjs";
import { createSessionRepositoryEnrichment } from "../../../../server/repository/session-repository-enrichment.mjs";

const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const OTHER_REPOSITORY_ID = "repo-89abcdef0123456789abcdef";

function shell(command, { cwd, gitBranch, tool = "Bash" } = {}) {
  return {
    type: "assistant", ...(cwd ? { cwd } : {}), ...(gitBranch ? { gitBranch } : {}),
    message: { content: [{ type: "tool_use", id: `call-${command.length}`, name: tool, input: { command } }] },
  };
}

function checkouts(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pomegr-working-checkout-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const main = path.join(base, "main");
  const linked = path.join(base, "linked");
  const foreign = path.join(base, "foreign");
  for (const directory of [main, linked, foreign, path.join(linked, "docs")]) fs.mkdirSync(directory, { recursive: true });
  const roots = [[linked, REPOSITORY_ID], [main, REPOSITORY_ID], [foreign, OTHER_REPOSITORY_ID]];
  const resolveRepository = async (cwd) => {
    const found = roots.find(([root]) => cwd === root || cwd.startsWith(`${root}${path.sep}`));
    return found ? { repositoryId: found[1], root: found[0], mainRoot: main, recognized: true } : null;
  };
  return { base, main, linked, foreign, resolveRepository };
}

test("a Git command names its directory by an opening directory change, by git -C, or by the recorded working directory", (t) => {
  const { main, linked, foreign } = checkouts(t);
  const directories = claudeGitCommandDirectories([
    { type: "user", cwd: main, gitBranch: "main" },
    shell("git status --short", { cwd: main, gitBranch: "main" }),
    shell(`cd "${foreign}" && git log -1`, { cwd: main }),
    shell(`git -C ${linked} commit -q -m work`, { cwd: main }),
    shell("npm test", { cwd: main }),
    shell(`cd ${linked} && npm test`, { cwd: main }),
  ]);
  assert.deepEqual(directories, [
    main,
    foreign,
    linked,
  ]);
});

test("a relative directory resolves against the recorded working directory, and the latest use orders the list", (t) => {
  const { main, linked } = checkouts(t);
  const directories = claudeGitCommandDirectories([
    shell("cd ../linked && git add -A", { cwd: main, gitBranch: "main" }),
    shell("git fetch -q origin; git status", { cwd: main, gitBranch: "main" }),
    shell("Set-Location ..\\linked; git push", { cwd: main, tool: "PowerShell" }),
  ]);
  assert.deepEqual(directories, [main, linked]);
});

test("a directory that needs a shell to expand it, and a directory change later in the command, name nothing", (t) => {
  const { main } = checkouts(t);
  const directories = claudeGitCommandDirectories([
    shell("cd $WORKTREE && git status", { cwd: main }),
    shell("cd ~/work && git status", { cwd: main }),
    shell("cd `pwd`/x && git status", { cwd: main }),
    shell("git -C \"$(pwd)\" status", { cwd: main }),
  ]);
  assert.deepEqual(directories, []);
  assert.deepEqual(claudeGitCommandDirectories([shell("git status")]), [], "no working directory was recorded yet");
  assert.deepEqual(claudeGitCommandDirectories([shell("git worktree add ../linked && cd ../linked && git log", { cwd: main })]), [main]);
});

test("a session whose latest Git command ran in another checkout of its repository is bound to that checkout", async (t) => {
  const { main, linked, resolveRepository } = checkouts(t);
  const working = await resolveClaudeWorkingCheckout({
    launchCwd: main, resolveRepository,
    directories: [main, path.join(linked, "docs")],
  });
  assert.equal(working.launchRoot, main);
  assert.deepEqual(working.roots, [linked]);
  assert.equal(working.attribution.state, "single");
  assert.equal(working.attribution.root, linked);
  assert.equal(working.attribution.repositoryId, REPOSITORY_ID);
  assert.equal(working.attribution.recordedBranch, null);
  assert.equal(working.attribution.anyBranch, true);
  assert.match(working.attribution.fingerprint, /^[a-f0-9]{32}$/u);
});

test("the launch checkout, another repository, and a removed directory bind nothing", async (t) => {
  const { base, main, linked, foreign, resolveRepository } = checkouts(t);
  const back = await resolveClaudeWorkingCheckout({
    launchCwd: main, resolveRepository,
    directories: [linked, main],
  });
  assert.equal(back.attribution, null, "the session returned to its launch checkout");
  assert.deepEqual(back.roots, [linked], "a file it changed in the other checkout still reads as a file of the repository");
  const elsewhere = await resolveClaudeWorkingCheckout({ launchCwd: main, resolveRepository, directories: [foreign] });
  assert.deepEqual(elsewhere, { launchRoot: main, roots: [], attribution: null });
  const removed = await resolveClaudeWorkingCheckout({ launchCwd: main, resolveRepository, directories: [path.join(base, "removed")] });
  assert.equal(removed.attribution, null);
  assert.equal(await resolveClaudeWorkingCheckout({ launchCwd: main, resolveRepository, directories: [] }), null);
  assert.equal(await resolveClaudeWorkingCheckout({ launchCwd: main, resolveRepository: null, directories: [linked] }), null);
});

test("a file changed in the other checkout is recorded under the same repository-relative path", (t) => {
  const { main, linked, foreign } = checkouts(t);
  const working = { launchRoot: main, roots: [linked] };
  assert.equal(rebaseCheckoutTarget(path.join(linked, "docs", "a.md"), working), path.join(main, "docs", "a.md"));
  assert.equal(rebaseCheckoutTarget(path.join(foreign, "a.md"), working), path.join(foreign, "a.md"));
  assert.equal(rebaseCheckoutTarget(linked, working), linked);
  assert.equal(rebaseCheckoutTarget(path.join(linked, "a.md"), null), path.join(linked, "a.md"));

  const target = path.join(linked, "docs", "a.md");
  const records = [
    { type: "assistant", timestamp: "2026-10-10T10:00:00.000Z", message: { content: [{ type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: target, old_string: "a", new_string: "b" } }] } },
    { type: "user", timestamp: "2026-10-10T10:00:01.000Z", toolUseResult: { filePath: target, oldString: "a", newString: "b", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] },
      message: { content: [{ type: "tool_result", tool_use_id: "edit-1", content: "updated" }] } },
  ];
  const read = (checkoutsOption) => createClaudeToolCallEvidenceReader().read({
    file: path.join(main, "session.jsonl"), key: null, records, actor: { id: "primary", label: "Primary agent" }, isMain: true,
    stat: { mtime: new Date(0) }, cwd: main, forbiddenRoots: [], checkouts: checkoutsOption,
  }).toolCalls[0].fileChanges;
  assert.equal(read(null), null, "a target outside the launch directory is not a file of the session's repository on its own");
  assert.deepEqual(read(working), [{ path: "docs/a.md", kind: "edited", previousPath: null }]);
});

test("the adapter reports the working checkout, keeps it when the record tail slides, and drops it when the session returns", async (t) => {
  const { base, main, linked, resolveRepository } = checkouts(t);
  const file = path.join(base, "home", "projects", "fixture", "working-session.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = (seconds) => new Date(Date.parse("2026-10-10T10:00:00.000Z") + seconds * 1_000).toISOString();
  const lines = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const edit = path.join(linked, "docs", "a.md");
  fs.writeFileSync(file, lines([
    { type: "user", timestamp: at(0), cwd: main, gitBranch: "main", message: { content: "PRIVATE_PROMPT" } },
    { ...shell(`cd ${linked} && git status`, { cwd: main, gitBranch: "main" }), timestamp: at(1) },
    { type: "assistant", timestamp: at(2), cwd: main, message: { content: [{ type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: edit, old_string: "a", new_string: "b" } }] } },
    { type: "user", timestamp: at(3), cwd: main, toolUseResult: { filePath: edit }, message: { content: [{ type: "tool_result", tool_use_id: "edit-1", content: "updated" }] } },
  ]));
  const provider = createClaudeProvider({ homeDir: path.join(base, "home"), projectsRoot: path.join(base, "home", "projects") });
  assert.equal(provider.repositoryAttributionForSession("working-session"), null);
  provider.setRepositoryResolver(resolveRepository);
  const read = () => provider.readSession("working-session", { historical: false });
  const evidence = await read();
  assert.equal(evidence.session.cwd, main, "the launch directory is still the session's recorded directory");
  assert.equal(evidence.session.repositoryId, REPOSITORY_ID);
  assert.deepEqual(evidence.toolCalls.find((call) => call.id === "edit-1").fileChanges, [{ path: "docs/a.md", kind: "edited", previousPath: null }]);
  assert.equal(provider.repositoryAttributionForSession("working-session").root, linked);
  assert.doesNotMatch(JSON.stringify(evidence), /linked/u, "the working checkout never enters the evidence");

  fs.appendFileSync(file, lines([{ type: "user", timestamp: at(10), cwd: main, message: { content: "x".repeat(2_300_000) } }]));
  await read();
  assert.equal(provider.repositoryAttributionForSession("working-session").root, linked, "a tail with no Git command decides nothing new");

  fs.appendFileSync(file, lines([{ ...shell("git worktree remove ../linked", { cwd: main, gitBranch: "main" }), timestamp: at(20) }]));
  await read();
  assert.equal(provider.repositoryAttributionForSession("working-session"), null);
});

function enrichmentFixture(gitBranch) {
  const jobs = [];
  const reads = [];
  const enrichment = createSessionRepositoryEnrichment({
    gitReader: async (root) => {
      reads.push(root);
      return { available: true, branch: gitBranch, files: [{ status: " M", path: "docs/a.md" }], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null }, _repositoryRoot: root };
    },
    pullRequestReader: async (_creations, options) => ({ status: "ready", checkedAt: new Date(0).toISOString(), items: [], branch: options.branch }),
    now: () => 5_000,
    cacheMs: 2_500,
    providerFolders: { folders: {} },
    unavailableGitState: () => ({ available: false, branch: "Not a Git repository", files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
    unavailablePullRequests: () => ({ status: "unavailable", checkedAt: null, items: [] }),
  });
  const evidence = { session: { cwd: "C:\\synthetic\\main", recordedGitBranch: "main", startedAt: new Date(0).toISOString() }, pullRequestCreations: [], executionTasks: [] };
  async function refresh(attribution) {
    enrichment.liveEnrichment("claude:working", evidence, attribution, (task) => jobs.push(task)).enqueue?.();
    while (jobs.length) await jobs.shift()();
    return enrichment.liveEnrichment("claude:working", evidence, attribution, (task) => jobs.push(task));
  }
  return { refresh, reads, enrichment };
}

test("the live Git read of a checkout with no recorded branch takes the branch the checkout has", async () => {
  const root = path.resolve("C:\\synthetic\\linked");
  const attribution = { state: "single", repositoryId: REPOSITORY_ID, root, fingerprint: "f".repeat(32), recordedBranch: null, anyBranch: true };
  // The transcript still records the launch branch, here "main", after the session moved.
  const { refresh, reads, enrichment } = enrichmentFixture("tasks/T-1");
  const live = await refresh(attribution);
  assert.deepEqual(reads, [path.normalize(root)], "Git is read in the working checkout, never in the launch directory");
  assert.equal(live.value.repository.available, true);
  assert.equal(live.value.repository.branch, "tasks/T-1");
  assert.deepEqual(live.value.repository.files, [{ status: " M", path: "docs/a.md" }]);
  assert.equal(live.value.pullRequests.branch, "tasks/T-1");
  assert.equal(enrichment.repositoryRootForSession("claude:working"), path.normalize(root));
});

test("a recorded branch still has to match, and an attribution without one or the flag binds no other root", async () => {
  const root = path.resolve("C:\\synthetic\\linked");
  const recorded = enrichmentFixture("tasks/T-2");
  const mismatch = await recorded.refresh({ state: "single", repositoryId: REPOSITORY_ID, root, fingerprint: "f".repeat(32), recordedBranch: "tasks/T-1", anyBranch: false });
  assert.equal(mismatch.value.repository.available, false);
  assert.equal(recorded.enrichment.unavailableReasonForSession("claude:working"), "branch_changed");
  const unflagged = enrichmentFixture("main");
  await unflagged.refresh({ state: "single", repositoryId: REPOSITORY_ID, root, fingerprint: "f".repeat(32), recordedBranch: null });
  assert.deepEqual(unflagged.reads, [path.normalize("C:\\synthetic\\main")]);
});
