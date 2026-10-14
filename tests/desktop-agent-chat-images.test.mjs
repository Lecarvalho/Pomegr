import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AGENT_CHAT_IMAGE_CHANNEL, AGENT_CHAT_IMAGE_OPERATIONS, installAgentChatIpc } from "../desktop/runtime/agent-chat.mjs";
import {
  CHAT_IMAGE_FILE, CHAT_IMAGE_ID, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_TYPES, CHAT_IMAGES_PER_CONVERSATION, CHAT_IMAGES_PER_MESSAGE, conversationImages,
  createAgentChatImages, normalizeChatImages, sniffChatImageType, STAGED_IMAGE_LIMIT,
} from "../desktop/runtime/agent-chat-images.mjs";
import {
  addImage, chatHarness, finishTurn, gifBytes, jpegBytes, otherRepositoryId, pngBytes, repositoryId, seed, send, storedFiles, userMessage, webpBytes,
} from "./helpers/agent-chat-harness.mjs";

const invalid = { ok: false, error: "invalid" };
const conversationId = "chat-0123456789ab";
const EXTENSION = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp" };

async function temporaryDirectory(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pomegr-chat-images-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return directory;
}

/** The real file system, with a record of every method the module calls. */
function spyFilesystem() {
  const used = [];
  const spied = Object.fromEntries(Object.entries(fs).filter(([, value]) => typeof value === "function").map(([name, value]) => [name, (...args) => { used.push(name); return value(...args); }]));
  return { filesystem: spied, used };
}

const stagedFile = (directory, repository, image) => path.join(directory, repository, "images", "staged", `${image.id}.${EXTENSION[image.type]}`);
const claimedFile = (directory, repository, conversation, image) => path.join(directory, repository, "images", conversation, `${image.id}.${EXTENSION[image.type]}`);
const exists = (file) => fs.access(file).then(() => true, () => false);
const imageIds = (count, from = 0) => Array.from({ length: count }, (_, index) => `img-${(from + index).toString(16).padStart(12, "0")}`);

test("the constants are the contract: four types, four images per message, forty per conversation, 5 MiB, sixteen staged", () => {
  assert.deepEqual([...CHAT_IMAGE_TYPES], ["png", "jpeg", "gif", "webp"]);
  assert.equal(CHAT_IMAGES_PER_MESSAGE, 4);
  assert.equal(CHAT_IMAGES_PER_CONVERSATION, 40);
  assert.equal(CHAT_IMAGE_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(STAGED_IMAGE_LIMIT, 16);
  assert.ok(CHAT_IMAGE_ID.test("img-0123456789ab"));
  for (const bad of ["img-0123456789AB", "img-0123456789a", "img-0123456789abc", "IMG-0123456789ab", "img-0123456789ab\n", "../img-0123456789ab", ""]) assert.equal(CHAT_IMAGE_ID.test(bad), false, bad);
  for (const good of ["img-0123456789ab.png", "img-0123456789ab.jpg", "img-0123456789ab.gif", "img-0123456789ab.webp"]) assert.ok(CHAT_IMAGE_FILE.test(good), good);
  for (const bad of ["img-0123456789ab.jpeg", "img-0123456789ab.svg", "img-0123456789ab", "x/img-0123456789ab.png", "img-0123456789ab.png.exe"]) assert.equal(CHAT_IMAGE_FILE.test(bad), false, bad);
  assert.deepEqual([...AGENT_CHAT_IMAGE_OPERATIONS], ["add", "read"]);
  assert.equal(AGENT_CHAT_IMAGE_CHANNEL, "pomegr:agent-chat-image");
});

test("the runtime constants equal the ones of the shared contract", async () => {
  const source = await fs.readFile(new URL("../shared/agent-chat-contract.ts", import.meta.url), "utf8");
  assert.match(source, /AGENT_CHAT_IMAGE_OPERATIONS[^=]*=\s*\["add", "read"\]/u);
  assert.match(source, /imagesPerMessage:\s*4\b/u);
  assert.match(source, /imagesPerConversation:\s*40\b/u);
  assert.match(source, /imageBytes:\s*5 \* 1024 \* 1024/u);
  assert.match(source, /AGENT_CHAT_IMAGE_ID_PATTERN\s*=\s*\/\^img-\[0-9a-f\]\{12\}\$\/u/u);
  assert.match(source, /"group_tasks", "ungroup_tasks", "attach_images", "start_session", "set_queue"/u);
  assert.match(source, /part\?: "images"/u);
});

test("the type of an image comes from its leading bytes, never from a name", () => {
  assert.equal(sniffChatImageType(pngBytes()), "png");
  assert.equal(sniffChatImageType(jpegBytes()), "jpeg");
  assert.equal(sniffChatImageType(gifBytes()), "gif");
  assert.equal(sniffChatImageType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0])), "gif", "GIF87a");
  assert.equal(sniffChatImageType(webpBytes()), "webp");
  assert.equal(sniffChatImageType(Buffer.from(pngBytes())), "png", "a Buffer is bytes too");
  const none = [
    new Uint8Array(0), Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), Uint8Array.from([0xff, 0xd8]), Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x38, 0x61]),
    Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]), Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42]),
    new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), new TextEncoder().encode("%PDF-1.7"), new TextEncoder().encode("BM"),
  ];
  for (const bytes of none) assert.equal(sniffChatImageType(bytes), null);
  for (const value of ["png", null, undefined, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], new ArrayBuffer(8), 5]) assert.equal(sniffChatImageType(value), null);
});

test("a message's images are kept only as one to four unique { id, type, bytes } entries within the bound", () => {
  const one = { id: "img-0123456789ab", type: "png", bytes: 12 };
  assert.deepEqual(normalizeChatImages([one]), [one]);
  assert.deepEqual(normalizeChatImages([{ ...one, extra: "dropped" }]), [one], "an extra key is not kept");
  assert.equal(normalizeChatImages(imageIds(4).map((id) => ({ ...one, id }))).length, 4);
  assert.deepEqual(normalizeChatImages([{ ...one, bytes: CHAT_IMAGE_MAX_BYTES }]), [{ ...one, bytes: CHAT_IMAGE_MAX_BYTES }]);
  const refused = [
    undefined, null, "img", {}, [], imageIds(5).map((id) => ({ ...one, id })), [one, one], [null], ["img-0123456789ab"], [{ ...one, id: "img-x" }], [{ ...one, id: 5 }],
    [{ ...one, type: "svg" }], [{ ...one, type: "jpg" }], [{ ...one, bytes: 0 }], [{ ...one, bytes: -1 }], [{ ...one, bytes: 1.5 }], [{ ...one, bytes: "12" }], [{ ...one, bytes: CHAT_IMAGE_MAX_BYTES + 1 }],
    [{ id: "img-0123456789ab", type: "png" }],
  ];
  for (const value of refused) assert.equal(normalizeChatImages(value), null, JSON.stringify(value));
});

test("conversationImages lists the images of the owner's messages in order and nothing else", () => {
  const a = { id: "img-000000000001", type: "png", bytes: 3 };
  const b = { id: "img-000000000002", type: "gif", bytes: 4 };
  const messages = [{ ...userMessage(1), images: [a] }, { id: "m-2", role: "agent", text: "x", images: [{ id: "img-00000000000f", type: "png", bytes: 1 }] }, userMessage(3), { ...userMessage(4), images: [b] }];
  assert.deepEqual(conversationImages(messages), [a, b]);
  for (const value of [undefined, null, "x", {}, []]) assert.deepEqual(conversationImages(value), []);
});

test("stage keeps each of the four types under the repository's staged folder and answers { id, type, bytes }", async (context) => {
  const directory = await temporaryDirectory(context);
  const images = createAgentChatImages({ directory });
  for (const [type, bytes] of [["png", pngBytes()], ["jpeg", jpegBytes()], ["gif", gifBytes()], ["webp", webpBytes()]]) {
    const image = await images.stage(repositoryId, bytes);
    assert.deepEqual(image, { id: image.id, type, bytes: bytes.byteLength });
    assert.match(image.id, /^img-[0-9a-f]{12}$/u);
    const file = stagedFile(directory, repositoryId, image);
    assert.deepEqual(new Uint8Array(await fs.readFile(file)), bytes);
    assert.ok(CHAT_IMAGE_FILE.test(path.basename(file)));
  }
  assert.equal((await fs.readdir(path.join(directory, repositoryId, "images", "staged"))).length, 4);
  const first = await images.stage(repositoryId, pngBytes(1));
  const second = await images.stage(repositoryId, pngBytes(1));
  assert.notEqual(first.id, second.id, "the same bytes get two IDs");
  assert.equal((await images.stage(repositoryId, Buffer.from(pngBytes()))).type, "png", "a Buffer is accepted");
});

test("stage refuses bytes that are no image, empty, oversized, or not bytes, and writes nothing", async (context) => {
  const directory = await temporaryDirectory(context);
  const images = createAgentChatImages({ directory });
  const exactly = new Uint8Array(CHAT_IMAGE_MAX_BYTES);
  exactly.set(pngBytes());
  const tooBig = new Uint8Array(CHAT_IMAGE_MAX_BYTES + 1);
  tooBig.set(pngBytes());
  for (const bytes of [new Uint8Array(0), new TextEncoder().encode("<svg></svg>"), new TextEncoder().encode("GIF89"), tooBig, "png", null, undefined, [0x89, 0x50], new ArrayBuffer(16), {}]) {
    assert.equal(await images.stage(repositoryId, bytes), null);
  }
  assert.equal(await exists(path.join(directory, repositoryId)), false, "nothing was written");
  assert.equal((await images.stage(repositoryId, exactly)).bytes, CHAT_IMAGE_MAX_BYTES, "exactly 5 MiB is allowed");
});

test("claim moves the staged files into the conversation's folder and answers each image in order", async (context) => {
  const directory = await temporaryDirectory(context);
  const images = createAgentChatImages({ directory });
  const png = await images.stage(repositoryId, pngBytes(1));
  const jpeg = await images.stage(repositoryId, jpegBytes(2));
  const left = await images.stage(repositoryId, gifBytes(3));
  assert.deepEqual(await images.claim(repositoryId, conversationId, [jpeg.id, png.id]), [jpeg, png]);
  assert.equal(await exists(stagedFile(directory, repositoryId, png)), false);
  assert.equal(await exists(stagedFile(directory, repositoryId, jpeg)), false);
  assert.deepEqual(new Uint8Array(await fs.readFile(claimedFile(directory, repositoryId, conversationId, png))), pngBytes(1));
  assert.deepEqual(new Uint8Array(await fs.readFile(claimedFile(directory, repositoryId, conversationId, jpeg))), jpegBytes(2));
  assert.equal(await exists(stagedFile(directory, repositoryId, left)), true, "an image the message did not name stays staged");
  assert.equal(await images.claim(repositoryId, conversationId, [png.id]), null, "a claimed image is not staged any more");
  assert.equal(await images.claim(repositoryId, "chat-ffffffffffff", [left.id]).then((found) => found.length), 1, "another conversation may claim what is staged");
});

test("claim is all or nothing: one missing ID moves no file", async (context) => {
  const directory = await temporaryDirectory(context);
  const images = createAgentChatImages({ directory });
  const png = await images.stage(repositoryId, pngBytes());
  const gif = await images.stage(repositoryId, gifBytes());
  assert.equal(await images.claim(repositoryId, conversationId, [png.id, "img-aaaaaaaaaaaa", gif.id]), null);
  assert.equal(await exists(stagedFile(directory, repositoryId, png)), true);
  assert.equal(await exists(stagedFile(directory, repositoryId, gif)), true);
  assert.equal(await exists(path.join(directory, repositoryId, "images", conversationId)), false, "no folder was made");
  const other = await images.stage(otherRepositoryId, pngBytes());
  assert.equal(await images.claim(repositoryId, conversationId, [other.id]), null, "an image staged for another repository is not found");
});

test("claim refuses a list outside the contract and an emptied or oversized staged file", async (context) => {
  const directory = await temporaryDirectory(context);
  const images = createAgentChatImages({ directory });
  const png = await images.stage(repositoryId, pngBytes());
  for (const ids of [[], imageIds(5), [png.id, png.id], ["img-short"], [`${png.id}\n`], [`../${png.id}`], "img", null, undefined, [5]]) assert.equal(await images.claim(repositoryId, conversationId, ids), null, JSON.stringify(ids));
  await fs.writeFile(stagedFile(directory, repositoryId, png), new Uint8Array(0));
  assert.equal(await images.claim(repositoryId, conversationId, [png.id]), null, "an empty file is no image");
  await fs.writeFile(stagedFile(directory, repositoryId, png), new Uint8Array(CHAT_IMAGE_MAX_BYTES + 1));
  assert.equal(await images.claim(repositoryId, conversationId, [png.id]), null, "an oversized file is no image");
});

test("read answers the bytes only when the recorded size and type still match the file", async (context) => {
  const directory = await temporaryDirectory(context);
  const images = createAgentChatImages({ directory });
  const staged = await images.stage(repositoryId, webpBytes(4));
  const [image] = await images.claim(repositoryId, conversationId, [staged.id]);
  assert.deepEqual(await images.read(repositoryId, conversationId, image), webpBytes(4));
  assert.equal(await images.read(repositoryId, conversationId, { ...image, bytes: image.bytes + 1 }), null, "a size the message did not record");
  assert.equal(await images.read(repositoryId, conversationId, { ...image, type: "png" }), null, "a type the message did not record: no file of that name");
  assert.equal(await images.read(repositoryId, "chat-ffffffffffff", image), null, "another conversation's folder");
  for (const value of [null, undefined, "x", { id: image.id }, { ...image, id: "../x" }, { ...image, bytes: 0 }]) assert.equal(await images.read(repositoryId, conversationId, value), null);
  const file = claimedFile(directory, repositoryId, conversationId, image);
  await fs.writeFile(file, pngBytes(9).slice(0, image.bytes));
  assert.equal(await images.read(repositoryId, conversationId, image), null, "bytes of another type");
  await fs.rm(file);
  assert.equal(await images.read(repositoryId, conversationId, image), null, "a file that is gone");
});

test("files lists only the images that are still there with their recorded size, as absolute files", async (context) => {
  const directory = await temporaryDirectory(context);
  const images = createAgentChatImages({ directory });
  const claimed = await images.claim(repositoryId, conversationId, [(await images.stage(repositoryId, pngBytes())).id, (await images.stage(repositoryId, jpegBytes())).id, (await images.stage(repositoryId, gifBytes())).id]);
  const [png, jpeg, gif] = claimed;
  await fs.rm(claimedFile(directory, repositoryId, conversationId, jpeg));
  await fs.appendFile(claimedFile(directory, repositoryId, conversationId, gif), Uint8Array.of(1));
  const listed = await images.files(repositoryId, conversationId, [png, jpeg, gif, { id: "img-aaaaaaaaaaaa", type: "png", bytes: 3 }, null, { ...png, id: "../x" }]);
  assert.deepEqual(listed, [{ id: png.id, type: "png", file: claimedFile(directory, repositoryId, conversationId, png) }]);
  assert.ok(path.isAbsolute(listed[0].file));
  assert.equal(listed[0].file, path.join(images.folder(repositoryId, conversationId), `${png.id}.png`));
  assert.deepEqual(await images.files(repositoryId, conversationId, []), []);
  assert.deepEqual(await images.files(repositoryId, conversationId, "x"), []);
});

test("staged images are kept for the newest sixteen only", async (context) => {
  const directory = await temporaryDirectory(context);
  const images = createAgentChatImages({ directory });
  const oldest = await images.stage(repositoryId, pngBytes(1));
  const aged = new Date(Date.now() - 86_400_000);
  await fs.utimes(stagedFile(directory, repositoryId, oldest), aged, aged);
  const kept = [];
  for (let index = 0; index < STAGED_IMAGE_LIMIT; index += 1) kept.push(await images.stage(repositoryId, pngBytes(index + 2)));
  assert.equal((await fs.readdir(path.join(directory, repositoryId, "images", "staged"))).length, STAGED_IMAGE_LIMIT);
  assert.equal(await exists(stagedFile(directory, repositoryId, oldest)), false, "the oldest was removed");
  for (const image of kept) assert.equal(await exists(stagedFile(directory, repositoryId, image)), true);
  assert.equal(await images.claim(repositoryId, conversationId, [oldest.id]), null);
  const other = await images.stage(otherRepositoryId, pngBytes());
  assert.equal(await exists(stagedFile(directory, otherRepositoryId, other)), true, "the limit is for each repository");
});

test("removeConversation deletes that conversation's folder and nothing else", async (context) => {
  const directory = await temporaryDirectory(context);
  const images = createAgentChatImages({ directory });
  const [keep] = await images.claim(repositoryId, "chat-ffffffffffff", [(await images.stage(repositoryId, pngBytes())).id]);
  const [gone] = await images.claim(repositoryId, conversationId, [(await images.stage(repositoryId, pngBytes())).id]);
  const waiting = await images.stage(repositoryId, gifBytes());
  await images.removeConversation(repositoryId, conversationId);
  assert.equal(await exists(path.join(directory, repositoryId, "images", conversationId)), false);
  assert.equal(await exists(claimedFile(directory, repositoryId, conversationId, gone)), false);
  assert.equal(await exists(claimedFile(directory, repositoryId, "chat-ffffffffffff", keep)), true);
  assert.equal(await exists(stagedFile(directory, repositoryId, waiting)), true);
  await images.removeConversation(repositoryId, conversationId);
});

test("every method refuses a malformed repository or conversation ID without touching the disk", async (context) => {
  const directory = await temporaryDirectory(context);
  const { filesystem, used } = spyFilesystem();
  const images = createAgentChatImages({ directory, filesystem });
  const image = { id: "img-0123456789ab", type: "png", bytes: 11 };
  const badRepositories = ["../x", "repo-short", "repo-0123456789ABCDEF01234567", `${repositoryId}/..`, `${repositoryId}\n`, "", null, undefined, 5, ["x"]];
  for (const bad of badRepositories) {
    assert.equal(await images.stage(bad, pngBytes()), null);
    assert.equal(await images.claim(bad, conversationId, [image.id]), null);
    assert.equal(await images.read(bad, conversationId, image), null);
    assert.deepEqual(await images.files(bad, conversationId, [image]), []);
    assert.equal(images.folder(bad, conversationId), null);
    await images.removeConversation(bad, conversationId);
  }
  for (const bad of ["../x", "chat-short", "chat-0123456789AB", "..", ".", `${conversationId}/..`, "", null, 5]) {
    assert.equal(await images.claim(repositoryId, bad, [image.id]), null);
    assert.equal(await images.read(repositoryId, bad, image), null);
    assert.deepEqual(await images.files(repositoryId, bad, [image]), []);
    assert.equal(images.folder(repositoryId, bad), null);
    await images.removeConversation(repositoryId, bad);
  }
  assert.deepEqual(used, [], "no file system call was made");
  assert.throws(() => createAgentChatImages({ directory: "relative/dir" }), TypeError);
  assert.throws(() => createAgentChatImages(), TypeError);
});

test("chat.image add keeps an image for the next message and answers only its ID, type, and size", async (context) => {
  const h = await chatHarness(context);
  const bytes = jpegBytes(7);
  const answer = await h.image("add", { repositoryId, bytes });
  assert.deepEqual(answer, { ok: true, image: { id: answer.image.id, type: "jpeg", bytes: bytes.byteLength } });
  assert.deepEqual(Object.keys(answer.image).sort(), ["bytes", "id", "type"]);
  assert.deepEqual(new Uint8Array(await fs.readFile(stagedFile(h.directory, repositoryId, answer.image))), bytes);
  assert.deepEqual(storedFiles(h.directory), {}, "no conversation was made");
  assert.equal(h.calls.length, 0, "the monitor is not asked");
});

test("chat.image add refuses what is no image, an extra key, and a bad repository, and answers invalid", async (context) => {
  const h = await chatHarness(context);
  const good = pngBytes();
  const refused = [
    { repositoryId, bytes: new Uint8Array(0) }, { repositoryId, bytes: new TextEncoder().encode("hello") }, { repositoryId, bytes: "png" }, { repositoryId, bytes: [...good] },
    { repositoryId, bytes: good.buffer }, { repositoryId }, { bytes: good }, { repositoryId, bytes: good, name: "x.png" }, { repositoryId: "repo-x", bytes: good },
    { repositoryId: "../x", bytes: good }, { repositoryId, bytes: Object.assign(new Uint8Array(CHAT_IMAGE_MAX_BYTES + 1), { 0: 0x89 }) },
  ];
  for (const payload of refused) assert.deepEqual(await h.image("add", payload), invalid);
  for (const operation of ["erase", "", "ADD", "remove", "constructor", "__proto__", "toString", undefined, null, 5, ["add"]]) assert.deepEqual(await h.image(operation, { repositoryId, bytes: good }), invalid, String(operation));
  for (const payload of [null, undefined, "add", 5, [], new Map()]) assert.deepEqual(await h.image("add", payload), invalid);
  assert.deepEqual(storedFiles(h.directory), {});
  assert.equal(await exists(path.join(h.directory, repositoryId)), false, "nothing was written");
});

test("chat.image answers unavailable after dispose and without an image store", async (context) => {
  const h = await chatHarness(context);
  const image = await addImage(h);
  h.chat.dispose();
  assert.deepEqual(await h.image("add", { repositoryId, bytes: pngBytes() }), { ok: false, error: "unavailable" });
  assert.deepEqual(await h.image("read", { repositoryId, conversationId, imageId: image.id }), { ok: false, error: "unavailable" });
  const bare = await chatHarness(context, { store: null, images: null });
  assert.deepEqual(await bare.image("add", { repositoryId, bytes: pngBytes() }), { ok: false, error: "unavailable" });
});

test("send with images stores them on the owner's message, moves the files, lists them in the prompt, and gives the run the folder and the new files", async (context) => {
  const h = await chatHarness(context);
  const first = await addImage(h, pngBytes(1));
  const second = await addImage(h, webpBytes(2));
  const sent = await send(h, { images: [second.id, first.id] });
  assert.equal(sent.ok, true);
  const conversation = sent.conversationId;
  const stored = h.reload();
  const message = (await stored.read(repositoryId, conversation)).messages[0];
  assert.deepEqual(message, { id: "m-1", role: "user", text: "What should I do first?", at: message.at, images: [second, first] });
  const onDisk = h.runs[0].diskAtStart[`${repositoryId}/${conversation}.json`];
  assert.deepEqual(onDisk.conversation.messages[0].images, [second, first], "the message was stored before the run started");
  assert.equal(await exists(stagedFile(h.directory, repositoryId, first)), false);
  assert.equal(await exists(stagedFile(h.directory, repositoryId, second)), false);
  const folder = path.join(h.directory, repositoryId, "images", conversation);
  const files = [path.join(folder, `${second.id}.webp`), path.join(folder, `${first.id}.png`)];
  for (const file of files) assert.ok(await exists(file), file);
  const { prompt, images } = h.runs[0].options;
  assert.deepEqual(images, { folder, files });
  assert.ok(path.isAbsolute(images.folder));
  assert.match(prompt, new RegExp(`<images>\\n${second.id} \\(webp\\): ${files[0].replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")}\\n${first.id} \\(png\\): ${files[1].replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")}\\n</images>\\n\\n<owner_message>`, "u"));
  assert.match(prompt, new RegExp(`</owner_message>\\nImages attached to this message, in order: ${second.id}, ${first.id}\\.`, "u"));
  assert.equal(h.runs[0].options.provider, "claude");
});

test("send without images has no image section, no attached line, no images key, and gives the run no images", async (context) => {
  const h = await chatHarness(context);
  const sent = await send(h);
  assert.equal(sent.ok, true);
  const message = (await h.reload().read(repositoryId, sent.conversationId)).messages[0];
  assert.equal(Object.hasOwn(message, "images"), false);
  assert.equal(h.runs[0].options.images, null);
  assert.doesNotMatch(h.runs[0].options.prompt, /^<images>$|^Images attached to this message/mu);
  assert.equal(await exists(path.join(h.directory, repositoryId, "images")), false);
});

test("a later turn lists the earlier images in the prompt but gives the run only the new ones", async (context) => {
  const h = await chatHarness(context);
  const earlier = await addImage(h, pngBytes(1));
  const first = await send(h, { images: [earlier.id] });
  await finishTurn(h, h.runs[0], { status: "complete", text: "I see it." }, first.conversationId);
  const later = await addImage(h, gifBytes(2));
  assert.equal((await send(h, { conversationId: first.conversationId, text: "And this one?", images: [later.id] })).ok, true);
  const folder = path.join(h.directory, repositoryId, "images", first.conversationId);
  const { prompt, images } = h.runs[1].options;
  assert.deepEqual(images, { folder, files: [path.join(folder, `${later.id}.gif`)] });
  assert.ok(prompt.indexOf(`${earlier.id} (png): ${path.join(folder, `${earlier.id}.png`)}`) > prompt.indexOf("<images>"));
  assert.ok(prompt.includes(`${later.id} (gif): ${path.join(folder, `${later.id}.gif`)}`));
  assert.match(prompt, new RegExp(`\\[The owner attached this image: ${earlier.id}\\.\\]`, "u"), "the history says what the owner attached");
  assert.match(prompt, new RegExp(`Images attached to this message, in order: ${later.id}\\.$`, "u"));
  assert.equal(prompt.includes(`in order: ${earlier.id}`), false);
  const messages = (await h.reload().read(repositoryId, first.conversationId)).messages;
  assert.deepEqual(messages.map((entry) => entry.images), [[earlier], undefined, [later]]);
});

test("a later turn without new images still lists the earlier ones and gives the run none to attach", async (context) => {
  const h = await chatHarness(context);
  const earlier = await addImage(h);
  const first = await send(h, { images: [earlier.id] });
  await finishTurn(h, h.runs[0], { status: "complete", text: "Seen." }, first.conversationId);
  assert.equal((await send(h, { conversationId: first.conversationId, text: "Remind me what it showed." })).ok, true);
  const folder = path.join(h.directory, repositoryId, "images", first.conversationId);
  assert.deepEqual(h.runs[1].options.images, { folder, files: [] });
  assert.ok(h.runs[1].options.prompt.includes(`${earlier.id} (png)`));
  assert.doesNotMatch(h.runs[1].options.prompt, /^Images attached to this message/mu);
});

test("an image whose file is gone is not listed in the prompt, and not given to the run", async (context) => {
  const h = await chatHarness(context);
  const lost = await addImage(h, pngBytes(1));
  const kept = await addImage(h, pngBytes(5));
  const first = await send(h, { images: [lost.id, kept.id] });
  await finishTurn(h, h.runs[0], { status: "complete", text: "ok" }, first.conversationId);
  await fs.rm(claimedFile(h.directory, repositoryId, first.conversationId, lost));
  await send(h, { conversationId: first.conversationId, text: "Again" });
  assert.equal(h.runs[1].options.prompt.includes(`${lost.id} (png)`), false);
  assert.ok(h.runs[1].options.prompt.includes(`${kept.id} (png)`));
});

test("a staged image that is not there answers invalid, keeps no conversation, and starts no run", async (context) => {
  const h = await chatHarness(context);
  const staged = await addImage(h);
  assert.deepEqual(await send(h, { images: ["img-aaaaaaaaaaaa"] }), invalid);
  assert.deepEqual(await send(h, { images: [staged.id, "img-aaaaaaaaaaaa"] }), invalid);
  assert.deepEqual(storedFiles(h.directory), {}, "no conversation was kept");
  assert.deepEqual(await h.reload().list(repositoryId), []);
  assert.equal(h.runs.length, 0);
  assert.equal(await exists(stagedFile(h.directory, repositoryId, staged)), true, "the image that exists stays staged");
  assert.deepEqual((await fs.readdir(path.join(h.directory, repositoryId, "images"))).sort(), ["staged"], "no conversation folder is left");
  const sent = await send(h, { images: [staged.id] });
  assert.equal(sent.ok, true, "the chat is not left busy");
});

test("an unknown staged image on an existing conversation changes nothing in it", async (context) => {
  const h = await chatHarness(context);
  const conversation = await seed(h, { messages: [userMessage(1), { id: "m-2", role: "agent", text: "A", at: "2026-10-01T12:00:00.000Z", provider: "claude", model: null, status: "complete" }] });
  assert.deepEqual(await send(h, { conversationId: conversation.id, images: ["img-aaaaaaaaaaaa"] }), invalid);
  assert.equal((await h.reload().read(repositoryId, conversation.id)).messages.length, 2);
  assert.equal(h.runs.length, 0);
  assert.equal((await send(h, { conversationId: conversation.id })).ok, true, "the conversation is still usable");
});

test("images outside the contract answer invalid before anything is read or moved", async (context) => {
  const h = await chatHarness(context);
  const staged = await addImage(h);
  const five = imageIds(5);
  const refused = [[], five, [staged.id, staged.id], ["img-short"], [`${staged.id}\n`], [`../${staged.id}`], [staged.id.toUpperCase()], "img-0123456789ab", null, 5, {}, [null], [5], [[staged.id]]];
  for (const images of refused) assert.deepEqual(await send(h, { images }), invalid, JSON.stringify(images));
  assert.deepEqual(await send(h, { images: undefined }), invalid, "a present key must hold a list");
  assert.equal(h.calls.length, 0, "the monitor was not asked");
  assert.equal(h.runs.length, 0);
  assert.equal(await exists(stagedFile(h.directory, repositoryId, staged)), true);
  const extra = { repositoryId, conversationId: null, text: "x", provider: "claude", model: null, images: [staged.id], more: true };
  assert.deepEqual(await h.handle("send", extra), invalid);
});

test("a conversation takes at most forty images, and the refused message changes nothing", async (context) => {
  const h = await chatHarness(context);
  const record = (id) => ({ id, type: "png", bytes: 9 });
  const full = (count) => {
    const ids = imageIds(count);
    const messages = [];
    for (let index = 0; index < ids.length; index += 4) {
      messages.push({ ...userMessage(messages.length + 1), images: ids.slice(index, index + 4).map(record) });
      messages.push({ id: `m-${messages.length + 1}`, role: "agent", text: "A", at: "2026-10-01T12:00:00.000Z", provider: "claude", model: null, status: "complete" });
    }
    return messages;
  };
  const staged = await addImage(h);
  const atLimit = await seed(h, { messages: full(40) });
  assert.deepEqual(await send(h, { conversationId: atLimit.id, images: [staged.id] }), { ok: false, error: "limit" });
  assert.equal(await exists(stagedFile(h.directory, repositoryId, staged)), true, "the image stays staged");
  assert.equal((await h.reload().read(repositoryId, atLimit.id)).messages.length, 20);
  const below = await seed(h, { messages: full(39) });
  assert.equal((await send(h, { conversationId: below.id, images: [staged.id] })).ok, true, "the fortieth image is the last one allowed");
  assert.equal(conversationImages((await h.reload().read(repositoryId, below.id)).messages).length, 40);
});

test("read answers the bytes and type of an image that a message of the conversation names", async (context) => {
  const h = await chatHarness(context);
  const image = await addImage(h, jpegBytes(3));
  const sent = await send(h, { images: [image.id] });
  assert.deepEqual(await h.image("read", { repositoryId, conversationId: sent.conversationId, imageId: image.id }), { ok: true, type: "jpeg", bytes: jpegBytes(3) });
});

test("read of an image no message names answers not_found: staged, unnamed on disk, another conversation's, or an agent message's", async (context) => {
  const h = await chatHarness(context);
  const staged = await addImage(h, pngBytes(1));
  const named = await addImage(h, pngBytes(2));
  const one = await send(h, { images: [named.id] });
  await finishTurn(h, h.runs[0], { status: "complete", text: "ok" }, one.conversationId);
  const two = await seed(h, { messages: [userMessage(1)] });
  const read = (conversation, imageId) => h.image("read", { repositoryId, conversationId: conversation, imageId });
  const notFound = { ok: false, error: "not_found" };
  assert.deepEqual(await read(one.conversationId, staged.id), notFound, "a staged image no message has named");
  assert.deepEqual(await read(two.id, named.id), notFound, "another conversation's image");
  assert.deepEqual(await read("chat-ffffffffffff", named.id), notFound, "no such conversation");
  assert.deepEqual(await read(one.conversationId, "img-aaaaaaaaaaaa"), notFound);
  await fs.mkdir(path.join(h.directory, repositoryId, "images", two.id), { recursive: true });
  await fs.writeFile(path.join(h.directory, repositoryId, "images", two.id, `${staged.id}.png`), pngBytes(1));
  assert.deepEqual(await read(two.id, staged.id), notFound, "a file on disk that no message names is never served");
  await fs.rm(claimedFile(h.directory, repositoryId, one.conversationId, named));
  assert.deepEqual(await read(one.conversationId, named.id), notFound, "a named image whose file is gone");
});

test("read refuses a malformed request with invalid", async (context) => {
  const h = await chatHarness(context);
  const image = await addImage(h);
  const sent = await send(h, { images: [image.id] });
  const good = { repositoryId, conversationId: sent.conversationId, imageId: image.id };
  assert.equal((await h.image("read", good)).ok, true);
  for (const payload of [
    { ...good, extra: 1 }, { repositoryId, conversationId: good.conversationId }, { ...good, imageId: "img-x" }, { ...good, imageId: `../${image.id}` }, { ...good, imageId: 5 },
    { ...good, conversationId: "chat-x" }, { ...good, conversationId: "../x" }, { ...good, repositoryId: "repo-x" }, { ...good, repositoryId: "../x" }, {},
  ]) assert.deepEqual(await h.image("read", payload), invalid, JSON.stringify(payload));
  assert.deepEqual(await h.image("read", { ...good, repositoryId: otherRepositoryId }), { ok: false, error: "not_found" });
});

test("deleting a conversation removes its image folder and leaves the others and the staged images", async (context) => {
  const h = await chatHarness(context);
  const staged = await addImage(h, pngBytes(1));
  const image = await addImage(h, pngBytes(2));
  const sent = await send(h, { images: [image.id] });
  await finishTurn(h, h.runs[0], { status: "complete", text: "ok" }, sent.conversationId);
  const keepImage = await addImage(h, pngBytes(3));
  const kept = await seed(h, { messages: [{ ...userMessage(1), images: [keepImage] }] });
  await fs.mkdir(path.join(h.directory, repositoryId, "images", kept.id), { recursive: true });
  await fs.writeFile(claimedFile(h.directory, repositoryId, kept.id, keepImage), pngBytes(3));
  assert.deepEqual(await h.handle("delete", { repositoryId, conversationId: sent.conversationId }), { ok: true });
  assert.equal(await exists(path.join(h.directory, repositoryId, "images", sent.conversationId)), false);
  assert.equal(await exists(claimedFile(h.directory, repositoryId, kept.id, keepImage)), true);
  assert.equal(await exists(stagedFile(h.directory, repositoryId, staged)), true);
  assert.deepEqual(await h.image("read", { repositoryId, conversationId: sent.conversationId, imageId: image.id }), { ok: false, error: "not_found" });
});

test("a conversation is not deleted while its turn runs, and its images stay", async (context) => {
  const h = await chatHarness(context);
  const image = await addImage(h);
  const sent = await send(h, { images: [image.id] });
  assert.deepEqual(await h.handle("delete", { repositoryId, conversationId: sent.conversationId }), { ok: false, error: "busy" });
  assert.equal(await exists(claimedFile(h.directory, repositoryId, sent.conversationId, image)), true);
});

function fakeIpc() {
  const handlers = new Map();
  const order = [];
  return {
    handlers, order,
    ipcMain: {
      handle: (channel, handler) => { order.push(["handle", channel]); handlers.set(channel, handler); },
      removeHandler: (channel) => { order.push(["remove", channel]); handlers.delete(channel); },
    },
  };
}

test("the image channel answers a trusted frame through chat.image, refuses an untrusted one, and is removed on dispose", async () => {
  const { handlers, order, ipcMain } = fakeIpc();
  const calls = [];
  let disposed = 0;
  const answer = { ok: true, image: { id: "img-0123456789ab", type: "png", bytes: 3 } };
  const chat = { handle: async () => ({ ok: true }), image: async (...args) => { calls.push(args); return answer; }, dispose() { disposed += 1; } };
  const remove = installAgentChatIpc({ ipcMain, isTrustedEvent: (event) => event?.trusted === true, chat });
  assert.deepEqual([...handlers.keys()], ["pomegr:agent-chat", "pomegr:agent-chat-image"]);
  const call = handlers.get("pomegr:agent-chat-image");
  const payload = { repositoryId, bytes: pngBytes() };
  for (const event of [{}, undefined, null, { trusted: false }, "trusted"]) assert.deepEqual(await call(event, "add", payload), invalid);
  assert.equal(calls.length, 0, "an untrusted frame never reaches the chat");
  assert.deepEqual(await call({ trusted: true }, "add", payload), answer);
  assert.deepEqual(calls, [["add", payload]]);
  remove();
  assert.equal(handlers.size, 0);
  assert.equal(disposed, 1);
  assert.deepEqual(order.slice(-2), [["remove", "pomegr:agent-chat"], ["remove", "pomegr:agent-chat-image"]]);
});

test("the image channel answers unavailable when the chat has no image operation or it throws", async () => {
  for (const chat of [{ handle: async () => ({ ok: true }) }, { handle: async () => ({ ok: true }), image: async () => { throw new Error("C:\\private\\boom"); } }]) {
    const { handlers, ipcMain } = fakeIpc();
    installAgentChatIpc({ ipcMain, isTrustedEvent: () => true, chat });
    assert.deepEqual(await handlers.get("pomegr:agent-chat-image")({}, "add", { repositoryId }), { ok: false, error: "unavailable" });
  }
});

test("through the real controller the image channel stages and reads, and the chat channel refuses image operations", async (context) => {
  const h = await chatHarness(context);
  const { handlers, ipcMain } = fakeIpc();
  installAgentChatIpc({ ipcMain, isTrustedEvent: () => true, chat: h.chat });
  const added = await handlers.get("pomegr:agent-chat-image")({}, "add", { repositoryId, bytes: gifBytes() });
  assert.equal(added.ok, true);
  assert.equal(added.image.type, "gif");
  assert.deepEqual(await handlers.get("pomegr:agent-chat")({}, "add", { repositoryId, bytes: gifBytes() }), invalid, "bytes do not travel on the JSON channel");
});


async function loadPreload() {
  const invokes = [];
  let exposed;
  const Module = (await import("node:module")).default;
  const require = Module.createRequire(import.meta.url);
  const original = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "electron") {
      return {
        contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
        ipcRenderer: { invoke: (...args) => { invokes.push(args); return Promise.resolve({ ok: true, from: "main" }); } },
      };
    }
    return original.call(this, request, ...rest);
  };
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {} };
  try {
    const file = require.resolve("../desktop/runtime/preload.cjs");
    delete require.cache[file];
    require(file);
  } finally {
    Module._load = original;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  }
  return { exposed, invokes };
}

test("the preload bridge sends an image add only with exactly the repository and 1 byte to 5 MiB", async () => {
  const { exposed, invokes } = await loadPreload();
  assert.equal(typeof exposed.agentChatImage, "function");
  const good = { repositoryId, bytes: pngBytes() };
  class Holder { repositoryId = repositoryId; bytes = pngBytes(); }
  const refused = [
    { repositoryId, bytes: new Uint8Array(0) }, { repositoryId, bytes: new Uint8Array(CHAT_IMAGE_MAX_BYTES + 1) }, { repositoryId, bytes: "png" }, { repositoryId, bytes: [1, 2, 3] },
    { repositoryId, bytes: pngBytes().buffer }, { repositoryId, bytes: null }, { repositoryId }, { bytes: pngBytes() }, { ...good, name: "x.png" }, { ...good, conversationId: "chat-0123456789ab" },
    { repositoryId: "repo-short", bytes: pngBytes() }, { repositoryId: "../x", bytes: pngBytes() }, { repositoryId: `${repositoryId}\n`, bytes: pngBytes() }, { repositoryId: 5, bytes: pngBytes() },
    new Holder(), null, undefined, "add", 5, [], [good], new Map(), () => {},
  ];
  for (const payload of refused) assert.deepEqual(await exposed.agentChatImage("add", payload), invalid, String(payload));
  assert.equal(invokes.length, 0, "nothing reached the main process");
  assert.deepEqual(await exposed.agentChatImage("add", good), { ok: true, from: "main" });
  const exact = { repositoryId, bytes: new Uint8Array(CHAT_IMAGE_MAX_BYTES) };
  assert.deepEqual(await exposed.agentChatImage("add", exact), { ok: true, from: "main" });
  assert.deepEqual(invokes.map((call) => call.slice(0, 2)), [["pomegr:agent-chat-image", "add"], ["pomegr:agent-chat-image", "add"]]);
  assert.equal(invokes[0][2], good, "the payload is passed on as it is");
});

test("the preload bridge sends an image read only with exactly the repository, conversation, and image IDs", async () => {
  const { exposed, invokes } = await loadPreload();
  const good = { repositoryId, conversationId: "chat-0123456789ab", imageId: "img-0123456789ab" };
  const refused = [
    { ...good, extra: 1 }, { repositoryId, conversationId: good.conversationId }, { repositoryId, imageId: good.imageId }, { conversationId: good.conversationId, imageId: good.imageId },
    { ...good, conversationId: "chat-x" }, { ...good, conversationId: "../x" }, { ...good, conversationId: "chat-0123456789AB" }, { ...good, conversationId: 5 },
    { ...good, imageId: "img-x" }, { ...good, imageId: `${good.imageId}\n` }, { ...good, imageId: "../img-0123456789ab" }, { ...good, imageId: ["img-0123456789ab"] },
    { ...good, repositoryId: "repo-short" }, { ...good, bytes: pngBytes() }, {}, null, undefined, "read", [],
  ];
  for (const payload of refused) assert.deepEqual(await exposed.agentChatImage("read", payload), invalid, JSON.stringify(payload));
  assert.equal(invokes.length, 0);
  assert.deepEqual(await exposed.agentChatImage("read", good), { ok: true, from: "main" });
  const bare = Object.assign(Object.create(null), good);
  assert.deepEqual(await exposed.agentChatImage("read", bare), { ok: true, from: "main" });
  assert.deepEqual(invokes.map((call) => call.slice(0, 2)), [["pomegr:agent-chat-image", "read"], ["pomegr:agent-chat-image", "read"]]);
});

test("the preload bridge refuses every other image operation, and does not carry bytes on the chat channel", async () => {
  const { exposed, invokes } = await loadPreload();
  const add = { repositoryId, bytes: pngBytes() };
  const read = { repositoryId, conversationId: "chat-0123456789ab", imageId: "img-0123456789ab" };
  for (const operation of ["remove", "delete", "stage", "claim", "", " add", "ADD", "add ", "constructor", "__proto__", undefined, null, 5, ["add"]]) {
    assert.deepEqual(await exposed.agentChatImage(operation, add), invalid, String(operation));
    assert.deepEqual(await exposed.agentChatImage(operation, read), invalid, String(operation));
  }
  assert.deepEqual(await exposed.agentChatImage("add", read), invalid, "an add with the read payload");
  assert.deepEqual(await exposed.agentChatImage("read", add), invalid, "a read with the add payload");
  assert.deepEqual(await exposed.agentChat("add", add), invalid, "the JSON channel has no add operation");
  assert.equal(invokes.length, 0);
});

test("a missing conversation ID is refused like a malformed one, without throwing", async (context) => {
  const directory = await temporaryDirectory(context);
  const images = createAgentChatImages({ directory });
  const image = { id: "img-0123456789ab", type: "png", bytes: 11 };
  assert.deepEqual(await images.files(repositoryId, undefined, [image]), []);
  assert.equal(images.folder(repositoryId, undefined), null);
  await images.removeConversation(repositoryId, undefined);
  assert.equal(await images.claim(repositoryId, undefined, [image.id]), null);
});
