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
  "[ frontend ] [ tech-debt ]\n[ ui ]\nMake plan-intent consume atomic",
  "[a]\r\n[b]\t\n\n  [c]\nTitle",
  "[a]\r\n[b]\t\n  [c]\nTitle",
  "[ui]\n\n[TODO] write tests",
  "[ui]\n\n[x] one\n[x] two",
  "[ui]\n  \t\n[x] one",
  "[ui]\r\n\r\n[x] one",
  "[ui]  \n  [x] one",
  "[ui]\n\n",
  "[a] [b]\n\n\n[c] Title",
  "\u00a0[a] Title",
  "\ufeff[a] Title",
  "\u2003[a] Title",
  "\r[a] Title",
  "[a]\n[b] Title\n[c] more",
  "[a]\n[b]c\nTitle",
  "[a]\n[image]\nTitle",
  "[a]\n[needs design]\nTitle",
  "[Bug]\n[bug]\n[ui]\nTitle",
  `${MANY.replaceAll(" ", "\n")}\nTitle`,
  "[a]\n[b]",
  "[a]\n\n\n[b]\n\nTitle",
  "[a] [b]\n",
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
    tags: ["frontend", "tech-debt"], text: "Make plan-intent atomic", runLength: 27,
  });
  assert.deepEqual(splitOnServer("[ frontend ] [ tech-debt ]\n[ ui ]\nMake plan-intent consume atomic"), {
    tags: ["frontend", "tech-debt", "ui"], text: "Make plan-intent consume atomic", runLength: 34,
  });
  assert.deepEqual(titleOnServer("[ frontend ] [ tech-debt ]\n[ ui ]\nMake plan-intent consume atomic"), {
    tags: ["frontend", "tech-debt", "ui"], title: "Make plan-intent consume atomic", rest: "",
  });
  assert.deepEqual(titleOnServer("[a]\n[b]"), { tags: [], title: "[a] [b]", rest: "" });
  assert.deepEqual(titleOnServer("[ui]\n\n[TODO] write tests\nmore"), { tags: ["ui", "TODO"], title: "write tests", rest: "more" });
  assert.deepEqual(splitOnServer("[ui]\n\n[x] one\n[x] two"), { tags: ["ui", "x"], text: "one\n[x] two", runLength: 10 });
  assert.deepEqual(splitOnServer("[ frontend ] [ tech-debt ]\r\n\r\n[ test ] Make plan-intent").tags, ["frontend", "tech-debt", "test"]);
  assert.deepEqual(splitOnServer("[ frontend ] [ tech-debt ]\n \n[ test ] Make plan-intent").tags, ["frontend", "tech-debt", "test"]);
  assert.deepEqual(splitOnServer("[ui]\n[x] one").tags, ["ui", "x"]);
  assert.deepEqual(splitOnServer("Fix [ bug ] in the cart").tags, []);
  assert.deepEqual(splitOnServer("[Bug] [bug] [ui] Title").tags, ["Bug", "ui"]);
});
