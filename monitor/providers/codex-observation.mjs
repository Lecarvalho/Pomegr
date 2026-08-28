import { expandCodexSelectedMetadata } from "./codex-session-discovery.mjs";
import {
  createIncrementalProviderObserver,
  incrementalSourceSetDescriptor,
} from "./incremental-provider-observer.mjs";

export function createCodexIncrementalObserver(options = {}) {
  const {
    list,
    readEvidence,
    discoveredMetadata,
    transcriptPathsBySessionId,
    intervalMs,
    concurrency,
    watchTargets,
    yieldControl,
    now,
    shouldEagerHydrate,
  } = options;

  async function prepareSources(entries = []) {
    const metadata = await discoveredMetadata();
    const metadataById = new Map(metadata.map((item) => [item.localId, item]));
    const sources = new Map();
    for (const entry of entries) {
      const localId = entry?.localId;
      const root = metadataById.get(localId);
      if (!root?.rolloutFile) continue;
      const selectedIds = new Set([localId]);
      expandCodexSelectedMetadata(metadataById, selectedIds);
      const files = new Set([...selectedIds].flatMap((id) => {
        const rolloutFile = metadataById.get(id)?.rolloutFile;
        return rolloutFile ? [rolloutFile] : [];
      }));
      for (const transcriptPath of transcriptPathsBySessionId.get(localId)?.values() || []) {
        files.add(transcriptPath);
      }
      sources.set(localId, incrementalSourceSetDescriptor(
        [...files],
        root.rolloutFile,
        entry?.isLive === false,
      ));
    }
    return sources;
  }

  return createIncrementalProviderObserver({
    providerId: "codex",
    list,
    readEvidence,
    resolveSource: async (localId) => (await prepareSources([{ localId }])).get(localId) || null,
    prepareSources,
    intervalMs,
    concurrency,
    watchTargets,
    yieldControl,
    now,
    shouldEagerHydrate,
  });
}
