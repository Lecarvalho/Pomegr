import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(projectRoot, "public", "pomegr-mark-painted.png");
const brandColor = "#a63c32";
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

// Match the application's luminance mask, retaining the painted edges as alpha.
const { data: alpha, info } = await sharp(await readFile(sourcePath))
  .greyscale().raw().toBuffer({ resolveWithObject: true });
const logo = await sharp({ create: {
  width: info.width, height: info.height, channels: 3, background: brandColor,
} }).joinChannel(alpha, { raw: { width: info.width, height: info.height, channels: 1 } })
  .png().toBuffer();

function renderLogo(size, padding = Math.round(size / 16)) {
  return sharp(logo).trim({ background: transparent })
    .resize(size - padding * 2, size - padding * 2, { fit: "contain", background: transparent })
    .extend({ top: padding, right: padding, bottom: padding, left: padding, background: transparent })
    .png({ compressionLevel: 9, palette: true });
}

// PNG-backed ICO frames cover browser tabs and Windows shortcut icon sizes.
const sizes = [16, 32, 48, 256];
const frames = await Promise.all(sizes.map((size) => renderLogo(size).toBuffer()));
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(frames[index].length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += frames[index].length;
}
const faviconIco = Buffer.concat([directory, ...frames]);
const faviconPng = await renderLogo(64).toBuffer();
const publicLogo = await renderLogo(512).toBuffer();
// Preserve the former SVG URL for saved links, with the current artwork embedded.
const faviconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><image width="64" height="64" href="data:image/png;base64,' + faviconPng.toString("base64") + '"/></svg>\n';
for (const directoryName of ["public", "landing/public"]) {
  const target = path.join(projectRoot, directoryName);
  await mkdir(target, { recursive: true });
  await Promise.all([
    writeFile(path.join(target, "pomegr-logo.png"), publicLogo),
    writeFile(path.join(target, "favicon.png"), faviconPng),
    writeFile(path.join(target, "favicon.ico"), faviconIco),
    writeFile(path.join(target, "favicon.svg"), faviconSvg),
  ]);
}
await mkdir(path.join(projectRoot, "build"), { recursive: true });
await Promise.all([
  // Native icons need a fuller silhouette at taskbar/tray sizes than web logos.
  renderLogo(1024, 16).toFile(path.join(projectRoot, "build", "icon.png")),
  renderLogo(1024).toFile(path.join(projectRoot, "landing", "public", "landing", "brand", "pomegr-stackshare-logo-v4-highlight.png")),
  renderLogo(1024).toFile(path.join(projectRoot, "assets", "brand", "pomegr-logo.png")),
]);
console.log("Exported painted Pomegr branding for the app, landing site, and desktop.");
