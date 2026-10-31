import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, REPO_A, agentMessage, conversationOf, harness, installHarness, newUser, proposalOf, removeHarness, setBridge, settle, userMessage } from "./agent-chat-fixture";
import { renderDock } from "./dock-helper";

vi.mock("next/navigation", async () => {
  const { harness } = await import("./agent-chat-fixture");
  return { usePathname: () => harness.pathname };
});
vi.mock("../../app/hooks/ClientAccessContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/hooks/ClientAccessContext")>();
  const { harness } = await import("./agent-chat-fixture");
  return { ...actual, useClientAccess: () => ({ mode: harness.mode, canCopyTranscriptPath: false, accessExpired: false, markAccessExpired() {}, async refreshAccess() {} }) };
});
vi.mock("../../app/tasks-store", async () => {
  const { harness } = await import("./agent-chat-fixture");
  return { useTasks: () => ({ board: harness.board, refresh: harness.refresh }) };
});
vi.mock("../../app/agents-client", async () => {
  const { harness } = await import("./agent-chat-fixture");
  return { useAgents: () => harness.agents };
});
vi.mock("../../app/repository-inventory-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/repository-inventory-client")>();
  const { harness } = await import("./agent-chat-fixture");
  return { ...actual, useRepositoryInventory: () => harness.inventory };
});

import { IMAGE_ADD_FAILURE_MESSAGE, IMAGE_LIMIT_MESSAGE, IMAGE_SIZE_MESSAGE, IMAGE_TYPE_MESSAGE } from "../../app/components/agent-chat/agent-chat-images";
import { UNREADABLE_PROPOSAL } from "../../app/components/agent-chat/agent-chat-presentation";

let chat: FakeChat;
let objectUrls = 0;
const revoke = vi.fn();
const urlApi = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const PNG_2 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3, 4, 5]);
const img = (n: number) => `img-${n.toString(16).padStart(12, "0")}`;
const pngFile = (bytes = PNG, name = "shot.png", type = "image/png") => new File([bytes.slice()], name, { type });
const bytesOf = (call: unknown[]) => Array.from((call[1] as { bytes: Uint8Array }).bytes);

beforeEach(() => {
  chat = installHarness();
  objectUrls = 0;
  revoke.mockClear();
  urlApi.createObjectURL = vi.fn(() => `blob:pomegr/${objectUrls += 1}`);
  urlApi.revokeObjectURL = revoke;
  if (typeof File.prototype.arrayBuffer !== "function") {
    Object.defineProperty(File.prototype, "arrayBuffer", {
      configurable: true,
      value(this: Blob) { return new Promise<ArrayBuffer>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.readAsArrayBuffer(this); }); },
    });
  }
});
afterEach(() => {
  removeHarness();
  delete urlApi.createObjectURL;
  delete urlApi.revokeObjectURL;
});

const user = newUser;
const field = () => screen.getByRole("textbox", { name: "Message Aril" });
const log = () => screen.getByRole("log", { name: "Conversation with Aril" });
const sendButton = () => screen.getByRole("button", { name: "Send" });
const attachButton = () => screen.getByRole("button", { name: "Attach image" });
const fileInput = () => attachButton().parentElement!.querySelector<HTMLInputElement>("input[type=file]")!;
const toSend = () => screen.queryByRole("list", { name: "Images to send" });
const added = () => chat.agentChatImage.mock.calls.filter(([operation]) => operation === "add");

async function openPanel() {
  const person = user();
  await person.click(screen.getByRole("button", { name: /^Open Aril, the Pomegr agent/ }));
  await settle();
  return person;
}

async function attach(...files: File[]) {
  fireEvent.change(fileInput(), { target: { files } });
  await settle();
}

describe("attaching images", () => {
  it("adds a picked image with the repository and the exact bytes, shows it, and sends its ID", async () => {
    await renderDock();
    const person = await openPanel();
    expect(attachButton()).toBeEnabled();
    await attach(pngFile());
    expect(added()).toHaveLength(1);
    expect(added()[0][1]).toMatchObject({ repositoryId: REPO_A });
    expect(bytesOf(added()[0])).toEqual(Array.from(PNG));
    const strip = screen.getByRole("list", { name: "Images to send" });
    expect(within(strip).getByRole("img", { name: "Image 1" })).toHaveAttribute("src", "blob:pomegr/1");
    await person.type(field(), "Look at this");
    await person.click(sendButton());
    await settle();
    expect(chat.calls("send")[0]).toMatchObject({ text: "Look at this", images: [img(1)] });
    expect(toSend()).toBeNull();
    const sent = within(log()).getByRole("list", { name: "Images you sent" });
    expect(within(sent).getByRole("img", { name: "Image 1" })).toHaveAttribute("src", "blob:pomegr/1");
    expect(chat.conversation(REPO_A, "chat-000000000101")?.messages[0].images).toEqual([{ id: img(1), type: "png", bytes: PNG.byteLength }]);
  });

  it("sends no images key for a message without images", async () => {
    await renderDock();
    const person = await openPanel();
    await person.type(field(), "No picture");
    await person.keyboard("{Enter}");
    await settle();
    expect(Object.keys(chat.calls("send")[0]!)).not.toContain("images");
    expect(within(log()).queryByRole("list", { name: "Images you sent" })).toBeNull();
  });

  it("adds an image pasted into the field and one dropped on the form, and ignores a paste without a file", async () => {
    await renderDock();
    await openPanel();
    fireEvent.paste(field(), { clipboardData: { files: [] } });
    await settle();
    expect(added()).toHaveLength(0);
    fireEvent.paste(field(), { clipboardData: { files: [pngFile()] } });
    await settle();
    fireEvent.drop(field().closest("form")!, { dataTransfer: { files: [pngFile(PNG_2, "drop.png"), new File(["x"], "notes.txt", { type: "text/plain" })], types: ["Files"] } });
    await settle();
    expect(added().map(bytesOf)).toEqual([Array.from(PNG), Array.from(PNG_2)]);
    expect(within(screen.getByRole("list", { name: "Images to send" })).getAllByRole("img").map((node) => node.getAttribute("alt"))).toEqual(["Image 1", "Image 2"]);
  });

  it("removes an attached image so it is not sent", async () => {
    await renderDock();
    const person = await openPanel();
    await attach(pngFile(), pngFile(PNG_2));
    await person.click(screen.getByRole("button", { name: "Remove image 1" }));
    expect(within(screen.getByRole("list", { name: "Images to send" })).getAllByRole("img")).toHaveLength(1);
    await person.type(field(), "Just one");
    await person.keyboard("{Enter}");
    await settle();
    expect(chat.calls("send")[0]).toMatchObject({ images: [img(2)] });
  });
});

describe("limits and refusals", () => {
  it.each([
    ["a file that is not an image", () => pngFile(PNG, "a.txt", "text/plain"), IMAGE_TYPE_MESSAGE],
    ["an empty file", () => pngFile(new Uint8Array(0)), IMAGE_SIZE_MESSAGE],
    ["a file over 5 MiB", () => { const file = pngFile(); Object.defineProperty(file, "size", { value: 5 * 1024 * 1024 + 1 }); return file; }, IMAGE_SIZE_MESSAGE],
  ])("refuses %s with a fixed line and no call to the desktop", async (_name, make, message) => {
    await renderDock();
    await openPanel();
    await attach(make());
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(chat.agentChatImage).not.toHaveBeenCalled();
    expect(toSend()).toBeNull();
  });

  it("holds at most four images and disables Attach image at four", async () => {
    await renderDock();
    await openPanel();
    await attach(pngFile(), pngFile(PNG_2), pngFile(), pngFile(PNG_2));
    expect(added()).toHaveLength(4);
    expect(attachButton()).toBeDisabled();
    await attach(pngFile());
    expect(screen.getByRole("alert")).toHaveTextContent(IMAGE_LIMIT_MESSAGE);
    expect(added()).toHaveLength(4);
    expect(within(screen.getByRole("list", { name: "Images to send" })).getAllByRole("img")).toHaveLength(4);
  });

  it.each([["invalid", IMAGE_TYPE_MESSAGE], ["unavailable", IMAGE_ADD_FAILURE_MESSAGE], ["not_found", IMAGE_ADD_FAILURE_MESSAGE]] as const)("shows the fixed line when the desktop answers %s", async (error, message) => {
    chat.refuseImage = error;
    await renderDock();
    await openPanel();
    await attach(pngFile());
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(toSend()).toBeNull();
  });

  it("disables Send and says Adding image while an upload is in flight", async () => {
    let release!: () => void;
    chat.holdImage = new Promise<void>((resolve) => { release = resolve; });
    await renderDock();
    const person = await openPanel();
    await person.type(field(), "Wait for it");
    expect(sendButton()).toBeEnabled();
    await attach(pngFile());
    expect(screen.getByText("Adding image…")).toHaveTextContent("Adding image…");
    expect(sendButton()).toBeDisabled();
    release();
    await settle();
    expect(screen.queryByText("Adding image…")).toBeNull();
    expect(sendButton()).toBeEnabled();
  });

  it("keeps the text and the images when the send is refused", async () => {
    chat.refuse = "busy";
    await renderDock();
    const person = await openPanel();
    await attach(pngFile());
    await person.type(field(), "Try me");
    await person.click(sendButton());
    await settle();
    expect(field()).toHaveValue("Try me");
    expect(within(screen.getByRole("list", { name: "Images to send" })).getByRole("img", { name: "Image 1" })).toBeInTheDocument();
    chat.refuse = null;
    await person.click(sendButton());
    await settle();
    expect(chat.calls("send").at(-1)).toMatchObject({ images: [img(1)] });
  });

  it("refuses a send that names an image the desktop does not know", async () => {
    expect(await chat.agentChat("send", { repositoryId: REPO_A, conversationId: null, text: "x", provider: "claude", model: null, images: [img(9)] })).toEqual({ ok: false, error: "invalid" });
  });
});

describe("stored images", () => {
  const sent = (...ids: string[]) => ({ ...userMessage("Look"), images: ids.map((id) => ({ id, type: "png", bytes: PNG.byteLength })) });
  const seed = (...ids: string[]) => {
    for (const id of ids) chat.storeImage(id, PNG);
    chat.seed(REPO_A, conversationOf(1, [sent(...ids), agentMessage("Seen")]));
  };
  const reads = () => chat.agentChatImage.mock.calls.filter(([operation]) => operation === "read").map(([, payload]) => payload);

  it("reads each image once, shows a pending frame first, then the picture, and revokes on unmount", async () => {
    seed(img(1), img(2));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const real = chat.agentChatImage.getMockImplementation()!;
    chat.agentChatImage.mockImplementation(async (operation, payload) => { await gate; return real(operation, payload); });
    const { unmount } = await renderDock();
    await openPanel();
    const strip = within(log()).getByRole("list", { name: "Images you sent" });
    expect(within(strip).getAllByRole("img").map((node) => node.tagName)).toEqual(["SPAN", "SPAN"]);
    release();
    await settle(1000);
    expect(within(strip).getAllByRole("img").map((node) => node.tagName)).toEqual(["IMG", "IMG"]);
    expect(reads()).toEqual([
      { repositoryId: REPO_A, conversationId: "chat-000000000001", imageId: img(1) },
      { repositoryId: REPO_A, conversationId: "chat-000000000001", imageId: img(2) },
    ]);
    expect(revoke).not.toHaveBeenCalled();
    unmount();
    expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual(["blob:pomegr/1", "blob:pomegr/2"]);
  });

  it("draws no picture for an image the desktop no longer holds", async () => {
    chat.seed(REPO_A, conversationOf(1, [sent(img(5)), agentMessage("Seen")]));
    await renderDock();
    await openPanel();
    expect(within(log()).getByRole("img", { name: "Image 1" }).tagName).toBe("SPAN");
    expect(reads()).toHaveLength(1);
  });

  it("answers a read only for an image that a message of the conversation names", async () => {
    chat.storeImage(img(1), PNG);
    chat.seed(REPO_A, conversationOf(1, [userMessage("No image")]));
    expect(await chat.agentChat("read", { repositoryId: REPO_A, conversationId: "chat-000000000001" })).toMatchObject({ ok: true });
    expect(await chat.agentChatImage("read", { repositoryId: REPO_A, conversationId: "chat-000000000001", imageId: img(1) })).toEqual({ ok: false, error: "not_found" });
  });

  it("keeps the text of a message whose image entry is malformed and drops only that image", async () => {
    chat.storeImage(img(1), PNG);
    chat.seed(REPO_A, conversationOf(1, [{ ...userMessage("Two entries"), images: [{ id: "bad", type: "png", bytes: 3 }, { id: img(1), type: "png", bytes: 10 }, { id: img(2), type: "bmp", bytes: 3 }] }, agentMessage("Ok")]));
    await renderDock();
    await openPanel();
    expect(within(log()).getByText("Two entries")).toBeInTheDocument();
    expect(within(within(log()).getByRole("list", { name: "Images you sent" })).getAllByRole("img")).toHaveLength(1);
  });
});

describe("images in proposals", () => {
  const owner = { ...userMessage("Here"), images: [img(1), img(2)].map((id) => ({ id, type: "png", bytes: PNG.byteLength })) };
  const open = async (operations: Record<string, unknown>[], extra: Record<string, unknown> = {}, state = "pending") => {
    chat.storeImage(img(1), PNG);
    chat.storeImage(img(2), PNG_2);
    chat.seed(REPO_A, conversationOf(1, [owner, agentMessage("Plan", { proposal: proposalOf(operations, state, extra) })]));
    await renderDock();
    await openPanel();
  };
  const rows = () => [...log().querySelectorAll(".agentChatOp")];

  it("draws a task created with an image: the detail part and the strip", async () => {
    await open([{ op: "create_task", text: "Fix the layout", images: [img(1)] }, { op: "create_task", text: "Fix both", images: [img(1), img(2)] }]);
    expect(rows()[0].querySelector(".agentChatOpDetail")).toHaveTextContent("with 1 image");
    expect(rows()[1].querySelector(".agentChatOpDetail")).toHaveTextContent("with 2 images");
    const strip = within(rows()[1] as HTMLElement).getByRole("list", { name: "Images for this task" });
    expect(within(strip).getAllByRole("img").map((node) => node.tagName)).toEqual(["IMG", "IMG"]);
  });

  it("draws Attach N images to a task with the strip", async () => {
    await open([{ op: "attach_images", id: "T-12", images: [img(1)] }, { op: "attach_images", id: "T-12", images: [img(1), img(2)] }]);
    expect(rows()[0].querySelector(".agentChatOpTitle")).toHaveTextContent("Attach 1 image to T-12");
    expect(rows()[1].querySelector(".agentChatOpTitle")).toHaveTextContent("Attach 2 images to T-12");
    expect(rows()[0].querySelector(".agentChatOpTitle code")).toHaveTextContent("T-12");
    expect(within(rows()[1] as HTMLElement).getAllByRole("img")).toHaveLength(2);
  });

  it("applies an attach and reports it done", async () => {
    await open([{ op: "attach_images", id: "T-12", images: [img(1)] }]);
    await user().click(screen.getByRole("button", { name: "Apply changes" }));
    await settle();
    expect(rows()[0]).toHaveTextContent("Done");
  });

  it.each([
    ["a task created whose images failed", { op: "create_task", text: "Fix", images: [img(1)] }, { ok: false, error: "limit", taskId: "T-19", part: "images" }, "Created T-19, but its images could not be attached"],
    ["limit", { op: "attach_images", id: "T-12", images: [img(1)] }, { ok: false, error: "limit", part: "images" }, "Not attached. A task holds at most 4 images."],
    ["conflict", { op: "attach_images", id: "T-12", images: [img(1)] }, { ok: false, error: "conflict", part: "images" }, "Not attached. This task has started, so it takes no image."],
    ["not_found", { op: "attach_images", id: "T-12", images: [img(1)] }, { ok: false, error: "not_found", part: "images" }, "Not attached. The image is no longer on this computer."],
    ["invalid", { op: "attach_images", id: "T-12", images: [img(1)] }, { ok: false, error: "invalid", part: "images" }, "Not attached. The image could not be read."],
    ["unavailable", { op: "attach_images", id: "T-12", images: [img(1)] }, { ok: false, error: "unavailable", part: "images" }, "Not attached. Pomegr did not answer."],
    ["another error", { op: "attach_images", id: "T-12", images: [img(1)] }, { ok: false, error: "unsupported", part: "images" }, "Not attached."],
  ])("reads the outcome for %s", async (_name, operation, result, line) => {
    await open([operation], { results: [result] }, "partial");
    expect(rows()[0].querySelector(".agentChatOpResult")?.textContent).toBe(line);
  });

  it("makes the proposal unreadable when attach_images names no images", async () => {
    await open([{ op: "attach_images", id: "T-12" }]);
    expect(screen.getByText(UNREADABLE_PROPOSAL)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
  });
});

describe("on a paired device", () => {
  const fetchMock = vi.fn();
  let readAnswer: () => Response;

  beforeEach(() => {
    setBridge(undefined);
    harness.mode = "lan";
    fetchMock.mockReset();
    readAnswer = () => new Response(PNG.slice(), { status: 200, headers: { "content-type": "image/png" } });
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const target = new URL(url, "http://x");
      if (target.pathname === "/api/agent-chat/image-add") {
        const bytes = await new Promise<Uint8Array>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer)); reader.readAsArrayBuffer(init.body as Blob); });
        return Response.json(await chat.agentChatImage("add", { repositoryId: target.searchParams.get("repositoryId"), bytes }));
      }
      if (target.pathname === "/api/agent-chat/image-read") return readAnswer();
      const body = JSON.parse(String(init.body)) as { operation: string; payload: Record<string, unknown> };
      return Response.json(await chat.agentChat(body.operation, body.payload));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  const imageCalls = (path: string) => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(path));

  it("posts an added image as octet-stream to the paired route", async () => {
    await renderDock();
    const person = await openPanel();
    await attach(pngFile());
    const [url, init] = imageCalls("/api/agent-chat/image-add")[0] as [string, RequestInit];
    expect(new URL(url, "http://x").searchParams.get("repositoryId")).toBe(REPO_A);
    expect(init).toMatchObject({ method: "POST", cache: "no-store" });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/octet-stream");
    expect(chat.agentChatImage.mock.calls.map(bytesOf)).toEqual([Array.from(PNG)]);
    expect(within(screen.getByRole("list", { name: "Images to send" })).getByRole("img", { name: "Image 1" })).toBeInTheDocument();
    await person.type(field(), "From the phone");
    await person.keyboard("{Enter}");
    await settle();
    expect(chat.calls("send")[0]).toMatchObject({ images: [img(1)] });
  });

  it("gets a stored image from the paired route and draws it", async () => {
    chat.storeImage(img(1), PNG);
    chat.seed(REPO_A, conversationOf(1, [{ ...userMessage("Look"), images: [{ id: img(1), type: "png", bytes: PNG.byteLength }] }, agentMessage("Seen")]));
    await renderDock();
    await openPanel();
    expect(imageCalls("/api/agent-chat/image-read")).toHaveLength(1);
    const [url, init] = imageCalls("/api/agent-chat/image-read")[0] as [string, RequestInit | undefined];
    const query = new URL(url, "http://x").searchParams;
    expect([query.get("repositoryId"), query.get("conversationId"), query.get("imageId")]).toEqual([REPO_A, "chat-000000000001", img(1)]);
    expect(init?.method ?? "GET").toBe("GET");
    expect(within(log()).getByRole("img", { name: "Image 1" }).tagName).toBe("IMG");
  });

  it.each([
    ["a JSON refusal", () => Response.json({ ok: false, error: "not_found" })],
    ["a non-image content type", () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["an error status", () => new Response(PNG.slice(), { status: 404, headers: { "content-type": "image/png" } })],
  ])("draws no picture for %s", async (_name, answer) => {
    readAnswer = answer;
    chat.storeImage(img(1), PNG);
    chat.seed(REPO_A, conversationOf(1, [{ ...userMessage("Look"), images: [{ id: img(1), type: "png", bytes: PNG.byteLength }] }, agentMessage("Seen")]));
    await renderDock();
    await openPanel();
    expect(imageCalls("/api/agent-chat/image-read")).toHaveLength(1);
    expect(within(log()).getByRole("img", { name: "Image 1" }).tagName).toBe("SPAN");
    expect(within(log()).queryByRole("img", { name: "Image 1" })?.tagName).not.toBe("IMG");
  });

  it("shows the unavailable line when the paired route does not answer", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (String(url).startsWith("/api/agent-chat/image-add")) throw new Error("offline");
      const body = JSON.parse(String(init.body)) as { operation: string; payload: Record<string, unknown> };
      return Response.json(await chat.agentChat(body.operation, body.payload));
    });
    await renderDock();
    await openPanel();
    await attach(pngFile());
    expect(screen.getByRole("alert")).toHaveTextContent(IMAGE_ADD_FAILURE_MESSAGE);
  });
});
