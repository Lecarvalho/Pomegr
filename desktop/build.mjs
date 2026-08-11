import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDesktopServiceBundles } from "./service-bundles.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await buildDesktopServiceBundles(root, root);
