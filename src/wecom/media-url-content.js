import { extname, basename } from "node:path";

export function resolveLocalMediaPath(mediaUrl) {
  const raw = String(mediaUrl ?? "").trim();
  if (!raw) return "";
  if (/^file:\/\//i.test(raw)) {
    try {
      return decodeURIComponent(new URL(raw).pathname || "");
    } catch {
      return "";
    }
  }
  if (/^sandbox:/i.test(raw)) {
    const stripped = raw.replace(/^sandbox:\/{0,2}/i, "");
    if (!stripped) return "";
    return stripped.startsWith("/") ? stripped : `/${stripped}`;
  }
  if (raw.startsWith("/")) {
    return raw.split("?")[0].split("#")[0];
  }
  return "";
}

export function guessContentTypeByPath(filePath) {
  const ext = extname(String(filePath ?? "").toLowerCase());
  if (!ext) return "application/octet-stream";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".heic") return "image/heic";
  if (ext === ".heif") return "image/heif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".amr") return "audio/amr";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

export function detectImageContentTypeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return "";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return "image/bmp";
  if (buffer.length >= 12) {
    const boxType = buffer.subarray(4, 8).toString("ascii");
    const brand = buffer.subarray(8, 12).toString("ascii").toLowerCase();
    if (boxType === "ftyp") {
      if (brand.startsWith("heic") || brand.startsWith("heix") || brand.startsWith("hevc") || brand.startsWith("hevx")) {
        return "image/heic";
      }
      if (brand.startsWith("mif1") || brand.startsWith("msf1")) {
        return "image/heif";
      }
    }
  }
  return "";
}

export function pickImageFileExtension({ contentType, sourceUrl }) {
  const normalizedType = String(contentType ?? "")
    .trim()
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (normalizedType.includes("png")) return ".png";
  if (normalizedType.includes("gif")) return ".gif";
  if (normalizedType.includes("webp")) return ".webp";
  if (normalizedType.includes("bmp")) return ".bmp";
  if (normalizedType.includes("heic")) return ".heic";
  if (normalizedType.includes("heif")) return ".heif";
  if (normalizedType.includes("jpg") || normalizedType.includes("jpeg")) return ".jpg";

  const rawPath = String(sourceUrl ?? "").trim().split("?")[0].split("#")[0];
  const ext = extname(rawPath).trim().toLowerCase();
  if (ext && ext.length <= 8 && ext.length >= 2) return ext;
  return ".jpg";
}

export function resolveWecomOutboundMediaTarget({ mediaUrl, mediaType }) {
  const normalizedType = String(mediaType ?? "").trim().toLowerCase();
  const lowerUrl = String(mediaUrl ?? "").trim().toLowerCase();
  const pathPart = lowerUrl.split("?")[0].split("#")[0];
  const ext = (pathPart.match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();
  const inferredName = (() => {
    const raw = String(mediaUrl ?? "").trim();
    if (!raw) return "attachment";
    const withoutQuery = raw.split("?")[0].split("#")[0];
    const name = basename(withoutQuery);
    return name || "attachment";
  })();

  if (normalizedType === "image") return { type: "image", filename: inferredName || "image.jpg" };
  if (normalizedType === "video") return { type: "video", filename: inferredName || "video.mp4" };
  if (normalizedType === "voice") return { type: "voice", filename: inferredName || "voice.amr" };
  if (normalizedType === "file") return { type: "file", filename: inferredName || "file.bin" };

  const imageExts = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "heif"]);
  const videoExts = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv"]);
  const voiceExts = new Set(["amr", "silk"]);

  if (imageExts.has(ext)) return { type: "image", filename: inferredName || `image.${ext}` };
  if (videoExts.has(ext)) return { type: "video", filename: inferredName || `video.${ext}` };
  if (voiceExts.has(ext)) return { type: "voice", filename: inferredName || `voice.${ext}` };
  return { type: "file", filename: inferredName || "file.bin" };
}

export function normalizeOutboundMediaUrls({ mediaUrl, mediaUrls } = {}) {
  const dedupe = new Set();
  const out = [];
  for (const raw of [mediaUrl, ...(Array.isArray(mediaUrls) ? mediaUrls : [])]) {
    const url = String(raw ?? "").trim();
    if (!url || dedupe.has(url)) continue;
    dedupe.add(url);
    out.push(url);
  }
  return out;
}
