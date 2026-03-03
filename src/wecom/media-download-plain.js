const FILE_MAGIC_SIGNATURES = [
  { magic: [0xff, 0xd8, 0xff], ext: ".jpg" },
  { magic: [0x89, 0x50, 0x4e, 0x47], ext: ".png" },
  { magic: [0x47, 0x49, 0x46, 0x38], ext: ".gif" },
  { magic: [0x25, 0x50, 0x44, 0x46], ext: ".pdf" },
  { magic: [0x50, 0x4b, 0x03, 0x04], ext: ".zip" },
  { magic: [0xd0, 0xcf, 0x11, 0xe0], ext: ".doc" },
  { magic: [0x52, 0x61, 0x72, 0x21], ext: ".rar" },
  { magic: [0x1f, 0x8b], ext: ".gz" },
  { magic: [0x42, 0x4d], ext: ".bmp" },
  { magic: [0x49, 0x44, 0x33], ext: ".mp3" },
  { magic: [0x52, 0x49, 0x46, 0x46], ext: ".wav" },
];

function normalizeContentType(contentType) {
  return String(contentType ?? "")
    .trim()
    .toLowerCase()
    .split(";")[0]
    .trim();
}

export function detectMagicFileExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return "";
  for (const signature of FILE_MAGIC_SIGNATURES) {
    if (
      buffer.length >= signature.magic.length &&
      signature.magic.every((value, index) => buffer[index] === value)
    ) {
      return signature.ext;
    }
  }
  return "";
}

export function isLikelyTextContentType(contentType) {
  const normalized = normalizeContentType(contentType);
  if (!normalized) return false;
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/xml" ||
    normalized === "application/x-www-form-urlencoded" ||
    normalized === "application/javascript"
  );
}

export function isLikelyUtf8TextBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  const text = sample.toString("utf8");
  if (!text) return false;
  if (text.includes("\uFFFD")) return false;
  let printable = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126) || code >= 160) {
      printable += 1;
    }
  }
  return printable / Math.max(1, text.length) >= 0.88;
}

export function looksLikePlainFileBuffer({ buffer, contentType }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return false;
  if (detectMagicFileExtension(buffer)) return true;
  if (isLikelyTextContentType(contentType) && isLikelyUtf8TextBuffer(buffer)) return true;
  return false;
}
