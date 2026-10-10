import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  ISSUE_CREATE_TITLE_LIMIT, ISSUE_LIST_LIMIT, ISSUE_TASK_TEXT_LIMIT, createIssueReader, issueTitleOf, normalizeIssue, stripHiddenComments,
} from "../../../server/repository/issues.mjs";

const ROOT = "C:\\Work\\SECRET-ROOT\\repo";

function raw(overrides = {}) {
  return {
    number: 7, title: "Fix the parser", body: "It crashes.", state: "open", author_association: "MEMBER",
    updated_at: "2026-10-09T10:00:00Z", user: { login: "SECRET-LOGIN" }, html_url: "https://github.com/SECRET-OWNER/repo/issues/7",
    ...overrides,
  };
}

// A fake `gh` at the injected execFile seam. `answer(args, options)` returns `{ stdout }` or `{ error, stderr }`.
function fakeGh(answer) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const result = answer(args, options);
    setImmediate(() => (result.error ? callback(result.error, "", result.stderr ?? "") : callback(null, result.stdout, "")));
  };
  return { execFile, calls };
}

const failure = (stderr, code = 1) => ({ error: Object.assign(new Error(`Command failed: gh\n${stderr}`), { code }), stderr });
const missing = () => ({ error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }), stderr: "" });
const reader = (answer, options = {}) => {
  const gh = fakeGh(answer);
  return { gh, reader: createIssueReader({ execFile: gh.execFile, ...options }) };
};

// What `gh repo view --json nameWithOwner,...` answers: the one command that names the repository.
const REPO_VIEW_ARGS = ["repo", "view", "--json", "nameWithOwner,visibility,hasIssuesEnabled,viewerPermission"];
const VIEW = { nameWithOwner: "acme/widgets", visibility: "PRIVATE", hasIssuesEnabled: true, viewerPermission: "WRITE" };
const viewAnswer = (view = VIEW) => ({ stdout: JSON.stringify(view) });
// A fake `gh` that answers `repo view` with `options.view` (a value, or a ready failure) and every other call with `answer`.
const repoReader = (answer, { view = VIEW, viewFailure, ...options } = {}) => reader(
  (args, callOptions) => (args[0] === "repo" ? (viewFailure ?? viewAnswer(view)) : answer(args, callOptions)), options,
);

test("a pull request, a non-object, and an out-of-range number are not issues", () => {
  assert.equal(normalizeIssue(raw({ pull_request: { url: "x" } })), null);
  for (const value of [null, undefined, "issue", [], 5]) assert.equal(normalizeIssue(value), null);
  for (const number of [0, -1, 1.5, "7", 1_000_000_000, Number.NaN]) assert.equal(normalizeIssue(raw({ number })), null);
  assert.equal(normalizeIssue(raw({ title: 3 })), null);
  assert.equal(normalizeIssue(raw({ title: " \u0007\n " })), null);
});

test("a title is one bounded line", () => {
  const issue = normalizeIssue(raw({ title: "  Fix\tthe\r\n\u0001parser \u2028 now  " }));
  assert.equal(issue.title, "Fix the parser now");
  const long = normalizeIssue(raw({ title: "x".repeat(500) }));
  assert.equal(long.title.length, 200);
  // A cut never leaves half a surrogate pair.
  const emoji = normalizeIssue(raw({ title: `${"a".repeat(199)}\u{1F600}` }));
  assert.equal(emoji.title.isWellFormed(), true);
  assert.equal(emoji.title.length, 199);
  assert.equal(normalizeIssue(raw({ title: "bad \ud800 surrogate" })).title.isWellFormed(), true);
});

test("the author association maps to the fixed enum", () => {
  for (const [value, expected] of [["OWNER", "owner"], ["MEMBER", "member"], ["COLLABORATOR", "collaborator"], ["CONTRIBUTOR", "outsider"],
    ["FIRST_TIME_CONTRIBUTOR", "outsider"], ["NONE", "outsider"], ["SOMETHING_NEW", "outsider"], [undefined, "outsider"], [null, "outsider"], [7, "outsider"]]) {
    assert.equal(normalizeIssue(raw({ author_association: value })).authorAssociation, expected, String(value));
  }
});

test("updatedAt is an ISO instant or null", () => {
  assert.equal(normalizeIssue(raw()).updatedAt, "2026-10-09T10:00:00.000Z");
  assert.equal(normalizeIssue(raw({ updated_at: "not a date" })).updatedAt, null);
  assert.equal(normalizeIssue(raw({ updated_at: undefined })).updatedAt, null);
});

test("an issue carries exactly the contract keys and nothing of the author", () => {
  const issue = normalizeIssue(raw());
  assert.deepEqual(Object.keys(issue).toSorted(), ["authorAssociation", "body", "bodyTruncated", "characters", "digest", "hiddenComments", "number", "taskText", "title", "tooLong", "updatedAt"]);
  const text = JSON.stringify(issue);
  assert.ok(!text.includes("SECRET"));
});

test("hidden comments are counted, ranged by offset into the served body, and stripped from the task text", () => {
  const none = normalizeIssue(raw({ body: "Plain body." }));
  assert.deepEqual(none.hiddenComments, { count: 0, ranges: [] });
  assert.equal(none.taskText, "Fix the parser\n\nPlain body.");

  const single = normalizeIssue(raw({ body: "Before <!-- secret note --> after" }));
  assert.deepEqual(single.hiddenComments, { count: 1, ranges: [{ start: 7, end: 27 }] });
  assert.equal(single.body.slice(7, 27), "<!-- secret note -->");
  assert.equal(single.taskText, "Fix the parser\n\nBefore  after");
  assert.ok(!single.taskText.includes("secret note"));

  const body = "a<!--1-->b<!--2-->c";
  const multiple = normalizeIssue(raw({ body }));
  assert.equal(multiple.hiddenComments.count, 2);
  assert.deepEqual(multiple.hiddenComments.ranges.map(({ start, end }) => body.slice(start, end)), ["<!--1-->", "<!--2-->"]);
  assert.equal(multiple.taskText, "Fix the parser\n\nabc");

  const multiline = normalizeIssue(raw({ body: "x\n<!--\nline one\nline two\n-->\ny" }));
  assert.equal(multiline.hiddenComments.count, 1);
  assert.equal(multiline.taskText, "Fix the parser\n\nx\n\ny");
});

test("an unterminated comment runs to the end of the body and counts as one", () => {
  const issue = normalizeIssue(raw({ body: "Visible <!-- never closed\nhidden still" }));
  assert.equal(issue.hiddenComments.count, 1);
  assert.deepEqual(issue.hiddenComments.ranges, [{ start: 8, end: issue.body.length }]);
  assert.equal(issue.taskText, "Fix the parser\n\nVisible");
});

test("at most 64 ranges are reported while the count stays real, bounded at 1000", () => {
  const some = normalizeIssue(raw({ body: "<!--x-->".repeat(100) }));
  assert.equal(some.hiddenComments.count, 100);
  assert.equal(some.hiddenComments.ranges.length, 64);
  assert.equal(some.taskText, some.title);
  const many = normalizeIssue(raw({ body: "<!---->".repeat(1500) }));
  assert.equal(many.hiddenComments.count, 1000);
  assert.equal(many.hiddenComments.ranges.length, 64);
});

test("a body that is only hidden comments leaves the title as the task text", () => {
  const issue = normalizeIssue(raw({ body: "<!-- template -->\n\n" }));
  assert.equal(issue.taskText, "Fix the parser");
  assert.equal(issue.characters, "Fix the parser".length);
  assert.equal(normalizeIssue(raw({ body: null })).taskText, "Fix the parser");
});

test("stripHiddenComments matches the task text body and drops characters a task cannot hold", () => {
  assert.equal(stripHiddenComments("  a <!-- b --> c\u0007d  "), "a  cd");
  assert.equal(stripHiddenComments(undefined), "");
  const issue = normalizeIssue(raw({ body: "keep <!-- gone --> this\u001b[31m" }));
  assert.equal(issue.taskText, `${issue.title}\n\n${stripHiddenComments(issue.body)}`);
});

test("the digest is SHA-256 over the original title, a newline, and the original body, and changes with either", () => {
  const issue = normalizeIssue(raw({ title: "  Fix\tit  ", body: "Body <!-- c -->" }));
  assert.match(issue.digest, /^[0-9a-f]{64}$/u);
  assert.equal(issue.digest, crypto.createHash("sha256").update("  Fix\tit  \nBody <!-- c -->", "utf8").digest("hex"));
  assert.equal(normalizeIssue(raw({ title: "  Fix\tit  ", body: "Body <!-- c -->" })).digest, issue.digest);
  assert.notEqual(normalizeIssue(raw({ title: "  Fix\tit  ", body: "Body <!-- d -->" })).digest, issue.digest);
  assert.notEqual(normalizeIssue(raw({ title: "Fix it", body: "Body <!-- c -->" })).digest, issue.digest);
  assert.equal(normalizeIssue(raw({ title: "T", body: null })).digest, crypto.createHash("sha256").update("T\n", "utf8").digest("hex"));
});

test("tooLong flips between 4000 and 4001 characters of task text", () => {
  const title = "T";
  const fit = normalizeIssue(raw({ title, body: "b".repeat(ISSUE_TASK_TEXT_LIMIT - title.length - 2) }));
  assert.equal(fit.characters, 4000);
  assert.equal(fit.tooLong, false);
  const over = normalizeIssue(raw({ title, body: "b".repeat(ISSUE_TASK_TEXT_LIMIT - title.length - 1) }));
  assert.equal(over.characters, 4001);
  assert.equal(over.tooLong, true);
});

test("the preview body is bounded at 20000 characters and a cut body is always tooLong", () => {
  const exact = normalizeIssue(raw({ body: "b".repeat(20_000) }));
  assert.equal(exact.body.length, 20_000);
  assert.equal(exact.bodyTruncated, false);
  const over = normalizeIssue(raw({ body: "b".repeat(20_001) }));
  assert.equal(over.body.length, 20_000);
  assert.equal(over.bodyTruncated, true);
  assert.equal(over.tooLong, true);
  // Hidden comments hide most of a long body; the cut body is still too long to promote.
  const hidden = normalizeIssue(raw({ body: `<!--${"x".repeat(25_000)}-->ok` }));
  assert.equal(hidden.bodyTruncated, true);
  assert.equal(hidden.tooLong, true);
  assert.equal(hidden.hiddenComments.ranges[0].end, 20_000);
  assert.equal(hidden.characters, "Fix the parser\n\nok".length);
  // The digest covers the whole original body, not the cut one.
  assert.notEqual(normalizeIssue(raw({ body: `${"b".repeat(20_000)}x` })).digest, normalizeIssue(raw({ body: `${"b".repeat(20_000)}y` })).digest);
});

test("connection: connected, not signed in, and CLI missing, with no stderr leaving", async () => {
  const connected = reader(() => ({ stdout: "Logged in to github.com account SECRET-LOGIN" }));
  assert.equal(await connected.reader.connection(), "connected");
  assert.deepEqual(connected.gh.calls[0].args, ["auth", "status", "--hostname", "github.com"]);
  assert.equal(connected.gh.calls[0].file, "gh");

  assert.equal(await reader(() => missing()).reader.connection(), "cli_missing");
  assert.equal(await reader(() => failure("You are not logged into any GitHub hosts. SECRET-LOGIN")).reader.connection(), "not_signed_in");
  assert.equal(await reader(() => failure("boom", "ETIMEDOUT")).reader.connection(), "not_signed_in");
  const timedOut = Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM", code: null });
  assert.equal(await reader(() => ({ error: timedOut, stderr: "" })).reader.connection(), "not_signed_in");
  const throwing = createIssueReader({ execFile: () => { throw new Error("sync failure SECRET"); } });
  assert.equal(await throwing.connection(), "not_signed_in");
});

test("repositoryAccess maps visibility and capabilities", async () => {
  const view = (value) => reader(() => viewAnswer({ nameWithOwner: "acme/widgets", ...value }));
  const privateWrite = view({ visibility: "PRIVATE", hasIssuesEnabled: true, viewerPermission: "WRITE" });
  assert.deepEqual(await privateWrite.reader.repositoryAccess(ROOT), { visibility: "private", capabilities: ["read_issues", "create_issues"] });
  assert.deepEqual(privateWrite.gh.calls[0].args, REPO_VIEW_ARGS);
  assert.equal(privateWrite.gh.calls.length, 1);
  assert.equal(privateWrite.gh.calls[0].options.cwd, ROOT);

  assert.deepEqual(await view({ visibility: "PRIVATE", hasIssuesEnabled: true, viewerPermission: "READ" }).reader.repositoryAccess(ROOT),
    { visibility: "private", capabilities: ["read_issues"] });
  assert.deepEqual(await view({ visibility: "INTERNAL", hasIssuesEnabled: true, viewerPermission: "TRIAGE" }).reader.repositoryAccess(ROOT),
    { visibility: "private", capabilities: ["read_issues", "create_issues"] });
  assert.deepEqual(await view({ visibility: "PUBLIC", hasIssuesEnabled: true, viewerPermission: "READ" }).reader.repositoryAccess(ROOT),
    { visibility: "public", capabilities: ["read_issues", "create_issues"] });
  for (const permission of ["ADMIN", "MAINTAIN"]) {
    assert.deepEqual(await view({ visibility: "PRIVATE", hasIssuesEnabled: true, viewerPermission: permission }).reader.repositoryAccess(ROOT),
      { visibility: "private", capabilities: ["read_issues", "create_issues"] });
  }
  assert.deepEqual(await view({ visibility: "PUBLIC", hasIssuesEnabled: false, viewerPermission: "ADMIN" }).reader.repositoryAccess(ROOT),
    { visibility: "public", capabilities: ["issues_disabled"] });
  assert.deepEqual(await view({ visibility: "SOMETHING", hasIssuesEnabled: true, viewerPermission: "READ" }).reader.repositoryAccess(ROOT),
    { visibility: "unknown", capabilities: ["read_issues"] });
});

test("repositoryAccess answers no access for every failed read", async () => {
  const closed = { visibility: "unknown", capabilities: ["no_access"] };
  assert.deepEqual(await reader(() => failure("Could not resolve to a Repository SECRET")).reader.repositoryAccess(ROOT), closed);
  assert.deepEqual(await reader(() => missing()).reader.repositoryAccess(ROOT), closed);
  assert.deepEqual(await reader(() => ({ stdout: "not json" })).reader.repositoryAccess(ROOT), closed);
  assert.deepEqual(await reader(() => ({ stdout: "[]" })).reader.repositoryAccess(ROOT), closed);
  assert.deepEqual(await reader(() => ({ stdout: "{}" })).reader.repositoryAccess(ROOT), closed);
  assert.deepEqual(await reader(() => viewAnswer({ visibility: "PUBLIC", hasIssuesEnabled: true, viewerPermission: "ADMIN" })).reader.repositoryAccess(ROOT), closed);
  assert.deepEqual(await reader(() => viewAnswer()).reader.repositoryAccess(""), closed);
});

test("listOpenIssues reads the REST list, drops pull requests, and keeps at most 100", async () => {
  const list = [raw({ number: 1 }), raw({ number: 2, pull_request: {} }), raw({ number: 3, author_association: "NONE" })];
  const { reader: r, gh } = repoReader(() => ({ stdout: JSON.stringify(list) }));
  const result = await r.listOpenIssues(ROOT);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.issues.map((issue) => issue.number), [1, 3]);
  assert.equal(result.truncated, false);
  assert.equal(gh.calls.length, 2);
  assert.deepEqual(gh.calls[0].args, REPO_VIEW_ARGS);
  assert.deepEqual(gh.calls[1].args, ["api", "repos/acme/widgets/issues?state=open&per_page=100"]);
  assert.equal(gh.calls[1].options.cwd, ROOT);
  assert.equal(gh.calls[1].options.windowsHide, true);
  assert.equal(gh.calls[1].options.timeout, 8000);
  assert.equal(gh.calls[1].options.maxBuffer, 8 * 1024 * 1024);

  const full = Array.from({ length: ISSUE_LIST_LIMIT }, (_, index) => raw({ number: index + 1 }));
  const truncated = await repoReader(() => ({ stdout: JSON.stringify(full) })).reader.listOpenIssues(ROOT);
  assert.equal(truncated.issues.length, 100);
  assert.equal(truncated.truncated, true);
  const surplus = await repoReader(() => ({ stdout: JSON.stringify([...full, raw({ number: 101 })]) })).reader.listOpenIssues(ROOT);
  assert.equal(surplus.issues.length, 100);
  assert.equal(surplus.truncated, true);
  // A full page of pull requests is still a truncated read of the raw list.
  const prs = await repoReader(() => ({ stdout: JSON.stringify(full.map((item) => ({ ...item, pull_request: {} }))) })).reader.listOpenIssues(ROOT);
  assert.deepEqual(prs, { status: "ok", issues: [], truncated: true });
  assert.deepEqual(await repoReader(() => ({ stdout: "[]" })).reader.listOpenIssues(ROOT), { status: "ok", issues: [], truncated: false });
});

test("a private repository lists and reads issues like any other", async () => {
  const gh = fakeGh((args) => (args[0] === "repo"
    ? viewAnswer()
    : { stdout: JSON.stringify(args[1].endsWith("/issues/7") ? raw() : [raw()]) }));
  const r = createIssueReader({ execFile: gh.execFile });
  assert.equal((await r.repositoryAccess(ROOT)).visibility, "private");
  assert.equal((await r.listOpenIssues(ROOT)).issues.length, 1);
  assert.equal((await r.readIssue(ROOT, 7)).status, "ok");
});

test("every fixed list failure", async () => {
  const status = async (answer) => (await repoReader(answer).reader.listOpenIssues(ROOT));
  const empty = (value) => ({ status: value, issues: [], truncated: false });
  assert.deepEqual(await status(() => missing()), empty("cli_missing"));
  assert.deepEqual(await status(() => failure("gh: Bad credentials (HTTP 401)")), empty("not_signed_in"));
  assert.deepEqual(await status(() => failure("To get started with GitHub CLI, please run:  gh auth login")), empty("not_signed_in"));
  assert.deepEqual(await status(() => failure("gh: Not Found (HTTP 404)")), empty("no_access"));
  assert.deepEqual(await status(() => failure("gh: Resource not accessible (HTTP 403)")), empty("no_access"));
  assert.deepEqual(await status(() => failure("gh: Issues are disabled for this repo (HTTP 410)")), empty("issues_disabled"));
  assert.deepEqual(await status(() => failure("gh: Server Error (HTTP 502)")), empty("unavailable"));
  assert.deepEqual(await status(() => ({ error: Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }), stderr: "" })), empty("unavailable"));
  assert.deepEqual(await status(() => ({ error: Object.assign(new Error("maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), stderr: "" })), empty("unavailable"));
  assert.deepEqual(await status(() => ({ stdout: "{ not json" })), empty("unavailable"));
  assert.deepEqual(await status(() => ({ stdout: "{}" })), empty("unavailable"));
  // The cap is on each call's output: the repository answer fits, the list does not.
  const big = JSON.stringify([raw(), raw()]);
  assert.ok(JSON.stringify(VIEW).length < 300 && big.length > 300);
  assert.deepEqual(await repoReader(() => ({ stdout: "[]" }), { maxBytes: 300 }).reader.listOpenIssues(ROOT), { status: "ok", issues: [], truncated: false });
  assert.deepEqual(await repoReader(() => ({ stdout: big }), { maxBytes: 300 }).reader.listOpenIssues(ROOT), empty("unavailable"));
  assert.deepEqual(await repoReader(() => ({ stdout: "[]" })).reader.listOpenIssues(""), empty("unavailable"));
});

test("readIssue reads one issue by number", async () => {
  const { reader: r, gh } = repoReader(() => ({ stdout: JSON.stringify(raw()) }));
  const result = await r.readIssue(ROOT, 7);
  assert.equal(result.status, "ok");
  assert.equal(result.issue.number, 7);
  assert.equal(gh.calls.length, 2);
  assert.deepEqual(gh.calls[0].args, REPO_VIEW_ARGS);
  assert.deepEqual(gh.calls[1].args, ["api", "repos/acme/widgets/issues/7"]);
  assert.ok(gh.calls.every((call) => call.args.every((argument) => typeof argument === "string")));
});

test("readIssue answers not found for a closed issue, a pull request, and a mismatched number", async () => {
  const one = (value, number = 7) => repoReader(() => ({ stdout: JSON.stringify(value) })).reader.readIssue(ROOT, number);
  assert.deepEqual(await one(raw({ state: "closed" })), { status: "not_found", issue: null });
  assert.deepEqual(await one(raw({ pull_request: {} })), { status: "not_found", issue: null });
  assert.deepEqual(await one(raw({ number: 8 })), { status: "unavailable", issue: null });
  assert.deepEqual(await one([]), { status: "unavailable", issue: null });
});

test("every fixed single-read failure", async () => {
  const status = async (answer) => (await repoReader(answer).reader.readIssue(ROOT, 7));
  const none = (value) => ({ status: value, issue: null });
  assert.deepEqual(await status(() => missing()), none("cli_missing"));
  assert.deepEqual(await status(() => failure("gh: Bad credentials (HTTP 401)")), none("not_signed_in"));
  assert.deepEqual(await status(() => failure("gh: Not Found (HTTP 404)")), none("not_found"));
  assert.deepEqual(await status(() => failure("gh: Forbidden (HTTP 403)")), none("no_access"));
  assert.deepEqual(await status(() => failure("gh: Gone (HTTP 410)")), none("issues_disabled"));
  assert.deepEqual(await status(() => failure("something else")), none("unavailable"));
  assert.deepEqual(await status(() => ({ stdout: "nope" })), none("unavailable"));
  assert.deepEqual(await repoReader(() => ({ stdout: "{}" })).reader.readIssue("", 7), none("unavailable"));
});

test("the issue number is validated and never reaches a command unvalidated", async () => {
  for (const number of [0, -3, 1.5, "7", "7; rm -rf /", 1_000_000_000, null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { reader: r, gh } = repoReader(() => ({ stdout: JSON.stringify(raw()) }));
    assert.deepEqual(await r.readIssue(ROOT, number), { status: "not_found", issue: null }, String(number));
    assert.equal(gh.calls.length, 0, `${String(number)} must not start gh`);
  }
  const { reader: r, gh } = repoReader(() => ({ stdout: JSON.stringify(raw({ number: 999_999_999 })) }));
  assert.equal((await r.readIssue(ROOT, 999_999_999)).status, "ok");
  assert.equal(gh.calls[1].args[1], "repos/acme/widgets/issues/999999999");
});

test("every call uses an argument array and no shell, and the deadline and cap are configurable", async () => {
  const { reader: r, gh } = repoReader(() => ({ stdout: "[]" }), { timeoutMs: 1234, maxBytes: 4321 });
  await r.connection();
  await r.repositoryAccess(ROOT);
  await r.listOpenIssues(ROOT);
  await r.readIssue(ROOT, 3);
  // connection (1), access (1 repo view), list (repo view + api), read (repo view + api).
  assert.equal(gh.calls.length, 6);
  for (const call of gh.calls) {
    assert.equal(call.file, "gh");
    assert.ok(Array.isArray(call.args) && call.args.every((argument) => typeof argument === "string"));
    assert.ok(!Object.hasOwn(call.options, "shell"));
    assert.equal(call.options.timeout, 1234);
    assert.equal(call.options.maxBuffer, 4321);
    assert.equal(call.options.windowsHide, true);
  }
  // The connection check is not tied to a repository.
  assert.equal(gh.calls[0].options.cwd, undefined);
});

test("no result carries stderr, a path, a login, or a URL", async () => {
  const leaky = "gh: Not Found (HTTP 404) SECRET-STDERR C:\\Work\\SECRET-ROOT https://api.github.com/SECRET-URL SECRET-LOGIN";
  // The repository view fails, so list and read fail at the resolve step.
  const { reader: r } = reader((args) => (args[0] === "repo"
    ? failure(leaky)
    : args[1].includes("/issues/") ? failure(leaky) : { stdout: JSON.stringify([raw()]) }));
  const results = [await r.connection(), await r.repositoryAccess(ROOT), await r.listOpenIssues(ROOT), await r.readIssue(ROOT, 7)];
  const text = JSON.stringify(results);
  for (const secret of ["SECRET", "C:\\\\Work", "https://", "api.github.com"]) assert.ok(!text.includes(secret), secret);
  // The repository view works, the issue read fails, and the one list read holds a login and a URL in the raw object.
  const named = repoReader((args) => (args[1].includes("/issues/") ? failure(leaky) : { stdout: JSON.stringify([raw()]) })).reader;
  assert.equal((await named.listOpenIssues(ROOT)).issues.length, 1);
  const served = [await named.listOpenIssues(ROOT), await named.readIssue(ROOT, 7)];
  assert.deepEqual(served[1], { status: "not_found", issue: null });
  for (const secret of ["SECRET", "C:\\\\Work", "https://", "api.github.com"]) assert.ok(!JSON.stringify(served).includes(secret), secret);
});

// A fake `gh` whose child has a standard input, so the text a create sends can be read back. `repo view` is answered
// with `viewResult` (the repository the create is addressed to); every other call goes to `answer`.
function fakeCreateGh(answer, viewResult = viewAnswer()) {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    const call = { file, args, options, stdin: null };
    calls.push(call);
    const child = { stdin: { on() {}, end(text) { call.stdin = text; } } };
    const result = args[0] === "repo" ? viewResult : answer(args, options);
    setImmediate(() => (result.error ? callback(result.error, "", result.stderr ?? "") : callback(null, result.stdout, "")));
    return child;
  };
  return { execFile, calls };
}

test("issueTitleOf is the first line, one bounded line, never half a surrogate pair", () => {
  assert.equal(issueTitleOf("Fix the parser\n\nIt crashes.\nMore."), "Fix the parser");
  assert.equal(issueTitleOf("  \n  Padded\ttitle \r\nsecond"), "Padded title");
  assert.equal(issueTitleOf("Bell \u0007 and \u0001 control\u0000chars \u2028 end"), "Bell and control chars");
  assert.equal(issueTitleOf("a    b\t\t c"), "a b c");
  assert.equal(ISSUE_CREATE_TITLE_LIMIT, 120);
  assert.equal(issueTitleOf("x".repeat(500)), "x".repeat(120));
  assert.equal(issueTitleOf("x".repeat(120)), "x".repeat(120));
  const pair = issueTitleOf(`${"a".repeat(119)}\u{1F600} tail`);
  assert.equal(pair, "a".repeat(119));
  assert.equal(pair.isWellFormed(), true);
  assert.equal(issueTitleOf(`${"a".repeat(118)}\u{1F600}`), `${"a".repeat(118)}\u{1F600}`);
  assert.equal(issueTitleOf("bad \ud800 lone"), "bad \ufffd lone");
  for (const empty of ["", "   \n\t ", "\u0007\u0001", undefined, null, 7]) assert.equal(issueTitleOf(empty), "");
});

test("createIssue posts through gh api with the JSON on standard input and no task text in the arguments", async () => {
  const gh = fakeCreateGh(() => ({ stdout: JSON.stringify({ number: 91, html_url: "https://github.com/SECRET/repo/issues/91", user: { login: "SECRET-LOGIN" } }) }));
  const issues = createIssueReader({ execFile: gh.execFile });
  const title = "Title SECRET-TITLE";
  const body = "Body SECRET-BODY\nwith `shell` $(whoami) \"quotes\"";
  assert.deepEqual(await issues.createIssue(ROOT, { title, body }), { status: "ok", number: 91 });
  // The repository is named first, with the same command the access read uses; the POST goes only to that repository.
  assert.equal(gh.calls.length, 2);
  assert.deepEqual(gh.calls[0].args, REPO_VIEW_ARGS);
  assert.equal(gh.calls[0].stdin, null);
  const call = gh.calls[1];
  assert.equal(call.file, "gh");
  assert.deepEqual(call.args, ["api", "--method", "POST", "repos/acme/widgets/issues", "--input", "-"]);
  assert.ok(!JSON.stringify(call.args).includes("SECRET"));
  assert.deepEqual(JSON.parse(call.stdin), { title, body });
  assert.equal(call.options.cwd, ROOT);
  assert.equal(call.options.timeout, 20_000);
  assert.equal(call.options.env.GH_PROMPT_DISABLED, "1");
});

test("createIssue maps every failure to one fixed status and keeps the CLI's message to itself", async () => {
  const cases = [
    [missing(), "cli_missing"],
    [failure("gh: HTTP 401: Bad credentials"), "not_signed_in"],
    [failure("To get started with GitHub CLI, please run:  gh auth login"), "not_signed_in"],
    [failure("gh: Issues are disabled for this repo (HTTP 410)"), "issues_disabled"],
    [failure("gh: Not Found (HTTP 404)"), "no_access"],
    [failure("gh: Resource not accessible (HTTP 403)"), "no_access"],
    [failure("gh: Validation Failed (HTTP 422)"), "failed"],
    [failure("gh: server error (HTTP 502)"), "failed"],
    [failure("something odd C:\secret\path"), "failed"],
    [{ error: Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }), stderr: "" }, "failed"],
  ];
  for (const [answer, expected] of cases) {
    const gh = fakeCreateGh(() => answer);
    const result = await createIssueReader({ execFile: gh.execFile }).createIssue(ROOT, { title: "t", body: "b" });
    assert.deepEqual(result, { status: expected, number: null });
    assert.ok(!JSON.stringify(result).includes("secret"));
  }
});

test("createIssue accepts only a valid issue number in an object answer", async () => {
  for (const stdout of ["", "not json", "[]", "null", "{}", '{"number":0}', '{"number":-1}', '{"number":1.5}', '{"number":"7"}', '{"number":1000000000}']) {
    const gh = fakeCreateGh(() => ({ stdout }));
    assert.deepEqual(await createIssueReader({ execFile: gh.execFile }).createIssue(ROOT, { title: "t", body: "b" }), { status: "failed", number: null }, stdout);
  }
  const gh = fakeCreateGh(() => ({ stdout: '{"number":999999999}' }));
  assert.deepEqual(await createIssueReader({ execFile: gh.execFile }).createIssue(ROOT, { title: "t", body: "b" }), { status: "ok", number: 999_999_999 });
});

test("createIssue refuses a missing root, title, or body before any process starts", async () => {
  const gh = fakeCreateGh(() => ({ stdout: '{"number":1}' }));
  const issues = createIssueReader({ execFile: gh.execFile });
  for (const [root, input] of [[undefined, { title: "t", body: "b" }], ["", { title: "t", body: "b" }], [ROOT, { title: "", body: "b" }], [ROOT, { title: "t", body: 3 }], [ROOT, { title: 3, body: "b" }]]) {
    assert.deepEqual(await issues.createIssue(root, input), { status: "failed", number: null });
  }
  assert.equal(gh.calls.length, 0);
});

test("a child without a standard input, or a throwing execFile, still ends in a fixed answer", async () => {
  const noStdin = createIssueReader({
    execFile: (file, args, options, callback) => { setImmediate(() => callback(null, args[0] === "repo" ? JSON.stringify(VIEW) : '{"number":3}', "")); },
  });
  assert.deepEqual(await noStdin.createIssue(ROOT, { title: "t", body: "b" }), { status: "ok", number: 3 });
  const throwing = createIssueReader({ execFile: () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); } });
  assert.deepEqual(await throwing.createIssue(ROOT, { title: "t", body: "b" }), { status: "cli_missing", number: null });
});

// The repository every call is addressed to: `gh repo view` names it once per call, and no call lets `gh api` fill
// `{owner}/{repo}` itself, because the CLI may resolve that placeholder by another rule than `repo view` (in a fork
// clone with an `upstream` remote the two can differ) and a create must go only to the repository whose access was read.

const okIssue = JSON.stringify(raw());
// Valid answers for every `api` call of the three chains.
const apiOk = (args) => (args.includes("POST") ? { stdout: '{"number":5}' } : { stdout: args[1].endsWith("/issues/7") ? okIssue : `[${okIssue}]` });
const chains = {
  list: (issues) => issues.listOpenIssues(ROOT),
  read: (issues) => issues.readIssue(ROOT, 7),
  create: (issues) => issues.createIssue(ROOT, { title: "t", body: "b" }),
};
const placeholderFree = (call) => !call.args.some((argument) => argument.includes("{owner}") || argument.includes("{repo}"));

test("list, read, and create each run repo view first and then address the api path to the repository it named", async () => {
  const expected = {
    list: "repos/acme/widgets/issues?state=open&per_page=100", read: "repos/acme/widgets/issues/7", create: "repos/acme/widgets/issues",
  };
  for (const [name, run] of Object.entries(chains)) {
    const gh = fakeCreateGh(apiOk);
    const result = await run(createIssueReader({ execFile: gh.execFile }));
    assert.equal(result.status, "ok", name);
    assert.equal(gh.calls.length, 2, name);
    assert.deepEqual(gh.calls[0].args, REPO_VIEW_ARGS, name);
    assert.equal(gh.calls[0].options.cwd, ROOT, name);
    assert.equal(gh.calls[1].args[0], "api", name);
    assert.ok(gh.calls[1].args.includes(expected[name]), name);
    assert.equal(gh.calls[1].options.cwd, ROOT, name);
    assert.ok(gh.calls.every(placeholderFree), name);
  }
});

test("the api path is built from what repo view answered, for any valid owner and name", async () => {
  const names = ["Some-Org/my.repo_x-y", "acme/.github", "a/b", "A.B_c-9/d.e", `${"a".repeat(100)}/${"b".repeat(100)}`];
  for (const nameWithOwner of names) {
    for (const [name, run] of Object.entries(chains)) {
      const gh = fakeCreateGh(apiOk, viewAnswer({ ...VIEW, nameWithOwner }));
      assert.equal((await run(createIssueReader({ execFile: gh.execFile }))).status, "ok", `${nameWithOwner} ${name}`);
      assert.equal(gh.calls.length, 2, `${nameWithOwner} ${name}`);
      assert.ok(gh.calls[1].args.some((argument) => argument.startsWith(`repos/${nameWithOwner}/issues`)), `${nameWithOwner} ${name}`);
    }
  }
});

test("an invalid or missing nameWithOwner is one fixed failure and no api call, so no create is ever sent", async () => {
  const invalid = [
    "acme/widgets/../x", "acme", "acme/", "/widgets", "", "acme/wid gets", "ac me/widgets", "acme/widgets\n", "acme\n/widgets",
    "\nacme/widgets", " acme/widgets", "acme/widgets ", "acme/widgets\r", "../widgets", "acme/..", "acme/.", "./widgets", "a..b/widgets",
    "acme/wid..gets", "a/b/c", "acme//widgets", "acme\\widgets", "acme/widgets?x=1", "acme/widgets#x", "acme/widgets;rm", "acme/$(whoami)",
    "acme/wid`x`gets", "{owner}/{repo}", "acme/wïdgets", "acme/wid\u0000gets", "acme/wid​gets", "acme/%2e%2e",
    `${"a".repeat(101)}/widgets`, `acme/${"b".repeat(101)}`, "https://github.com/acme/widgets", "github.com/acme/widgets/x",
    null, 7, undefined, ["acme", "widgets"], { owner: "acme", name: "widgets" },
  ];
  for (const nameWithOwner of invalid) {
    const label = JSON.stringify(nameWithOwner) ?? "undefined";
    const gh = fakeCreateGh(apiOk, viewAnswer({ ...VIEW, nameWithOwner }));
    const issues = createIssueReader({ execFile: gh.execFile });
    assert.deepEqual(await issues.listOpenIssues(ROOT), { status: "unavailable", issues: [], truncated: false }, label);
    assert.deepEqual(await issues.readIssue(ROOT, 7), { status: "unavailable", issue: null }, label);
    assert.deepEqual(await issues.createIssue(ROOT, { title: "t", body: "b" }), { status: "failed", number: null }, label);
    assert.deepEqual(await issues.repositoryAccess(ROOT), { visibility: "unknown", capabilities: ["no_access"] }, label);
    assert.equal(gh.calls.length, 4, label);
    assert.ok(gh.calls.every((call) => call.args[0] === "repo" && call.stdin === null), label);
  }
});

test("a failed repository read answers the status the following call would have and sends nothing", async () => {
  const cases = [
    [missing(), "cli_missing"],
    [failure("gh: HTTP 401: Bad credentials"), "not_signed_in"],
    [failure("To get started with GitHub CLI, please run:  gh auth login"), "not_signed_in"],
    [failure("gh: Issues are disabled for this repo (HTTP 410)"), "issues_disabled"],
    [failure("GraphQL: Could not resolve to a Repository with the name 'SECRET-OWNER/SECRET-NAME'. (repository)"), "no_access"],
    [failure("gh: Not Found (HTTP 404)"), "no_access"],
    [failure("gh: Resource not accessible (HTTP 403)"), "no_access"],
    [failure("none of the git remotes configured for this repository point to a known GitHub host"), "unavailable"],
    [failure("gh: Server Error (HTTP 502)"), "unavailable"],
    [{ error: Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }), stderr: "" }, "unavailable"],
    [{ stdout: "not json" }, "unavailable"],
    [{ stdout: "[]" }, "unavailable"],
    [{ stdout: "null" }, "unavailable"],
  ];
  for (const [answer, status] of cases) {
    const gh = fakeCreateGh(apiOk, answer);
    const issues = createIssueReader({ execFile: gh.execFile });
    assert.deepEqual(await issues.listOpenIssues(ROOT), { status, issues: [], truncated: false }, status);
    // A repository that cannot be read is never "this issue was not found".
    assert.deepEqual(await issues.readIssue(ROOT, 7), { status, issue: null }, status);
    assert.deepEqual(await issues.createIssue(ROOT, { title: "t", body: "b" }), { status: status === "unavailable" ? "failed" : status, number: null }, status);
    assert.equal(gh.calls.length, 3, status);
    assert.ok(gh.calls.every((call) => call.args[0] === "repo" && call.stdin === null), status);
    assert.ok(!JSON.stringify(await issues.repositoryAccess(ROOT)).includes("SECRET"), status);
  }
});

test("no result carries the owner or the name of the repository", async () => {
  const named = { ...VIEW, nameWithOwner: "SECRET-OWNER/SECRET-NAME" };
  const leaky = "gh: Not Found (HTTP 404) repos/SECRET-OWNER/SECRET-NAME/issues SECRET-STDERR";
  const keys = (value) => Object.keys(value).toSorted();
  for (const answer of [apiOk, () => failure(leaky)]) {
    const gh = fakeCreateGh(answer, viewAnswer(named));
    const issues = createIssueReader({ execFile: gh.execFile });
    const results = {
      access: await issues.repositoryAccess(ROOT),
      list: await issues.listOpenIssues(ROOT),
      read: await issues.readIssue(ROOT, 7),
      create: await issues.createIssue(ROOT, { title: "t", body: "b" }),
    };
    assert.deepEqual(keys(results.access), ["capabilities", "visibility"]);
    assert.deepEqual(keys(results.list), ["issues", "status", "truncated"]);
    assert.deepEqual(keys(results.read), ["issue", "status"]);
    assert.deepEqual(keys(results.create), ["number", "status"]);
    const text = JSON.stringify(results);
    for (const secret of ["SECRET", "OWNER", "NAME", "repos/"]) assert.ok(!text.includes(secret), secret);
    // The name was used to address the calls, and only there.
    const addressed = gh.calls.filter((call) => call.args[0] === "api");
    assert.equal(addressed.length, 3);
    assert.ok(addressed.every((call) => call.args.some((argument) => argument.startsWith("repos/SECRET-OWNER/SECRET-NAME/issues"))));
  }
});
