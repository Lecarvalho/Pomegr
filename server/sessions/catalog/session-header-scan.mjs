/**
 * Enumerate every provider's session headers into the catalog inventory once.
 * Each provider scans independently; a failed or incomplete scan keeps that
 * provider's previously committed headers.
 */
export async function scanProviderHeaders({ registry, catalogInventory, signal, isStopped, onChange }) {
  const scans = new Map();
  for (const provider of registry.providers || []) {
    const token = catalogInventory.beginProvider(provider.id);
    if (token) scans.set(provider.id, token);
  }
  await Promise.allSettled([...scans].map(async ([providerId, token]) => {
    let complete = false;
    try {
      const outcome = await registry.enumerateSessionHeaders(providerId, {
        signal,
        onBatch: (headers) => {
          if (isStopped() || signal?.aborted) return false;
          const accepted = catalogInventory.upsertHeaders(providerId, headers, token);
          if (accepted) onChange();
          return accepted;
        },
      });
      complete = outcome?.complete === true;
    } catch { /* finishProvider preserves the previous committed headers */ }
    if (!isStopped() && !signal?.aborted) catalogInventory.finishProvider(providerId, token, { complete });
    onChange();
  }));
}
