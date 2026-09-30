// Types for the image metadata policy (docs-images.mjs).

export const MAX_JPEG_APP_SEGMENT_BYTES: number;

/** Why an image must not be published (phrased to follow its path in a message), or null when acceptable. */
export function imageMetadataProblem(extension: string, bytes: Uint8Array): string | null;
