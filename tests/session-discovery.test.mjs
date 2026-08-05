import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findLatestSession, findSessionById, isLiveSessionActivity, listSessionFiles, repositoryProjectName, SESSION_LIVE_WINDOW_MS } from "../monitor/session-discovery.mjs";

test("classifies concurrent sessions using the documented activity window", () => {
  const now = new Date("2026-08-05T12:00:00Z").getTime();
  assert.equal(isLiveSessionActivity(now - SESSION_LIVE_WINDOW_MS, now), true);
  assert.equal(isLiveSessionActivity(now - SESSION_LIVE_WINDOW_MS - 1, now), false);
  assert.equal(isLiveSessionActivity(0, now), false);
});

test("uses the repository root instead of a working subdirectory as the project", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-project-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "Clapline");
  const frontend = path.join(repository, "frontend");
  await mkdir(path.join(repository, ".git"), { recursive: true });
  await mkdir(frontend, { recursive: true });

  assert.equal(repositoryProjectName(frontend), "Clapline");
});

test("keeps a session selected while one of its subagents is newest", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-session-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const first = path.join(project, "first.jsonl");
  const second = path.join(project, "second.jsonl");
  const childDir = path.join(project, "first", "subagents");
  const child = path.join(childDir, "agent-child.jsonl");
  await mkdir(childDir, { recursive: true });
  await writeFile(first, "{}\n");
  await writeFile(second, "{}\n");
  await writeFile(child, "{}\n");

  const old = new Date("2026-08-05T00:00:00Z");
  const otherSession = new Date("2026-08-05T00:10:00Z");
  const activeChild = new Date("2026-08-05T00:20:00Z");
  await utimes(first, old, old);
  await utimes(second, otherSession, otherSession);
  await utimes(child, activeChild, activeChild);

  assert.equal(findLatestSession(root), first);
  assert.deepEqual(listSessionFiles(root).map(({ file }) => file), [first, second]);
  assert.equal(findSessionById(root, "first"), first);
  assert.equal(findSessionById(root, "../first"), null);
});

test("respects an explicitly selected session", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadlight-explicit-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const session = path.join(root, "chosen.jsonl");
  await writeFile(session, "{}\n");
  assert.equal(findLatestSession(root, session), session);
});
