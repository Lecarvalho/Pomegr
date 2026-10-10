import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_BOUNDS, plainTaskText, taskImageIds, taskTextParts, type Task } from "../../shared/task-contract";

vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));

import { TaskModal } from "../../app/components/tasks/TaskModal";
import {
  TASK_IMAGE_CREATE_FAILURE_MESSAGE, TASK_IMAGE_LIMIT_MESSAGE, TASK_IMAGE_SIZE_MESSAGE, TASK_IMAGE_TYPE_MESSAGE, acceptImageFiles,
} from "../../app/components/tasks/task-images-desktop";
import { shownTaskText } from "../../app/components/tasks/use-task-images";

const repositoryId = "repo-0123456789abcdef01234567";
const STORED = "img-0123456789ab";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const board = { columns: [{ id: "col-000000000001", name: "Backlog", position: 0 }], features: [], tasks: [] };
const image = (name = "shot.png", type = "image/png", bytes: Uint8Array = PNG) => new File([bytes.slice()], name, { type });

const taskAction = vi.fn();
const taskImage = vi.fn();
const refresh = vi.fn(async () => {});
const onCreated = vi.fn();
const onIssueFailed = vi.fn();
const onChanged = vi.fn();
const onClose = vi.fn();
let urls = 0;

function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}

beforeEach(() => {
  urls = 0;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => `blob:pomegr/${urls += 1}`), revokeObjectURL: vi.fn() }));
  taskAction.mockResolvedValue({ ok: true, taskId: "T-9" });
  taskImage.mockImplementation(async (_repository: string, operation: string, payload: { imageId: string }) => (
    operation === "add" ? { ok: true, imageId: payload.imageId } : operation === "read" ? { ok: true, type: "png", bytes: PNG } : { ok: true }
  ));
  setBridge({ taskAction, taskImage });
});
afterEach(() => {
  setBridge(undefined);
  vi.clearAllMocks();
});

const renderNew = () => render(<TaskModal mode="new" repositoryId={repositoryId} repositoryName="Example" board={board} refresh={refresh}
  onCreated={onCreated} onIssueFailed={onIssueFailed} onClose={onClose} />);
const field = () => screen.getByRole("textbox", { name: "Task" });
const paste = (files: File[]) => fireEvent.paste(field(), { clipboardData: { files } });
/** Types at the end of the rich-text field the way a browser does: the text lands in the DOM, then `input` fires. */
function typeText(text: string) {
  field().append(text);
  // The caret follows what was typed.
  window.getSelection()?.selectAllChildren(field());
  window.getSelection()?.collapseToEnd();
  fireEvent.input(field());
}
const inlineImages = () => [...field().querySelectorAll("img")];
const calls = (operation: string) => taskImage.mock.calls.filter((call) => call[1] === operation);

function storedTask(text: string, images: Task["images"]): Task {
  return {
    id: "T-9", text, columnId: "col-000000000001", position: 0, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null }, state: "not_queued", scheduledAt: null,
    session: null, source: null, images, report: null, createdAt: "2026-10-10T10:00:00.000Z", updatedAt: "2026-10-10T10:00:00.000Z",
  };
}
const renderEdit = (task: Task) => render(<TaskModal mode="edit" repositoryId={repositoryId} repositoryName="Example" task={task} board={{ ...board, tasks: [task] }}
  refresh={refresh} onChanged={onChanged} onDeleted={vi.fn()} onClose={onClose} />);
const withImage = () => storedTask(`Match this: [image:${STORED}] exactly`, [{ id: STORED, type: "png", bytes: PNG.length }]);

describe("the image marker in task text", () => {
  it("names images in order, splits the text around them, and reads as a plain word elsewhere", () => {
    const text = `a [image:${STORED}] b [image:img-ffffffffffff][image:${STORED}]`;
    expect(taskImageIds(text)).toEqual([STORED, "img-ffffffffffff"]);
    expect(taskTextParts(text)).toEqual([{ text: "a " }, { imageId: STORED }, { text: " b " }, { imageId: "img-ffffffffffff" }, { imageId: STORED }]);
    expect(plainTaskText(text)).toBe("a [image] b [image][image]");
    expect(taskImageIds("[image:nope] [image:img-XYZ]")).toEqual([]);
  });

  it("shows every image the task holds and no marker of one it does not", () => {
    const images = [{ id: STORED, type: "png" as const, bytes: 1 }, { id: "img-00000000000b", type: "png" as const, bytes: 1 }];
    expect(shownTaskText(`x [image:${STORED}] y [image:img-00000000dead]`, images)).toBe(`x [image:${STORED}] y \n[image:img-00000000000b]`);
    expect(shownTaskText("plain", [])).toBe("plain");
  });
});

describe("which files may be attached", () => {
  it("takes the four formats within the size and count bounds and names the first reason for the rest", () => {
    const large = image("large.png", "image/png", new Uint8Array(TASK_BOUNDS.imageBytes + 1));
    expect(acceptImageFiles([image(), image("a.jpg", "image/jpeg"), image("a.gif", "image/gif"), image("a.webp", "image/webp")], 0).accepted).toHaveLength(4);
    expect(acceptImageFiles([image("a.svg", "image/svg+xml")], 0)).toEqual({ accepted: [], message: TASK_IMAGE_TYPE_MESSAGE });
    expect(acceptImageFiles([large], 0)).toEqual({ accepted: [], message: TASK_IMAGE_SIZE_MESSAGE });
    const overflow = acceptImageFiles([image(), image()], TASK_BOUNDS.imagesPerTask - 1);
    expect(overflow.accepted).toHaveLength(1);
    expect(overflow.message).toBe(TASK_IMAGE_LIMIT_MESSAGE);
  });
});

describe("New task", () => {
  it("draws a pasted image inline in the text and stores it under the ID the text names", async () => {
    const user = userEvent.setup();
    renderNew();
    typeText("Match the mock-up ");
    paste([image()]);
    const [inline] = inlineImages();
    expect(inline).toHaveAttribute("src", "blob:pomegr/1");
    expect(inline).toHaveAttribute("alt", "Image 1");
    // The image sits in the text, after what was typed.
    expect(field().firstChild?.textContent).toBe("Match the mock-up ");
    expect(taskImage).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const text = taskAction.mock.calls[0][2].text as string;
    const [imageId] = taskImageIds(text);
    expect(text).toBe(`Match the mock-up [image:${imageId}]`);
    expect(taskImage).toHaveBeenCalledTimes(1);
    const [repository, operation, payload] = taskImage.mock.calls[0];
    expect([repository, operation, payload.taskId, payload.imageId]).toEqual([repositoryId, "add", "T-9", imageId]);
    expect([...payload.bytes]).toEqual([...PNG]);
    expect(onIssueFailed).not.toHaveBeenCalled();
  });

  it("attaches picked and dropped files, and an image deleted from the text is never stored", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { container } = renderNew();
    typeText("Compare ");
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    expect(input).toHaveAttribute("accept", "image/png,image/jpeg,image/gif,image/webp");
    await user.upload(input, [image("a.png")]);
    fireEvent.drop(field(), { dataTransfer: { files: [image("b.jpg", "image/jpeg"), image("notes.txt", "text/plain")], types: ["Files"] } });
    expect(inlineImages().map((node) => node.getAttribute("alt"))).toEqual(["Image 1", "Image 2"]);
    const kept = inlineImages()[1].getAttribute("data-image-id");
    // Backspace over the first image: the browser takes the node out, then `input` fires.
    inlineImages()[0].remove();
    fireEvent.input(field());
    expect(inlineImages().map((node) => node.getAttribute("alt"))).toEqual(["Image 1"]);

    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(taskImageIds(taskAction.mock.calls[0][2].text)).toEqual([kept]);
    expect(calls("add").map((call) => call[2].imageId)).toEqual([kept]);
  });

  it("refuses a file that is not an image and a fifth image, with one fixed line", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { container } = renderNew();
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    await user.upload(input, [image("notes.txt", "text/plain")]);
    expect(screen.getByRole("alert")).toHaveTextContent(TASK_IMAGE_TYPE_MESSAGE);
    expect(inlineImages()).toHaveLength(0);
    paste([image(), image(), image(), image(), image()]);
    expect(inlineImages()).toHaveLength(TASK_BOUNDS.imagesPerTask);
    expect(screen.getByRole("alert")).toHaveTextContent(TASK_IMAGE_LIMIT_MESSAGE);
    expect(screen.getByRole("button", { name: "Attach image" })).toBeDisabled();
  });

  it("keeps the task when an image cannot be stored and opens it to say so", async () => {
    taskImage.mockResolvedValue({ ok: false, error: "unavailable" });
    const user = userEvent.setup();
    const created = renderNew();
    typeText("Match the mock-up");
    paste([image()]);
    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onIssueFailed).toHaveBeenCalledWith("T-9"));
    expect(onCreated).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    created.unmount();
    // The task's own modal says so once, and shows no marker for the image that was not stored.
    const opened = renderEdit(storedTask(taskAction.mock.calls[0][2].text, []));
    expect(screen.getByRole("alert")).toHaveTextContent(TASK_IMAGE_CREATE_FAILURE_MESSAGE);
    expect(inlineImages()).toHaveLength(0);
    expect(field()).toHaveTextContent("Match the mock-up");
    opened.unmount();
    renderEdit(storedTask("Match the mock-up", []));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stays a plain textarea that takes no image without the image bridge", () => {
    setBridge({ taskAction });
    renderNew();
    expect(field().tagName).toBe("TEXTAREA");
    expect(screen.queryByRole("button", { name: "Attach image" })).not.toBeInTheDocument();
    paste([image()]);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("Task modal", () => {
  it("draws a stored image where the text names it, and changes nothing until Save", async () => {
    renderEdit(withImage());
    const [inline] = inlineImages();
    expect(inline).toHaveClass("isPending");
    await waitFor(() => expect(inline).toHaveAttribute("src", "blob:pomegr/1"));
    expect(taskImage).toHaveBeenCalledWith(repositoryId, "read", { taskId: "T-9", imageId: STORED });
    expect(field().firstChild?.textContent).toBe("Match this: ");
    expect(field().lastChild?.textContent).toBe(" exactly");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(calls("add")).toHaveLength(0);
    expect(calls("remove")).toHaveLength(0);
  });

  it("removes an image the saved text no longer names, after the text is saved", async () => {
    const user = userEvent.setup();
    renderEdit(withImage());
    inlineImages()[0].remove();
    fireEvent.input(field());
    expect(calls("remove")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "update", { id: "T-9", text: "Match this:  exactly" });
    expect(calls("remove").map((call) => call[2])).toEqual([{ taskId: "T-9", imageId: STORED }]);
    expect(taskAction.mock.invocationCallOrder[0]).toBeLessThan(taskImage.mock.invocationCallOrder.at(-1)!);
  });

  it("stores a pasted image on Save, before the text that names it", async () => {
    const user = userEvent.setup();
    renderEdit(storedTask("Match the mock-up", []));
    paste([image()]);
    expect(inlineImages()).toHaveLength(1);
    expect(taskImage).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const text = taskAction.mock.calls[0][2].text as string;
    const [imageId] = taskImageIds(text);
    expect(text).toBe(`Match the mock-up[image:${imageId}]`);
    expect(calls("add").map((call) => [call[2].taskId, call[2].imageId])).toEqual([["T-9", imageId]]);
    expect(taskImage.mock.invocationCallOrder[0]).toBeLessThan(taskAction.mock.invocationCallOrder[0]);
    expect(calls("remove")).toHaveLength(0);
  });

  it("keeps the draft and saves no text when an image cannot be stored", async () => {
    taskImage.mockResolvedValue({ ok: false, error: "limit" });
    const user = userEvent.setup();
    renderEdit(storedTask("Match the mock-up", []));
    paste([image()]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText(TASK_IMAGE_LIMIT_MESSAGE)).toBeInTheDocument());
    expect(taskAction).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(inlineImages()).toHaveLength(1);
  });

  it("shows an image the text does not name at the end, without making the draft dirty", () => {
    renderEdit(storedTask("Match the mock-up", [{ id: STORED, type: "png", bytes: PNG.length }]));
    expect(inlineImages().map((node) => node.getAttribute("data-image-id"))).toEqual([STORED]);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
