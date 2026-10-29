import assert from "node:assert/strict";
import test from "node:test";

import { createExecFileRunner, createThreadExecFile } from "../../../server/normalize/exec-file-runner.mjs";

const turn = () => new Promise((resolve) => setImmediate(resolve));
const node = (script, options = {}) => new Promise((resolve) => {
  const run = createThreadExecFile();
  run(process.execPath, ["-e", script], options, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
});

test("a command runs on a worker thread and returns its output, as text or as a Buffer", async () => {
  const text = await node("process.stdout.write(process.env.POMEGR_RUNNER_PROBE || '')", { encoding: "utf8", env: { ...process.env, POMEGR_RUNNER_PROBE: "env" } });
  assert.equal(text.error, null);
  assert.equal(text.stdout, "env");
  const bytes = await node("process.stdout.write('é')", { encoding: "buffer" });
  assert.ok(Buffer.isBuffer(bytes.stdout));
  assert.equal(bytes.stdout.toString("utf8"), "é");
});

test("a failing command keeps the exit code, the standard error, and a missing executable's code", async () => {
  const failed = await node("process.stderr.write('not a git repository'); process.exit(3)", { encoding: "utf8" });
  assert.equal(failed.error.code, 3);
  assert.equal(failed.stderr, "not a git repository");
  const missing = await new Promise((resolve) => createThreadExecFile()("pomegr-missing-executable", [], {}, (error) => resolve(error)));
  assert.equal(missing.code, "ENOENT");
});

test("a timed-out command reports that it was killed, and input reaches the command's standard input", async () => {
  const slow = await node("setTimeout(() => {}, 10000)", { timeout: 200 });
  assert.equal(slow.error.killed, true);
  const echoed = await node("process.stdin.pipe(process.stdout)", { encoding: "utf8", input: "{\"files\":[]}" });
  assert.equal(echoed.stdout, "{\"files\":[]}");
});

test("without a worker thread the command starts on the calling thread", async () => {
  let fellBack = false;
  const run = createThreadExecFile({
    createWorker() { throw new Error("no workers"); },
    fallback(file, args, options, callback) { fellBack = true; setImmediate(() => callback(null, "ok", "")); return { kill() {} }; },
  });
  const stdout = await new Promise((resolve) => run("git", [], {}, (error, out) => resolve(out)));
  assert.equal(fellBack, true);
  assert.equal(stdout, "ok");
});

test("a burst of commands starts one per event-loop turn, so other work runs between starts", async () => {
  const order = [];
  const runner = createExecFileRunner({
    execFile(file, args, options, callback) { order.push(`start ${args[0]}`); setImmediate(() => callback(null, `out ${args[0]}`, "")); },
  });
  const results = [];
  for (let index = 0; index < 4; index += 1) runner("git", [String(index)], {}, (error, stdout) => results.push(stdout));
  assert.deepEqual(order, [], "nothing starts in the caller's turn");
  for (let index = 0; index < 4; index += 1) {
    await turn();
    order.push(`turn ${index}`);
  }
  assert.deepEqual(order, ["start 0", "turn 0", "start 1", "turn 1", "start 2", "turn 2", "start 3", "turn 3"]);
  await turn();
  assert.deepEqual(results, ["out 0", "out 1", "out 2", "out 3"]);
});

test("at most the running limit of commands run at once, and a finished one lets the next start", async () => {
  const pending = [];
  let running = 0; let peak = 0;
  const runner = createExecFileRunner({
    maxRunning: 2,
    execFile(file, args, options, callback) {
      running += 1; peak = Math.max(peak, running);
      pending.push(() => { running -= 1; callback(null, "", ""); });
    },
  });
  let finished = 0;
  for (let index = 0; index < 5; index += 1) runner("git", [], {}, () => { finished += 1; });
  for (let index = 0; index < 5; index += 1) await turn();
  assert.equal(running, 2);
  while (pending.length) {
    pending.shift()();
    for (let index = 0; index < 3; index += 1) await turn();
  }
  assert.equal(peak, 2);
  assert.equal(finished, 5);
});

test("a command that cannot start reports its error and frees its slot; a cancelled waiting command never starts", async () => {
  const started = [];
  const runner = createExecFileRunner({
    maxRunning: 1,
    execFile(file, args, options, callback) {
      started.push(args[0]);
      if (args[0] === "bad") throw new Error("spawn failed");
      callback(null, "ok", "");
      return () => {};
    },
  });
  const results = [];
  runner("git", ["bad"], {}, (error) => results.push(error?.message));
  const cancel = runner("git", ["cancelled"], {}, (error) => results.push(error?.code));
  runner("git", ["good"], {}, (error, stdout) => results.push(stdout));
  cancel();
  for (let index = 0; index < 4; index += 1) await turn();
  assert.deepEqual(started, ["bad", "good"]);
  assert.deepEqual(results, ["ABORT_ERR", "spawn failed", "ok"]);
});
