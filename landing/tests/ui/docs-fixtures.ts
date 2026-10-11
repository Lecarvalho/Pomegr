import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { inspectDocsContent } from "../../scripts/docs-content.mjs";
import type { DocsBlock, DocsContent, DocsInline, DocsPage } from "../../scripts/docs-content.mjs";

// Shared fixtures for the docs loader tests: a throwaway repository.

// Minimal well-formed images; every fixture image is IMAGE_WIDTH by IMAGE_HEIGHT.
export const IMAGE_WIDTH = 3;
export const IMAGE_HEIGHT = 2;
export function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]); // the CRC is not read
}
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const IHDR = pngChunk("IHDR", Buffer.from([0, 0, 0, IMAGE_WIDTH, 0, 0, 0, IMAGE_HEIGHT, 8, 2, 0, 0, 0]));
export const PNG = Buffer.concat([PNG_SIGNATURE, IHDR, pngChunk("IEND")]);
export function jpegSegment(marker: number, payload: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
}
const JFIF = Buffer.concat([Buffer.from("JFIF\0", "latin1"), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]);
const SOF0 = jpegSegment(0xc0, Buffer.from([8, 0, IMAGE_HEIGHT, 0, IMAGE_WIDTH, 1, 1, 0x11, 0]));
export const jpegWith = (...segments: Buffer[]) =>
  Buffer.concat([Buffer.from([0xff, 0xd8]), jpegSegment(0xe0, JFIF), ...segments, SOF0, Buffer.from([0xff, 0xda, 0x00, 0x02, 1, 2, 3, 4, 0xff, 0xd9])]);
export const JPG = jpegWith();
export function riffChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(type, "latin1"), size, data, Buffer.alloc(data.length % 2)]);
}
const VP8_FRAME = Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, IMAGE_WIDTH, 0, IMAGE_HEIGHT, 0]);
export const webpWith = (...chunks: Buffer[]) => {
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), riffChunk("VP8 ", VP8_FRAME), ...chunks]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), size, body]);
};
export const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.from([IMAGE_WIDTH, 0, IMAGE_HEIGHT, 0])]);
export const FENCE = "```";
export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

const scratch: string[] = [];

export function cleanupScratch() {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
}

export function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

export function put(path: string, data: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

export interface Repo {
  root: string;
  landingRoot: string;
  docs: string;
  publicRoot: string;
}

export function makeRepo(manifest: unknown, files: Record<string, string | Buffer> = {}): Repo {
  const root = temporaryDirectory("pomegr-docs-");
  const landingRoot = join(root, "landing");
  const docs = join(root, "docs");
  const publicRoot = join(docs, "public");
  mkdirSync(landingRoot);
  mkdirSync(publicRoot, { recursive: true });
  put(join(docs, "site.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  put(join(docs, "internal", "secret.md"), doc("Secret", "INTERNAL_SENTINEL"));
  for (const [path, data] of Object.entries(files)) put(join(publicRoot, path), data);
  return { root, landingRoot, docs, publicRoot };
}

export const frontMatter = (title: string) => `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(`About ${title}.`)}\n---\n`;
export const doc = (title: string, body = "Body text.") => `${frontMatter(title)}\n# ${title}\n\n${body}\n`;

export const baseManifest = {
  version: 1,
  groups: [
    { id: "get-started", title: "Get started", pages: ["get-started/alpha.md", "get-started/beta.md"] },
    { id: "concepts", title: "Concepts", pages: ["concepts/gamma.md"] },
  ],
};

export function standard(overrides: Record<string, string | Buffer> = {}, manifest: unknown = baseManifest): Repo {
  return makeRepo(manifest, {
    "get-started/alpha.md": doc("Alpha", "## Alpha section\n\nText."),
    "get-started/beta.md": doc("Beta"),
    "concepts/gamma.md": doc("Gamma", "## Gamma heading\n\nText."),
    "help/hidden.md": doc("Hidden", "HIDDEN_SENTINEL"),
    "images/topic/shot.jpg": JPG,
    "images/topic/unused.jpg": JPG,
    ...overrides,
  });
}

export const alphaWith = (body: string) => ({ "get-started/alpha.md": doc("Alpha", `## Alpha section\n\n${body}`) });

// Each canary is a distinctive word so one scan can prove its absence.
export const PUBLIC_CANARY = "PUBLICCANARYQZX";
export const NON_PUBLIC_CANARIES = {
  internalPage: "INTERNAL_SENTINEL", // docs/internal/secret.md (makeRepo)
  unselectedPage: "HIDDEN_SENTINEL", // docs/public/help/hidden.md, public but not selected (standard)
  plan: "PLANCANARYQZX", // docs/internal/plans/canary-plan.md
  architecture: "ARCHCANARYQZX", // docs/internal/architecture/canary.md
  mockup: "MOCKUPCANARYQZX", // docs/mockups/canary.html
  unreferencedImage: "UNUSEDIMAGEQZX", // docs/public/images/topic/unused.jpg, selected nowhere
  internalImage: "INTERNALIMAGEQZX", // docs/internal/images/canary.jpg
} as const;
export const NON_PUBLIC_CANARY_TEXT = Object.values(NON_PUBLIC_CANARIES);

export function canaryRepo(manifest: unknown = baseManifest): Repo {
  const repo = standard(
    {
      ...alphaWith(`![Shot](../images/topic/shot.jpg)\n\n${PUBLIC_CANARY}`),
      "images/topic/unused.jpg": Buffer.concat([JPG, Buffer.from(NON_PUBLIC_CANARIES.unreferencedImage)]),
    },
    manifest,
  );
  put(join(repo.docs, "internal", "plans", "canary-plan.md"), doc("Canary plan", NON_PUBLIC_CANARIES.plan));
  put(join(repo.docs, "internal", "architecture", "canary.md"), doc("Canary architecture", NON_PUBLIC_CANARIES.architecture));
  put(join(repo.docs, "mockups", "canary.html"), `<p>${NON_PUBLIC_CANARIES.mockup}</p>\n`);
  put(join(repo.docs, "internal", "images", "canary.jpg"), Buffer.concat([JPG, Buffer.from(NON_PUBLIC_CANARIES.internalImage)]));
  return repo;
}

export function inspect(repo: Repo) {
  return inspectDocsContent({ landingRoot: repo.landingRoot });
}

export function loaded(repo: Repo): DocsContent {
  const { content, issues } = inspect(repo);
  expect(issues).toEqual([]);
  if (!content) throw new Error("expected content");
  return content;
}

export function pageOf(content: DocsContent, source: string): DocsPage {
  const page = content.pages.find((candidate) => candidate.source === source);
  if (!page) throw new Error(`missing page ${source}`);
  return page;
}

export function rejected(repo: Repo): string {
  const result = inspect(repo);
  expect(result.issues.length).toBeGreaterThan(0);
  expect(result.content).toBeNull();
  expect(result.assets).toEqual([]);
  return result.issues.join("\n");
}

export function* inlinesOf(blocks: DocsBlock[]): Generator<DocsInline> {
  const walk = function* (nodes: DocsInline[]): Generator<DocsInline> {
    for (const node of nodes) {
      yield node;
      if ("children" in node) yield* walk(node.children);
    }
  };
  for (const block of blocks) {
    if (block.type === "heading" || block.type === "paragraph") yield* walk(block.children);
    else if (block.type === "list") for (const item of block.items) yield* inlinesOf(item);
    else if (block.type === "table") for (const cell of [...block.header, ...block.rows.flat()]) yield* walk(cell);
    else if (block.type === "callout" || block.type === "quote") yield* inlinesOf(block.blocks);
  }
}

// Staged copies of the real landing package, for tests that run the real scripts against a fixture repository.

export const LANDING_SOURCE = fileURLToPath(new URL("../../", import.meta.url));

export function stageScripts(repo: Repo) {
  cpSync(join(LANDING_SOURCE, "scripts"), join(repo.landingRoot, "scripts"), { recursive: true });
  symlinkSync(join(LANDING_SOURCE, "node_modules"), join(repo.landingRoot, "node_modules"), "junction");
}

/** Builds run in the fixture write their Vite caches here instead of the shared landing/node_modules. */
function linkDependencies(repo: Repo) {
  const source = join(LANDING_SOURCE, "node_modules");
  const target = join(repo.landingRoot, "node_modules");
  mkdirSync(target);
  for (const name of readdirSync(source)) {
    if (name === ".vite" || name === ".vite-temp" || name === ".cache" || !statSync(join(source, name)).isDirectory()) continue;
    symlinkSync(join(source, name), join(target, name), "junction");
  }
}

const STAGED_ENTRIES = ["app", "db", "public", "scripts", "server", "worker", "next.config.ts", "package.json", "tsconfig.json", "vite.config.ts", "wrangler.jsonc"];

/** Only tracked sources are staged: gitignored files are absent on a fresh CI checkout. */
export function stageLanding(repo: Repo) {
  const generatedImages = join(LANDING_SOURCE, "public", "docs");
  for (const entry of STAGED_ENTRIES) {
    cpSync(join(LANDING_SOURCE, entry), join(repo.landingRoot, entry), { recursive: true, filter: (source) => source !== generatedImages });
  }
  linkDependencies(repo);
}

/** An environment that cannot leak the surrounding npm or Vitest run into a child npm, node, or build. */
export function childEnvironment(): NodeJS.ProcessEnv {
  const environment: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(?:npm_|VITEST|TEST$|NODE_OPTIONS$|INIT_CWD$)/i.test(name)) environment[name] = value;
  }
  return { ...environment, NODE_ENV: "production", CI: "true", WRANGLER_SEND_METRICS: "false" } as NodeJS.ProcessEnv;
}

export interface Ran {
  ok: boolean;
  status: number | null;
  output: string;
}

function ran(result: ReturnType<typeof spawnSync>): Ran {
  return { ok: result.status === 0, status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export function runNode(cwd: string, args: string[]): Ran {
  return ran(spawnSync(process.execPath, args, { cwd, env: childEnvironment(), encoding: "utf8", timeout: 120_000 }));
}

/** Run an npm script in `cwd` through the shell (npm is a `.cmd` shim on Windows). */
export function runNpm(cwd: string, script: string, timeout = 240_000): Ran {
  return ran(spawnSync(`npm run ${script}`, { cwd, env: childEnvironment(), encoding: "utf8", shell: true, timeout }));
}

export function filesUnder(root: string): Array<{ path: string; data: Buffer }> {
  if (!existsSync(root)) return [];
  const found: Array<{ path: string; data: Buffer }> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push({ path: relative(root, full).split("\\").join("/"), data: readFileSync(full) });
    }
  };
  walk(root);
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
