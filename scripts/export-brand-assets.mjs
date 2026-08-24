import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandDir = path.join(projectRoot, "assets", "brand");

const exports = [
  ["pomegr-lockup-color.svg", "pomegr-lockup-color.png", 4096, 2410],
  ["pomegr-lockup-dark.svg", "pomegr-lockup-dark.png", 4096, 2410],
  ["pomegr-lockup-white.svg", "pomegr-lockup-white.png", 4096, 2410],
  ["pomegr-mark-color.svg", "pomegr-mark-color.png", 2048, 2048],
  ["pomegr-mark-dark.svg", "pomegr-mark-dark.png", 2048, 2048],
  ["pomegr-mark-white.svg", "pomegr-mark-white.png", 2048, 2048],
  ["pomegr-mark-outline-dark.svg", "pomegr-mark-outline-dark.png", 2048, 2048],
  ["pomegr-mark-outline-light.svg", "pomegr-mark-outline-light.png", 2048, 2048],
];

await mkdir(brandDir, { recursive: true });

for (const [sourceName, outputName, width, height] of exports) {
  const source = await readFile(path.join(brandDir, sourceName));
  await sharp(source, { density: 384 })
    .resize(width, height, { fit: "fill" })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toFile(path.join(brandDir, outputName));
}

const iconSource = await readFile(path.join(brandDir, "pomegr-logo.png"));
const renderLogo = (size, padding) => sharp(iconSource)
  .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .resize(size - (padding * 2), size - (padding * 2), {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .extend({
    top: padding,
    right: padding,
    bottom: padding,
    left: padding,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false });

await mkdir(path.join(projectRoot, "public"), { recursive: true });
await mkdir(path.join(projectRoot, "landing", "public"), { recursive: true });
await mkdir(path.join(projectRoot, "build"), { recursive: true });
await Promise.all([
  renderLogo(512, 44).toFile(path.join(projectRoot, "public", "pomegr-logo.png")),
  renderLogo(512, 44).toFile(path.join(projectRoot, "landing", "public", "pomegr-logo.png")),
  renderLogo(1024, 88).toFile(path.join(projectRoot, "build", "icon.png")),
]);
