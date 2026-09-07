import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDesktopServiceBundles } from "./service-bundles.mjs";
import { assertBuiltLegalNotices } from "./legal-notices.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await assertBuiltLegalNotices(root);
await buildDesktopServiceBundles(root, root);
