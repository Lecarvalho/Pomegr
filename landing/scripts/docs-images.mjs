// Image metadata policy for the public documentation (pure: no filesystem access).
//
// Screenshots are copied to the site byte for byte, and the text checks never read binary data,
// so a metadata block (EXIF, XMP, PNG text chunks, comments) could carry a private path or user
// name into the published artifact unseen. The loader therefore refuses images that carry such
// blocks, and the artifact audit additionally scans every image's bytes as text.
//
// Allowed: the structure every encoder needs, plus the tiny resolution-only EXIF record some
// screenshot tools write (two current images carry a 58-byte one). Refused:
//   JPEG  XMP, any comment, and any APPn segment larger than MAX_JPEG_APP_SEGMENT_BYTES
//         (ICC profiles, Photoshop and EXIF records with free text all exceed it)
//   PNG   tEXt, iTXt, zTXt and eXIf chunks
//   WebP  EXIF and XMP chunks
// GIF is not parsed; its bytes are covered by the audit's text scan. A structure that cannot be
// walked to its end (truncated or malformed) is refused, so nothing can hide behind a bad length.

/** Largest APPn segment (its two length bytes included) a JPEG may carry. JFIF is 16 bytes. */
export const MAX_JPEG_APP_SEGMENT_BYTES = 64;

const XMP_PREFIX = "http://ns.adobe.com/xap/1.0/";
const PNG_METADATA_CHUNKS = new Set(["tEXt", "iTXt", "zTXt", "eXIf"]);

const malformed = (format) => `is not a well-formed ${format} file (truncated or damaged structure)`;

function jpegProblem(bytes) {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return malformed("JPEG");
    while (bytes[offset + 1] === 0xff) offset += 1; // fill bytes
    const marker = bytes[offset + 1];
    if (marker === undefined) return malformed("JPEG");
    if (marker === 0xd9 || marker === 0xda) return null; // end of image, or the scan: no metadata follows
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) return malformed("JPEG");
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return malformed("JPEG");
    if (marker === 0xfe) return "carries a JPEG comment; export the image without metadata";
    if (marker >= 0xe0 && marker <= 0xef && length > MAX_JPEG_APP_SEGMENT_BYTES) {
      return `carries a ${length}-byte APP${marker - 0xe0} metadata segment (at most ${MAX_JPEG_APP_SEGMENT_BYTES} bytes are allowed); export the image without metadata`;
    }
    if (offset + 2 + length > bytes.length) return malformed("JPEG");
    if (marker === 0xe1 && bytes.toString("latin1", offset + 4, offset + 4 + XMP_PREFIX.length) === XMP_PREFIX) {
      return "carries XMP metadata; export the image without metadata";
    }
    offset += 2 + length;
  }
  return malformed("JPEG");
}

function pngProblem(bytes) {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (PNG_METADATA_CHUNKS.has(type)) return `carries a PNG ${type} metadata chunk; export the image without metadata`;
    const end = offset + 12 + length;
    if (end > bytes.length) return malformed("PNG");
    if (type === "IEND") return null;
    offset = end;
  }
  return malformed("PNG");
}

function webpProblem(bytes) {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("latin1", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (type === "EXIF" || type === "XMP ") return "carries WebP EXIF or XMP metadata; export the image without metadata";
    if (offset + 8 + size > bytes.length) return malformed("WebP");
    offset += 8 + size + (size % 2);
  }
  return null;
}

/**
 * Why an image must not be published, phrased to follow the image's path in a message, or null
 * when its structure and metadata are acceptable. `extension` is png, jpg, jpeg, webp or gif.
 */
export function imageMetadataProblem(extension, bytes) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (extension === "jpg" || extension === "jpeg") return jpegProblem(data);
  if (extension === "png") return pngProblem(data);
  if (extension === "webp") return webpProblem(data);
  return null;
}

// Pixel dimensions, read from the header each format requires. The page reserves the image's box
// from them, so the text below does not move when a screenshot arrives.

const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset + 1] === 0xff) offset += 1; // fill bytes
    const marker = bytes[offset + 1];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null; // no frame header before the scan
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (length < 7 || offset + 9 > bytes.length) return null;
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

function pngDimensions(bytes) {
  if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gifDimensions(bytes) {
  if (bytes.length < 10) return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function webpDimensions(bytes) {
  if (bytes.length < 30) return null;
  const type = bytes.toString("latin1", 12, 16);
  if (type === "VP8X") return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  if (type === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (type === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/**
 * The image's pixel `{ width, height }`, or null when its header does not state a usable size.
 * `extension` is png, jpg, jpeg, webp or gif.
 */
export function imageDimensions(extension, bytes) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = null;
  if (extension === "jpg" || extension === "jpeg") size = jpegDimensions(data);
  else if (extension === "png") size = pngDimensions(data);
  else if (extension === "webp") size = webpDimensions(data);
  else if (extension === "gif") size = gifDimensions(data);
  return size && size.width > 0 && size.height > 0 ? size : null;
}
