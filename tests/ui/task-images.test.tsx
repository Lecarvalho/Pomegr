import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASK_BOUNDS, type Task } from "../../shared/task-contract";

vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));

import { TaskModal } from "../../app/components/tasks/TaskModal";
import {
  TASK_IMAGE_CREATE_FAILURE_MESSAGE, TASK_IMAGE_LIMIT_MESSAGE, TASK_IMAGE_SIZE_MESSAGE, TASK_IMAGE_TYPE_MESSAGE, acceptImageFiles,
} from "../../app/components/tasks/task-images-desktop";

const repositoryId = "repo-0123456789abcdef01234567";
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
  taskImage.mockImplementation(async (_repository: string, operation: string) => (
    operation === "add" ? { ok: true, imageId: "img-0123456789ab" } : operation === "read" ? { ok: true, type: "png", bytes: PNG } : { ok: true }
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

function storedTask(images: Task["images"]): Task {
  return {
    id: "T-9", text: "Match the mock-up", columnId: "col-000000000001", position: 0, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null }, state: "not_queued", scheduledAt: null,
    session: null, source: null, images, report: null, createdAt: "2026-10-10T10:00:00.000Z", updatedAt: "2026-10-10T10:00:00.000Z",
  };
}
const renderEdit = (task: Task) => render(<TaskModal mode="edit" repositoryId={repositoryId} repositoryName="Example" task={task} board={{ ...board, tasks: [task] }}
  refresh={refresh} onChanged={onChanged} onDeleted={vi.fn()} onClose={onClose} />);

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
  it("draws a pasted image as a thumbnail and stores it once the task exists", async () => {
    const user = userEvent.setup();
    renderNew();
    await user.type(field(), "Match the mock-up");
    paste([image()]);
    expect(screen.getByRole("img", { name: "Image 1" })).toHaveAttribute("src", "blob:pomegr/1");
    // The paste was the image: it typed nothing into the task.
    expect(field()).toHaveValue("Match the mock-up");
    expect(taskImage).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "create", expect.objectContaining({ text: "Match the mock-up" }));
    // The create payload carries no image: bytes travel on their own channel, after the task exists.
    expect(JSON.stringify(taskAction.mock.calls[0][2])).not.toContain("image");
    expect(taskImage).toHaveBeenCalledTimes(1);
    const [repository, operation, payload] = taskImage.mock.calls[0];
    expect([repository, operation, payload.taskId]).toEqual([repositoryId, "add", "T-9"]);
    expect([...payload.bytes]).toEqual([...PNG]);
    expect(onIssueFailed).not.toHaveBeenCalled();
  });

  it("attaches picked files, removes one, and refuses a file that is not an image", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { container } = renderNew();
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    expect(input).toHaveAttribute("accept", "image/png,image/jpeg,image/gif,image/webp");
    await user.upload(input, [image("a.png"), image("b.jpg", "image/jpeg")]);
    expect(screen.getAllByRole("img")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Remove Image 1" }));
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:pomegr/1");
    await user.upload(input, [image("notes.txt", "text/plain")]);
    expect(screen.getByRole("alert")).toHaveTextContent(TASK_IMAGE_TYPE_MESSAGE);
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("shows the images inside the Task field's own frame and takes a dropped image", () => {
    renderNew();
    const frame = field().parentElement!;
    expect(frame).toHaveClass("taskComposer");
    fireEvent.drop(frame, { dataTransfer: { files: [image(), image("notes.txt", "text/plain")], types: ["Files"] } });
    expect(frame).toContainElement(screen.getByRole("img", { name: "Image 1" }));
    expect(frame).toContainElement(screen.getByRole("button", { name: "Attach image" }));
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("keeps the task when an image cannot be stored and opens it to say so", async () => {
    taskImage.mockResolvedValue({ ok: false, error: "unavailable" });
    const user = userEvent.setup();
    renderNew();
    await user.type(field(), "Match the mock-up");
    paste([image()]);
    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onIssueFailed).toHaveBeenCalledWith("T-9"));
    expect(onCreated).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves a text paste alone and offers no images without the bridge", async () => {
    setBridge({ taskAction });
    renderNew();
    expect(screen.queryByRole("button", { name: "Attach image" })).not.toBeInTheDocument();
    paste([image()]);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("Task modal", () => {
  it("reads each listed image once and removes one at once", async () => {
    const user = userEvent.setup();
    const task = storedTask([{ id: "img-0123456789ab", type: "png", bytes: PNG.length }]);
    renderEdit(task);
    expect(screen.getByRole("img", { name: "Image 1, loading" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("img", { name: "Image 1" })).toHaveAttribute("src", "blob:pomegr/1"));
    expect(taskImage).toHaveBeenCalledWith(repositoryId, "read", { taskId: "T-9", imageId: "img-0123456789ab" });
    await user.click(screen.getByRole("button", { name: "Remove Image 1" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(taskImage).toHaveBeenCalledWith(repositoryId, "remove", { taskId: "T-9", imageId: "img-0123456789ab" });
    // Removing is not part of the draft: Save stays disabled.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("stores a pasted image at once and has the board read again", async () => {
    renderEdit(storedTask([]));
    paste([image()]);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(taskImage.mock.calls[0].slice(0, 2)).toEqual([repositoryId, "add"]);
    expect(taskImage.mock.calls[0][2].taskId).toBe("T-9");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says once that the New task form left an image behind", async () => {
    taskImage.mockResolvedValue({ ok: false, error: "unavailable" });
    const user = userEvent.setup();
    const created = renderNew();
    await user.type(field(), "Match the mock-up");
    paste([image()]);
    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onIssueFailed).toHaveBeenCalled());
    created.unmount();
    const opened = renderEdit(storedTask([]));
    expect(screen.getByRole("alert")).toHaveTextContent(TASK_IMAGE_CREATE_FAILURE_MESSAGE);
    opened.unmount();
    renderEdit(storedTask([]));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
