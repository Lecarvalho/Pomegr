import assert from "node:assert/strict";
import test from "node:test";
import { splitTaskTags as splitInApp, splitTaskTitle as titleInApp, TASK_TAG_LIMIT as appLimit } from "../../../app/components/tasks/task-tags.ts";
import { splitTaskTags as splitOnServer, splitTaskTitle as titleOnServer, TASK_TAG_LIMIT as serverLimit } from "../../../server/tasks/task-tags.mjs";

// The server cannot import app code, so the tag rule exists twice: app/components/tasks/task-tags.ts for the board,
// and server/tasks/task-tags.mjs for the Tasks home title. Both must give the same answer for every text.

const MANY = Array.from({ length: appLimit + 2 }, (_, index) => `[t${index}]`).join(" ");
const CASES = [
  "[ backend ] [ recce ] [bug] Coverage opens a shot.\n\nMore text.",
  "[ frontend ] [ tech-debt ]\nMake plan-intent atomic\nProblem: two tabs",
  "[ frontend ] [ tech-debt ]\r\nMake plan-intent atomic",
  "Fix [ bug ] in the cart",
  "\n[ bug ] second line",
  "  [ bug ] indented first line",
  "[bug]fix it",
  "[ needs design ] later",
  "[ ok ] [a/b] rest",
  "[-x] rest",
  "[image] Screenshot of the bug",
  "[image:img-0123456789ab] Screenshot",
  "[ ui ] [image] Screenshot",
  "[Bug] [bug] [ui] Title",
  `${MANY} Title`,
  `[${"a".repeat(24)}] x`,
  `[${"a".repeat(25)}] x`,
  "[wip]",
  "[wip] [ui]\n",
  "[é] [日本語] unicode words",
  "[cafe\u0301] [हिन्दी] [\u0301bad] combining marks",
  "[ui]\n\nFix the login\nmore",
  "[ui]\n   \n\t\nFix the login",
  "[ui] [x]\r\n\r\nFix\r\nmore",
  "[ui]\rFix\rmore",
  "\n\n  Fix the login  \nmore",
  "## Fix the parser\nIt drops rows.",
  "[ui] # Fix",
  "#hashtag first",
  "####### seven marks",
  "#",
  "[wip] [ui]",
  "  [wip] [ui]  \n\n  \n",
  "[wip]\r\n",
  " \n \r\n",
  "[ a.b_c-d ]\ttabbed",
  "Plain title",
  "",
  "   ",
];

test("both tag parsers use the same limit", () => {
  assert.equal(serverLimit, appLimit);
  assert.equal(appLimit, 8);
});

for (const text of CASES) {
  test(`both tag parsers agree on ${JSON.stringify(text.slice(0, 40))}`, () => {
    assert.deepEqual(splitOnServer(text), splitInApp(text));
  });

  test(`both title rules agree on ${JSON.stringify(text.slice(0, 40))}`, () => {
    assert.deepEqual(titleOnServer(text), titleInApp(text));
  });
}

test("the server title rule skips blank lines, reads a Windows line break, drops a heading mark and keeps a text of only tags", () => {
  assert.deepEqual(titleOnServer("[ui]\n\nFix the login\nmore"), { tags: ["ui"], title: "Fix the login", rest: "more" });
  assert.deepEqual(titleOnServer("[ui] [x]\r\n\r\nFix\r\nmore"), { tags: ["ui", "x"], title: "Fix", rest: "more" });
  assert.equal(titleOnServer("## Fix the parser").title, "Fix the parser");
  assert.deepEqual(titleOnServer("[wip] [ui]"), { tags: [], title: "[wip] [ui]", rest: "" });
  assert.deepEqual(titleOnServer(""), { tags: [], title: "", rest: "" });
});

test("both parsers take a word with combining marks", () => {
  for (const split of [splitOnServer, splitInApp]) {
    assert.deepEqual(split("[cafe\u0301] [हिन्दी] [日本語] rest").tags, ["cafe\u0301", "हिन्दी", "日本語"]);
    assert.deepEqual(split("[\u0301cafe] rest").tags, []);
  }
});

test("the server parser follows the display rule", () => {
  assert.deepEqual(splitOnServer("[ backend ] [ recce ] [bug] Coverage opens a shot.\n\nMore text."), {
    tags: ["backend", "recce", "bug"], text: "Coverage opens a shot.\n\nMore text.", runLength: 28,
  });
  assert.deepEqual(splitOnServer("[ frontend ] [ tech-debt ]\nMake plan-intent atomic"), {
    tags: ["frontend", "tech-debt"], text: "Make plan-intent atomic", runLength: 26,
  });
  assert.deepEqual(splitOnServer("Fix [ bug ] in the cart").tags, []);
  assert.deepEqual(splitOnServer("[Bug] [bug] [ui] Title").tags, ["Bug", "ui"]);
});
