import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { TASK_IMAGE_ACTIONS, TASK_IMAGE_LIMIT_BYTES, TASK_IMAGE_MEDIA_TYPES } from "../../../server/serving/task-image-routes.mjs";
import { buildTaskPrompt } from "../../../server/tasks/task-dispatch.mjs";
import { sniffImageType } from "../../../server/tasks/task-images.mjs";
import { TASK_ACTIONS, TASK_BOUNDS, TASK_IMAGE_TYPES, normalizeStoredImages, plainTaskText } from "../../../server/tasks/task-record.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { GATE_FACTS, removeDirectory } from "./queue-test-support.mjs";

const REPOSITORY = "repo-0123456789abcdef01234567";
const OTHER_REPOSITORY = "repo-fedcba987654321001234567";
const TOKEN = "m".repeat(40);
const ROOT = "C:\\Work\\SECRET-ROOT\\repo";
const withToken = { "x-pomegr-desktop-authorization": TOKEN };
const OCTETS = { ...withToken, "content-type": "application/octet-stream" };
const JSON_BODY = { ...withToken, "content-type": "application/json" };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const GIF = Buffer.from("GIF89a-pixels", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ", "latin1")]);
const SVG = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "utf8");

async function setup(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-images-"));
  const store = openTaskStore({ directory, now: () => 1_000_000 });
  const runtime = {
    resolveTaskStart: () => ({ root: ROOT, pluginReady: true }),
    resolveTaskGateFacts: () => GATE_FACTS,
  };
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, authorizationToken: TOKEN }));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  context.after(async () => {
    await new Promise((done) => server.close(done));
    store.close();
    await removeDirectory(directory);
  });
  const created = store.apply(REPOSITORY, "create", { text: "Match the SECRET-TASK-TEXT mock-up" });
  assert.equal(created.ok, true);
  return { store, directory, port: server.address().port, taskId: created.taskId };
}

function send(port, { method = "POST", path: requestPath, headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(bytes.toString("utf8")); } catch { /* bytes */ }
        resolve({ status: response.statusCode, headers: response.headers, bytes, json });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

const add = (env, bytes, { taskId = env.taskId, repositoryId = REPOSITORY, headers = OCTETS, imageId = null } = {}) =>
  send(env.port, { path: `/internal/tasks/image-add?repositoryId=${repositoryId}&taskId=${taskId}${imageId === null ? "" : `&imageId=${imageId}`}`, headers, body: bytes });
const withImage = (env, name, payload, repositoryId = REPOSITORY) =>
  send(env.port, { path: `/internal/tasks/image-${name}`, headers: JSON_BODY, body: JSON.stringify({ repositoryId, payload }) });
const imagesOf = (env) => env.store.readBoard(REPOSITORY).tasks.find((task) => task.id === env.taskId).images;
const filesOf = (env) => {
  const folder = path.join(env.directory, "images", REPOSITORY, env.taskId);
  return existsSync(folder) ? readdirSync(folder) : [];
};

test("the image bounds and types match the contract and the route's mirror", async () => {
  const contract = await import("../../../shared/task-contract.ts");
  assert.equal(TASK_BOUNDS.imagesPerTask, contract.TASK_BOUNDS.imagesPerTask);
  assert.equal(TASK_BOUNDS.imageBytes, contract.TASK_BOUNDS.imageBytes);
  assert.deepEqual([...TASK_IMAGE_TYPES], [...contract.TASK_IMAGE_TYPES]);
  assert.equal(TASK_IMAGE_LIMIT_BYTES, TASK_BOUNDS.imageBytes);
  assert.deepEqual(Object.keys(TASK_IMAGE_MEDIA_TYPES), [...TASK_IMAGE_TYPES]);
  // Images travel on their own routes: the renderer's action list does not grow.
  for (const action of TASK_IMAGE_ACTIONS) assert.equal(TASK_ACTIONS.includes(action), false);
});

test("the type comes from the bytes, and only the four raster formats are images", () => {
  assert.equal(sniffImageType(PNG), "png");
  assert.equal(sniffImageType(JPEG), "jpeg");
  assert.equal(sniffImageType(GIF), "gif");
  assert.equal(sniffImageType(WEBP), "webp");
  for (const bytes of [SVG, Buffer.alloc(0), Buffer.from("%PDF-1.7"), Buffer.from("RIFF0000WAVE", "latin1"), "PNG", null]) {
    assert.equal(sniffImageType(bytes), null);
  }
});

test("a stored list keeps only contract entries, once each, up to the bound", () => {
  const entry = (n, extra = {}) => ({ id: `img-${String(n).padStart(12, "0")}`, type: "png", bytes: 10, ...extra });
  assert.deepEqual(normalizeStoredImages([entry(1), entry(1), entry(2, { type: "svg" }), entry(3, { bytes: 0 }), { id: "../x", type: "png", bytes: 1 }, entry(4, { path: "C:\\x" })]),
    [entry(1), entry(4)]);
  assert.equal(normalizeStoredImages([1, 2, 3, 4, 5, 6].map((n) => entry(n))).length, TASK_BOUNDS.imagesPerTask);
  assert.deepEqual(normalizeStoredImages("nope"), []);
});

test("an image is attached, listed on the board without its bytes, read back, and removed", async (context) => {
  const env = await setup(context);
  assert.deepEqual(imagesOf(env), []);
  const added = await add(env, PNG);
  assert.equal(added.status, 200);
  assert.equal(added.headers["cache-control"], "no-store");
  assert.match(added.json.imageId, /^img-[0-9a-f]{12}$/u);
  assert.deepEqual(Object.keys(added.json), ["ok", "imageId"]);
  const { imageId } = added.json;
  assert.deepEqual(imagesOf(env), [{ id: imageId, type: "png", bytes: PNG.length }]);
  assert.deepEqual(filesOf(env), [`${imageId}.png`]);

  // The board names the image and never carries its bytes or where it is kept.
  const board = JSON.stringify(env.store.readBoard(REPOSITORY));
  assert.equal(board.includes(PNG.toString("base64")), false);
  assert.equal(board.includes(env.directory), false);
  assert.equal(board.includes("images\\"), false);

  const read = await withImage(env, "read", { taskId: env.taskId, imageId });
  assert.equal(read.status, 200);
  assert.equal(read.headers["content-type"], "image/png");
  assert.equal(read.headers["cache-control"], "no-store");
  assert.equal(read.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(read.bytes, PNG);

  const removed = await withImage(env, "remove", { taskId: env.taskId, imageId });
  assert.deepEqual(removed.json, { ok: true });
  assert.deepEqual(imagesOf(env), []);
  assert.deepEqual(filesOf(env), []);
  assert.deepEqual((await withImage(env, "read", { taskId: env.taskId, imageId })).json, { ok: false, error: "not_found" });
  assert.deepEqual((await withImage(env, "remove", { taskId: env.taskId, imageId })).json, { ok: false, error: "not_found" });
});

test("what is not an image, too large, or one too many is refused and leaves nothing behind", async (context) => {
  const env = await setup(context);
  for (const bytes of [SVG, Buffer.alloc(0), Buffer.from("plain text")]) {
    const response = await add(env, bytes);
    assert.equal(response.status, 400);
    assert.deepEqual(response.json, { ok: false, error: "invalid" });
  }
  const large = Buffer.concat([PNG, Buffer.alloc(TASK_BOUNDS.imageBytes)]);
  // The monitor answers 413 and closes without reading the rest, which the sender may see as a reset.
  const oversize = await add(env, large).catch((error) => ({ status: error?.code === "ECONNRESET" || error?.code === "EPIPE" ? 413 : 0 }));
  assert.equal(oversize.status, 413);
  assert.deepEqual(filesOf(env), []);

  for (const bytes of [PNG, JPEG, GIF, WEBP]) assert.equal((await add(env, bytes)).status, 200);
  assert.deepEqual(imagesOf(env).map((image) => image.type), ["png", "jpeg", "gif", "webp"]);
  const fifth = await add(env, PNG);
  assert.equal(fifth.status, 409);
  assert.deepEqual(fifth.json, { ok: false, error: "limit" });
  assert.equal(filesOf(env).length, TASK_BOUNDS.imagesPerTask);
});

test("the routes need the desktop token, exact inputs, and an existing task", async (context) => {
  const env = await setup(context);
  assert.equal((await add(env, PNG, { headers: { "content-type": "application/octet-stream" } })).status, 401);
  assert.equal((await send(env.port, { method: "GET", path: `/internal/tasks/image-read`, headers: withToken })).status, 401);
  assert.equal((await add(env, PNG, { headers: { ...OCTETS, origin: "http://127.0.0.1:3003" } })).status, 401);

  assert.deepEqual((await add(env, PNG, { taskId: "T-99" })).json, { ok: false, error: "not_found" });
  assert.equal((await add(env, PNG, { taskId: "..%2F..%2Fx" })).status, 400);
  assert.equal((await add(env, PNG, { repositoryId: "repo-short" })).status, 400);
  assert.equal((await add(env, PNG, { headers: JSON_BODY })).status, 400);
  assert.equal((await send(env.port, { path: `/internal/tasks/image-add?repositoryId=${REPOSITORY}&taskId=${env.taskId}&path=C:%5Cx`, headers: OCTETS, body: PNG })).status, 400);

  const { imageId } = (await add(env, PNG)).json;
  for (const payload of [{}, { taskId: env.taskId }, { taskId: env.taskId, imageId: "../secret" }, { taskId: env.taskId, imageId, path: "C:\\x" }, { taskId: "T-0", imageId }]) {
    for (const name of ["read", "remove"]) assert.deepEqual((await withImage(env, name, payload)).json, { ok: false, error: "invalid" });
  }
  // An image belongs to one task of one repository: another repository's request finds nothing.
  assert.deepEqual((await withImage(env, "read", { taskId: env.taskId, imageId }, OTHER_REPOSITORY)).json, { ok: false, error: "not_found" });
  assert.deepEqual(imagesOf(env).map((image) => image.id), [imageId]);
});

test("deleting a task removes its images, and a task number is never reused for them", async (context) => {
  const env = await setup(context);
  const { imageId } = (await add(env, PNG)).json;
  assert.equal(filesOf(env).length, 1);
  assert.equal(env.store.apply(REPOSITORY, "delete", { id: env.taskId }).ok, true);
  assert.deepEqual(filesOf(env), []);
  assert.deepEqual((await withImage(env, "read", { taskId: env.taskId, imageId })).json, { ok: false, error: "not_found" });
  const next = env.store.apply(REPOSITORY, "create", { text: "Another task" });
  assert.notEqual(next.taskId, env.taskId);
  assert.deepEqual(env.store.readBoard(REPOSITORY).tasks.find((task) => task.id === next.taskId).images, []);
});

test("a listed image whose file is gone or changed is not served and not handed to a session", async (context) => {
  const env = await setup(context);
  const kept = (await add(env, PNG)).json.imageId;
  const lost = (await add(env, JPEG)).json.imageId;
  const { rmSync } = await import("node:fs");
  rmSync(path.join(env.directory, "images", REPOSITORY, env.taskId, `${lost}.jpg`));
  assert.deepEqual((await withImage(env, "read", { taskId: env.taskId, imageId: lost })).json, { ok: false, error: "not_found" });
  const planned = await send(env.port, { path: "/internal/tasks/start-plan", headers: JSON_BODY, body: JSON.stringify({ repositoryId: REPOSITORY, payload: { id: env.taskId } }) });
  assert.equal(planned.status, 200);
  assert.deepEqual(planned.json.plan.images, [path.join(env.directory, "images", REPOSITORY, env.taskId, `${kept}.png`)]);
});

test("the start plan names the task's image files and the prompt lists them between fixed lines", async (context) => {
  const env = await setup(context);
  const ids = [(await add(env, PNG)).json.imageId, (await add(env, WEBP)).json.imageId];
  const planned = await send(env.port, { path: "/internal/tasks/start-plan", headers: JSON_BODY, body: JSON.stringify({ repositoryId: REPOSITORY, payload: { id: env.taskId } }) });
  const { plan } = planned.json;
  const folder = path.join(env.directory, "images", REPOSITORY, env.taskId);
  assert.deepEqual(plan.images, [path.join(folder, `${ids[0]}.png`), path.join(folder, `${ids[1]}.webp`)]);
  for (const file of plan.images) {
    assert.equal(path.isAbsolute(file), true);
    assert.deepEqual(readFileSync(file).subarray(0, 4), file.endsWith(".png") ? PNG.subarray(0, 4) : WEBP.subarray(0, 4));
  }
  const lines = plan.prompt.split("\n");
  const at = lines.indexOf("The task has 2 attached images. The task text shows where each belongs as [Image #n]. Read each one before you start:");
  assert.ok(at > 0);
  assert.deepEqual(lines.slice(at + 1, at + 3), plan.images.map((file, index) => `- [Image #${index + 1}] ${file}`));
  assert.equal(lines[at + 3], "Done when:");
});

test("a task without images has no image lines and an empty list in its plan", async (context) => {
  const env = await setup(context);
  const planned = await send(env.port, { path: "/internal/tasks/start-plan", headers: JSON_BODY, body: JSON.stringify({ repositoryId: REPOSITORY, payload: { id: env.taskId } }) });
  assert.deepEqual(planned.json.plan.images, []);
  assert.equal(planned.json.plan.prompt.includes("attached image"), false);
  const task = { id: "T-1", text: "x", doneWhen: { checks: [], own: null }, source: null };
  assert.equal(buildTaskPrompt(task), buildTaskPrompt(task, []));
  assert.ok(buildTaskPrompt(task, [{ id: "img-000000000001", file: "C:\\data\\img-000000000001.png" }])
    .includes("The task has 1 attached image. The task text shows where it belongs as [Image #1]. Read it before you start:\n- [Image #1] C:\\data\\img-000000000001.png"));
});

test("a marker in the task text reads as its image's number in the prompt, and as the plain word everywhere else", async (context) => {
  const env = await setup(context);
  const first = "img-00000000000a";
  const second = "img-00000000000b";
  const gone = "img-00000000000c";
  const text = `Make the header look like [image:${second}]\nnot like [image:${first}] or [image:${gone}].`;
  assert.equal(env.store.apply(REPOSITORY, "update", { id: env.taskId, text }).ok, true);
  // The renderer names the image before it is stored, so the text and the image agree on the ID.
  assert.deepEqual((await add(env, PNG, { imageId: first })).json, { ok: true, imageId: first });
  assert.deepEqual((await add(env, JPEG, { imageId: second })).json, { ok: true, imageId: second });
  assert.deepEqual(imagesOf(env).map((image) => image.id), [first, second]);
  const again = await add(env, PNG, { imageId: first });
  assert.equal(again.status, 409);
  assert.deepEqual(again.json, { ok: false, error: "conflict" });
  assert.equal((await add(env, PNG, { imageId: "../x" })).status, 400);
  assert.equal(filesOf(env).length, 2);

  const planned = await send(env.port, { path: "/internal/tasks/start-plan", headers: JSON_BODY, body: JSON.stringify({ repositoryId: REPOSITORY, payload: { id: env.taskId } }) });
  const { prompt, images } = planned.json.plan;
  assert.ok(prompt.includes("Make the header look like [Image #2]\nnot like [Image #1] or [image]."));
  assert.ok(prompt.includes(`- [Image #1] ${images[0]}`));
  assert.ok(prompt.includes(`- [Image #2] ${images[1]}`));
  assert.equal(prompt.includes("[image:"), false);

  // The board keeps the text as stored; GitHub would get the plain word, never an ID.
  assert.equal(env.store.readBoard(REPOSITORY).tasks.find((task) => task.id === env.taskId).text, text);
  assert.equal(env.store.issueDraft(REPOSITORY, env.taskId).text, "Make the header look like [image]\nnot like [image] or [image].");
  assert.equal(plainTaskText("no marker [image:nope] here"), "no marker [image:nope] here");
});

test("a store that cannot be used refuses an image write", async () => {
  const store = openTaskStore({ directory: "" });
  assert.deepEqual(store.addImage(REPOSITORY, { taskId: "T-1", bytes: PNG }), { ok: false, error: "conflict" });
  assert.deepEqual(store.readImage(REPOSITORY, { taskId: "T-1", imageId: "img-000000000001" }), { ok: false, error: "conflict" });
  store.close();
});
