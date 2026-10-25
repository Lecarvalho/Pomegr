import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const outputRoot = path.join(repositoryRoot, "outputs", "ia-t11");
  await mkdir(outputRoot, { recursive: true });
  const root = await mkdtemp(path.join(outputRoot, "fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "vinext", "dist"), { recursive: true });
  await writeFile(path.join(root, "scripts", "run-vinext.mjs"), await readFile(path.join(repositoryRoot, "scripts", "run-vinext.mjs")));
  await writeFile(path.join(root, "scripts", "production-build-lock.mjs"), await readFile(path.join(repositoryRoot, "scripts", "production-build-lock.mjs")));
  await writeFile(path.join(root, "node_modules", "vinext", "dist", "cli.js"), `
    const chunks = JSON.parse(process.env.TEST_CHUNKS || "[]");
    const output = Buffer.from(process.env.TEST_OUTPUT_B64 || "", "base64");
    process.stderr.write(Buffer.from(process.env.TEST_STDERR_B64 || "", "base64"));
    let offset = 0;
    let index = 0;
    const writeNext = () => {
      if (offset >= output.length) {
        process.exit(Number(process.env.TEST_EXIT_CODE || 0));
        return;
      }
      const length = chunks[index++] || output.length;
      process.stdout.write(output.subarray(offset, offset + length));
      offset += length;
      setTimeout(writeNext, 2);
    };
    writeNext();
  `);
  return root;
}

async function runFixture(root, { command = "dev", output = "", stderr = "", chunks, env = {}, exitCode = 0, tty = false } = {}) {
  let entrypoint = path.join(root, "scripts", "run-vinext.mjs");
  if (tty) {
    entrypoint = path.join(root, "tty-launcher.mjs");
    await writeFile(entrypoint, `
      import { pathToFileURL } from "node:url";
      const wrapper = ${JSON.stringify(path.join(root, "scripts", "run-vinext.mjs"))};
      Object.defineProperty(process.stdout, "isTTY", { value: true });
      process.argv = [process.execPath, wrapper, ${JSON.stringify(command)}];
      await import(pathToFileURL(wrapper).href);
    `);
  }
  const childEnv = { ...process.env };
  delete childEnv.POMEGR_DEV_REQUEST_LOG;
  delete childEnv.FORCE_COLOR;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...(tty ? [] : [command])], {
      cwd: root,
      env: {
        ...childEnv,
        ...env,
        TEST_OUTPUT_B64: Buffer.from(output).toString("base64"),
        TEST_STDERR_B64: Buffer.from(stderr).toString("base64"),
        TEST_CHUNKS: JSON.stringify(chunks || []),
        TEST_EXIT_CODE: String(exitCode),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderrChunks).toString() }));
  });
  assert.equal(result.signal, null, result.stderr);
  return result;
}

test("development request logging drops only completed 204 request lines and preserves exact other output", async (t) => {
  const root = await fixture(t);
  const output = [
    " \u001b[1mGET\u001b[0m /empty \u001b[32m204\u001b[0m in 2ms\r\n",
    " POST /created 201 in 3ms\n",
    " PATCH /redirect 302 in 4ms\n",
    " GET /missing 404 in 5ms\n",
    " GET /broken 500 in 6ms\n",
    "note: status 204 is expected\n",
    " GET /204 200 in 204ms\r\n",
    " GET /unicode 204 in 7ms\n",
    "tail stays without newline: café",
  ].join("");
  const splitAt = Buffer.byteLength(output.slice(0, output.indexOf("café"))) + Buffer.byteLength("caf") + 1;
  const result = await runFixture(root, { output, stderr: "stderr remains unchanged\n", chunks: [3, 1, 8, splitAt - 12] });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, [
    " POST /created 201 in 3ms\n",
    " PATCH /redirect 302 in 4ms\n",
    " GET /missing 404 in 5ms\n",
    " GET /broken 500 in 6ms\n",
    "note: status 204 is expected\n",
    " GET /204 200 in 204ms\r\n",
    "tail stays without newline: café",
  ].join(""));
  assert.equal(result.stderr, "stderr remains unchanged\n");
});

test("POMEGR_DEV_REQUEST_LOG=all restores every development output line", async (t) => {
  const root = await fixture(t);
  const output = " GET /empty 204 in 1ms\r\nhello\n";
  const result = await runFixture(root, { output, env: { POMEGR_DEV_REQUEST_LOG: "all" } });
  assert.equal(result.stdout, output);
});

test("non-development commands preserve output and exit status", async (t) => {
  const root = await fixture(t);
  const output = " GET /empty 204 in 1ms\n";
  const result = await runFixture(root, { command: "build", output, exitCode: 7 });
  assert.equal(result.stdout, output);
  assert.equal(result.code, 7);
});

test("development wrapper preserves configured FORCE_COLOR values and defaults it for a TTY", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "node_modules", "vinext", "dist", "cli.js"), `process.stdout.write(process.env.FORCE_COLOR || "missing")`);
  for (const value of [undefined, "0", "3"]) {
    const env = value === undefined ? {} : { FORCE_COLOR: value };
    const result = await runFixture(root, { env, tty: true });
    assert.equal(result.stdout, value ?? "1");
  }
  for (const value of ["0", "3"]) {
    const result = await runFixture(root, { env: { FORCE_COLOR: value } });
    assert.equal(result.stdout, value);
  }
});

test("filtered development output flushes its trailing fragment before preserving the exit code", async (t) => {
  const root = await fixture(t);
  const result = await runFixture(root, { output: "visible trailing fragment", exitCode: 9 });
  assert.equal(result.stdout, "visible trailing fragment");
  assert.equal(result.code, 9);
});

test("filtered development output drops an unterminated 204 request line", async (t) => {
  const root = await fixture(t);
  const result = await runFixture(root, { output: " GET /empty-final 204 in 8ms" });
  assert.equal(result.stdout, "");
});
