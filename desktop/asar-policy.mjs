export const SHARP_UNPACK_DIRECTORY = "node_modules/@img/sharp-win32-x64/lib";
export const WORKER_BUNDLE_DIRECTORY = "desktop/workers";
export const WORKER_BUNDLE_FILES = Object.freeze([
  `${WORKER_BUNDLE_DIRECTORY}/monitor-host.cjs`,
  `${WORKER_BUNDLE_DIRECTORY}/claude-statusline-bridge.cjs`,
]);
export const SHARP_UNPACKED_FILES = Object.freeze([
  `${SHARP_UNPACK_DIRECTORY}/libvips-42.dll`,
  `${SHARP_UNPACK_DIRECTORY}/libvips-cpp-8.17.3.dll`,
  `${SHARP_UNPACK_DIRECTORY}/sharp-win32-x64.node`,
]);
export const DESKTOP_UNPACKED_FILES = Object.freeze([
  ...WORKER_BUNDLE_FILES,
  ...SHARP_UNPACKED_FILES,
]);
export const DESKTOP_UNPACK_DIRECTORIES = `{${WORKER_BUNDLE_DIRECTORY},${SHARP_UNPACK_DIRECTORY},dist}`;

export function unpackedFilesFromHeader(header) {
  const files = [];
  function visit(entry, parent = "") {
    if (!entry || typeof entry !== "object") return;
    if (entry.files) {
      for (const [name, child] of Object.entries(entry.files)) visit(child, parent ? `${parent}/${name}` : name);
    } else if (entry.unpacked === true) {
      files.push(parent.replaceAll("\\", "/"));
    }
  }
  visit(header);
  return files.sort();
}
