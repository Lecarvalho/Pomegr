import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, BrowserWindow, session } from "electron";
import { startPerfettoViewer } from "../scripts/diagnostics-tools.mjs";

const trace = JSON.stringify({ traceEvents: [
  { name: "synthetic_stage", cat: "runtime", ph: "X", ts: 1_000, dur: 1_000, pid: 1, tid: 1, args: { outcome: "completed" } },
] });

function localAddress(url) {
  try { return ["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname); } catch { return false; }
}

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "pomegr-perfetto-electron-"));
  const tracePath = path.join(directory, "synthetic.json");
  let viewer;
  let window;
  let unexpectedExternalRequests = 0;
  let rendererGone = false;
  let loadFailed = false;
  let stage = "setup";
  try {
    await writeFile(tracePath, trace, "utf8");
    stage = "app_ready";
    await app.whenReady();
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (!localAddress(details.url)) unexpectedExternalRequests += 1;
      callback({});
    });
    viewer = await startPerfettoViewer();
    stage = "viewer_started";
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
    window.webContents.once("render-process-gone", () => { rendererGone = true; });
    window.webContents.on("did-fail-load", () => { loadFailed = true; });
    await window.loadURL(viewer.url);
    stage = "page_loaded";
    window.webContents.debugger.attach("1.3");
    const { root } = await window.webContents.debugger.sendCommand("DOM.getDocument");
    const { nodeId } = await window.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "input.trace_file" });
    if (!nodeId) throw new Error("trace input unavailable");
    await window.webContents.debugger.sendCommand("DOM.setFileInputFiles", { files: [tracePath], nodeId });
    stage = "trace_selected";
    const deadline = Date.now() + 15_000;
    let timelineVisible = false;
    let traceNameVisible = false;
    while (Date.now() < deadline && !traceNameVisible) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        timelineVisible = await window.webContents.executeJavaScript("document.body.innerText.includes('synthetic_stage')");
      } catch { /* Perfetto replaces the route while it opens the local trace. */ }
      traceNameVisible = window.webContents.getTitle().includes("synthetic.json");
    }
    const summary = { traceNameVisible, localViewerRoute: localAddress(window.webContents.getURL()) };
    process.stdout.write(`${JSON.stringify({ traceFileSelected: true, timelineVisible, unexpectedExternalRequests, summary })}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ traceFileSelected: false, timelineVisible: false, unexpectedExternalRequests, stage, rendererGone, loadFailed })}\n`);
  } finally {
    try { window?.webContents.debugger.detach(); } catch { /* debugger is local to this fixture */ }
    try { window?.destroy(); } catch { /* hidden fixture closes */ }
    try { await new Promise((resolve) => viewer?.server.close(resolve)); } catch { /* loopback viewer closes */ }
    await rm(directory, { recursive: true, force: true });
    app.quit();
  }
}

void main();
