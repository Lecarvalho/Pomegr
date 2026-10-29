import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_CHAT_INSTRUCTIONS } from "../desktop/runtime/agent-chat-prompt.mjs";

test("checking whether work is on the main branch compares with the remote branch and defers to the pull request", () => {
  const section = AGENT_CHAT_INSTRUCTIONS.slice(AGENT_CHAT_INSTRUCTIONS.indexOf("## What you can and cannot do"), AGENT_CHAT_INSTRUCTIONS.indexOf("## How to give task advice"));
  const rule = section.split("\n").find((line) => line.startsWith("- To check whether work is on the main branch"));
  assert.ok(rule, "the rule is a bullet of the capabilities section, next to the repository reads");
  for (const text of [
    'compare with the remote branch ("origin/main"), not local "main"',
    "A pull request's merged state on the board or in the task log is the authority.",
    "You cannot fetch, so say when the remote-tracking ref may be old too.",
    "Where you cannot run git, read what you can (.git/HEAD, .git/packed-refs, .git/refs/remotes/origin/main).",
    "If you can see only a local branch or a ref that may be stale, say that you could not confirm.",
  ]) assert.ok(rule.includes(text), text);
  // It holds for both providers: Claude Code has no shell, Codex has a read-only one, and neither is told to fetch or change anything.
  assert.ok(section.indexOf("no Bash or PowerShell tool is available") < section.indexOf(rule) && section.indexOf("read-only sandbox") < section.indexOf(rule));
  assert.doesNotMatch(rule, /git (?:fetch|pull|checkout)\b/u);
});
