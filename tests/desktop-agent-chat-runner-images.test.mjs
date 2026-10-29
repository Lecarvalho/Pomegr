import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { chatArguments, claudeUserLine, POMEGR_READ_TOOLS, runChatTurn } from "../desktop/runtime/agent-chat-runner.mjs";

const server = Object.freeze({
  command: "C:\\Program Files\\Pomegr\\Pomegr.exe",
  args: ["C:\\Program Files\\Pomegr\\resources\\app.asar.unpacked\\desktop\\workers\\agent-chat-mcp.cjs"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
});
const folder = "C:\\Users\\tester\\AppData\\Roaming\\Pomegr\\agent-chat\\repo-0123456789abcdef01234567\\images\\chat-0123456789ab";
const names = ["img-0123456789ab.png", "img-ba9876543210.jpg", "img-00000000000c.gif", "img-00000000000d.webp"];
const files = names.map((name) => `${folder}\\${name}`);
const READ_TOOL_ARGUMENT = POMEGR_READ_TOOLS.map((name) => `mcp__pomegr__${name}`);

const claudeBase = (mcp) => [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence", "--setting-sources", "", "--settings", '{"disableAllHooks":true,"autoMemoryEnabled":false}', "--strict-mcp-config", "--mcp-config", mcp,
  "--permission-mode", "dontAsk", "--tools", "Read,Grep,Glob", "--allowedTools", ["Read", "Grep", "Glob", ...READ_TOOL_ARGUMENT].join(","),
];
const codexBase = ["exec", "--json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--disable", "apps", "-c", 'approval_policy="never"', "-c", "features.prefer_mxc=true", "-c", 'windows.sandbox="elevated"'];
const codexServer = [
  "-c", `mcp_servers.pomegr.command=${JSON.stringify(server.command)}`,
  "-c", `mcp_servers.pomegr.args=[${JSON.stringify(server.args[0])}]`,
  "-c", 'mcp_servers.pomegr.env={ELECTRON_RUN_AS_NODE="1"}',
];

test("Claude gets the image folder as its last two arguments, and the files are not arguments at all", () => {
  const mcp = '{"mcpServers":{}}';
  assert.deepEqual(chatArguments("claude", null, null, { folder, files }), [...claudeBase(mcp), "--add-dir", folder]);
  assert.deepEqual(chatArguments("claude", "claude-opus-4-1[1m]", null, { folder, files: [] }), [...claudeBase(mcp), "--model", "claude-opus-4-1[1m]", "--add-dir", folder]);
  const withServer = chatArguments("claude", "claude-sonnet-4", server, { folder, files: [files[0]] });
  assert.deepEqual(withServer, [...claudeBase(JSON.stringify({ mcpServers: { pomegr: server } })), "--model", "claude-sonnet-4", "--add-dir", folder]);
  assert.deepEqual(withServer.slice(-2), ["--add-dir", folder]);
  for (const file of files) assert.equal(chatArguments("claude", null, null, { folder, files }).includes(file), false);
  assert.equal(chatArguments("claude", null, null, { folder, files }).includes("--image"), false);
});

test("Claude without images has exactly the arguments it had before", () => {
  const mcp = '{"mcpServers":{}}';
  assert.deepEqual(chatArguments("claude"), claudeBase(mcp));
  assert.deepEqual(chatArguments("claude", null, null, null), claudeBase(mcp));
  assert.equal(chatArguments("claude", null, null, { folder, files }).filter((argument) => argument === "--add-dir").length, 1);
});

test("Codex gets --image and the files after the stdin marker, and only when there are files", () => {
  assert.deepEqual(chatArguments("codex", null, null, { folder, files }), [...codexBase, "-", "--image", ...files]);
  assert.deepEqual(chatArguments("codex", "gpt-6-sol", server, { folder, files: [files[1]] }), [...codexBase, ...codexServer, "--model", "gpt-6-sol", "-", "--image", files[1]]);
  const args = chatArguments("codex", null, null, { folder, files });
  assert.ok(args.indexOf("-") < args.indexOf("--image"), "the flag takes a list, so it must not come before the marker");
  assert.equal(args.filter((argument) => argument === "--image").length, 1);
  assert.deepEqual(chatArguments("codex", null, null, { folder, files: [] }), [...codexBase, "-"], "a folder without files adds nothing for Codex");
  assert.equal(chatArguments("codex", null, null, { folder, files }).includes("--add-dir"), false);
});

test("Codex without images ends with the stdin marker", () => {
  assert.deepEqual(chatArguments("codex"), [...codexBase, "-"]);
  assert.deepEqual(chatArguments("codex", null, null, null), [...codexBase, "-"]);
  assert.equal(chatArguments("codex", null, server).at(-1), "-");
});

test("a POSIX folder and mixed separators are valid when they are absolute and plain", () => {
  const posix = "/home/tester/.config/Pomegr/agent-chat/repo-0123456789abcdef01234567/images/chat-0123456789ab";
  assert.deepEqual(chatArguments("claude", null, null, { folder: posix, files: [`${posix}/${names[0]}`] }).slice(-2), ["--add-dir", posix]);
  assert.deepEqual(chatArguments("codex", null, null, { folder: posix, files: [`${posix}/${names[0]}`] }).slice(-2), ["--image", `${posix}/${names[0]}`]);
  const forward = "C:/Users/tester/agent-chat/images/chat-0123456789ab";
  assert.deepEqual(chatArguments("claude", null, null, { folder: forward, files: [`${forward}/${names[1]}`] }).slice(-2), ["--add-dir", forward]);
});

const invalidImages = [
  ["no object", undefined], ["null", null], ["a string", folder], ["a number", 5], ["an array", [folder]], ["empty", {}], ["no folder", { files }],
  ["a number folder", { folder: 5, files }], ["an array folder", { folder: [folder], files }], ["empty folder", { folder: "", files: [] }],
  ["relative folder", { folder: "agent-chat\\images\\chat-0123456789ab", files: [] }], ["dot folder", { folder: ".", files: [] }], ["drive without root", { folder: "C:images\\chat", files: [] }],
  ["dot-dot folder", { folder: "C:\\Users\\..\\images\\chat-0123456789ab", files: [] }], ["dot-dot at the end", { folder: "C:\\Users\\tester\\..", files: [] }],
  ["dot segment", { folder: "C:\\Users\\.\\tester", files: [] }], ["posix dot-dot", { folder: "/home/../etc", files: [] }],
  ["a quote", { folder: 'C:\\Users\\te"ster\\images', files: [] }], ["a newline", { folder: `${folder}\n`, files: [] }], ["a tab", { folder: `${folder}\tx`, files: [] }],
  ["a NUL", { folder: `${folder}\u0000`, files: [] }], ["a carriage return", { folder: `C:\\Users\\a\rb`, files: [] }],
  ["a trailing separator", { folder: `${folder}\\`, files: [] }], ["a trailing slash", { folder: "/home/tester/images/", files: [] }], ["a root only", { folder: "C:\\", files: [] }],
  ["a file outside", { folder, files: ["C:\\Users\\tester\\Desktop\\img-0123456789ab.png"] }],
  ["a sibling folder with the same prefix", { folder, files: [`${folder}2\\img-0123456789ab.png`] }],
  ["a file in a subfolder", { folder, files: [`${folder}\\sub\\img-0123456789ab.png`] }],
  ["a file that goes up", { folder, files: [`${folder}\\..\\img-0123456789ab.png`] }],
  ["the folder itself", { folder, files: [folder] }], ["a folder with a separator", { folder, files: [`${folder}\\`] }],
  ["a wrong name", { folder, files: [`${folder}\\notes.png`] }], ["upper-case hex", { folder, files: [`${folder}\\img-0123456789AB.png`] }],
  ["a short ID", { folder, files: [`${folder}\\img-0123456789a.png`] }], ["a bad extension", { folder, files: [`${folder}\\img-0123456789ab.svg`] }],
  ["a jpeg extension", { folder, files: [`${folder}\\img-0123456789ab.jpeg`] }], ["a double extension", { folder, files: [`${folder}\\img-0123456789ab.png.exe`] }],
  ["no extension", { folder, files: [`${folder}\\img-0123456789ab`] }], ["a name with a space", { folder, files: [`${folder}\\img-0123456789ab.png `] }],
  ["a newline in the name", { folder, files: [`${folder}\\img-0123456789ab.png\n`] }], ["a flag", { folder, files: ["--dangerously-skip-permissions"] }],
  ["a number file", { folder, files: [5] }], ["a null file", { folder, files: [null] }], ["an array file", { folder, files: [[files[0]]] }],
  ["five files", { folder, files: [...files, `${folder}\\img-00000000000e.png`] }], ["a duplicate", { folder, files: [files[0], files[0]] }],
  ["one bad file among good ones", { folder, files: [files[0], `${folder}\\x.png`] }],
];

test("every invalid images value adds no image argument for either provider, whatever the model and server", () => {
  const plain = { claude: chatArguments("claude", "claude-opus-4-1", server), codex: chatArguments("codex", "gpt-6-sol", server) };
  for (const [label, images] of invalidImages) {
    assert.deepEqual(chatArguments("claude", "claude-opus-4-1", server, images), plain.claude, label);
    assert.deepEqual(chatArguments("codex", "gpt-6-sol", server, images), plain.codex, label);
    for (const provider of ["claude", "codex"]) {
      const args = chatArguments(provider, null, null, images);
      assert.equal(args.includes("--add-dir"), false, label);
      assert.equal(args.includes("--image"), false, label);
    }
  }
});

test("the files are never reordered, copied from another place, or passed on when the folder is invalid", () => {
  assert.deepEqual(chatArguments("codex", null, null, { folder, files: [files[3], files[0]] }).slice(-3), ["--image", files[3], files[0]]);
  const input = { folder, files: [...files] };
  const args = chatArguments("codex", null, null, input);
  input.files.length = 0;
  input.folder = "x";
  assert.deepEqual(args.slice(-5), ["--image", ...files], "later changes of the input do not change the arguments");
  const bad = chatArguments("codex", null, null, { folder: `${folder}\\..`, files });
  for (const file of files) assert.equal(bad.includes(file), false);
});

test("an unknown provider has no arguments, with or without images", () => {
  assert.equal(chatArguments("other", null, null, { folder, files }), chatArguments("other"));
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stdin = Object.assign(new EventEmitter(), { writes: [], write(data, encoding) { this.writes.push([data, encoding]); }, end(data, encoding) { if (data !== undefined) this.writes.push([data, encoding]); } });
  child.kill = () => true;
  return child;
}

test("runChatTurn builds the arguments with the images and keeps the prompt on stdin only", async () => {
  for (const [provider, executable] of [["claude", "C:\\Users\\tester\\.local\\bin\\claude.exe"], ["codex", "C:\\Users\\tester\\.local\\bin\\codex.exe"]]) {
    const spawns = [];
    const child = fakeChild();
    const turn = runChatTurn({
      spawn: (...call) => { spawns.push(call); return child; }, executable, provider, model: null, mcpServer: server, images: { folder, files },
      cwd: "C:\\Work\\repo", env: { PATH: "C:\\Windows" }, prompt: "SYNTHETIC-PROMPT 4711",
    });
    assert.deepEqual(spawns[0][1], chatArguments(provider, null, server, { folder, files }));
    assert.ok(spawns[0][1].includes(provider === "claude" ? "--add-dir" : "--image"));
    assert.equal(spawns[0][1].some((argument) => argument.includes("SYNTHETIC-PROMPT")), false);
    // Claude Code reads one stream-json user message line; Codex reads the text up to the end of stdin.
    assert.deepEqual(child.stdin.writes, [[provider === "claude" ? claudeUserLine("SYNTHETIC-PROMPT 4711") : "SYNTHETIC-PROMPT 4711", "utf8"]]);
    child.emit("close", 1);
    await turn.done;
  }
});

test("runChatTurn with an invalid images value starts the same run as without", async () => {
  const spawns = [];
  const child = fakeChild();
  const turn = runChatTurn({
    spawn: (...call) => { spawns.push(call); return child; }, executable: "C:\\bin\\claude.exe", provider: "claude", model: null, mcpServer: server, images: { folder: "relative", files },
    cwd: "C:\\Work\\repo", env: {}, prompt: "p",
  });
  assert.deepEqual(spawns[0][1], chatArguments("claude", null, server));
  child.emit("close", 1);
  await turn.done;
});
