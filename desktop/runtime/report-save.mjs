import path from "node:path";

export const DESKTOP_REPORT_CHANNEL = "pomegr:save-report";
const REPORT_FILENAME = /^pomegr-[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?-\d{4}-\d{2}-\d{2}\.md$/;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

export function normalizeReportSaveRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !["filename", "content"].includes(key))) return null;
  if (typeof value.filename !== "string" || !REPORT_FILENAME.test(value.filename)) return null;
  if (typeof value.content !== "string" || !["# Pomegr Session Report\n", "# Pomegr Session Observation Report\n"].some((header) => value.content.startsWith(header))) return null;
  if (Buffer.byteLength(value.content, "utf8") > MAX_REPORT_BYTES) return null;
  return { filename: value.filename, content: value.content };
}

export function createReportSaveHandler(options) {
  if (!path.isAbsolute(options.defaultDirectory)) throw new Error("DESKTOP_REPORT_DIRECTORY_INVALID");
  if (typeof options.isTrustedEvent !== "function") throw new Error("DESKTOP_REPORT_TRUST_INVALID");
  if (typeof options.showSaveDialog !== "function" || typeof options.writeFile !== "function") {
    throw new Error("DESKTOP_REPORT_HANDLER_INVALID");
  }
  return async (_event, input) => {
    if (!options.isTrustedEvent(_event)) return { status: "rejected" };
    const request = normalizeReportSaveRequest(input);
    if (!request) return { status: "rejected" };
    try {
      const result = await options.showSaveDialog({
        title: "Save Pomegr report",
        defaultPath: path.join(options.defaultDirectory, request.filename),
        filters: [{ name: "Markdown", extensions: ["md"] }],
        properties: ["showOverwriteConfirmation", "createDirectory"],
      });
      if (result.canceled || !result.filePath) return { status: "canceled" };
      await options.writeFile(result.filePath, request.content, { encoding: "utf8", mode: 0o600 });
      return { status: "saved" };
    } catch {
      return { status: "failed" };
    }
  };
}
