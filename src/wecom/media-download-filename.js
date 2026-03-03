import { basename, extname } from "node:path";

const CONTENT_TYPE_EXTENSIONS = new Map([
  ["application/pdf", ".pdf"],
  ["application/zip", ".zip"],
  ["application/json", ".json"],
  ["application/xml", ".xml"],
  ["application/msword", ".doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["application/vnd.ms-excel", ".xls"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ["application/vnd.ms-powerpoint", ".ppt"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
  ["text/plain", ".txt"],
  ["text/csv", ".csv"],
  ["text/markdown", ".md"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/bmp", ".bmp"],
  ["audio/mpeg", ".mp3"],
  ["audio/wav", ".wav"],
  ["audio/amr", ".amr"],
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
]);

const GENERIC_FILENAMES = new Set(["", "file", "attachment", "download", "media", "unnamed"]);

function normalizeContentType(contentType) {
  return String(contentType ?? "")
    .trim()
    .toLowerCase()
    .split(";")[0]
    .trim();
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function sanitizeWecomFileName(fileName, fallback = "file") {
  const raw = basename(String(fileName ?? "").trim());
  const normalized = raw
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return fallback;
  const maxLen = 180;
  if (normalized.length <= maxLen) return normalized;
  const ext = extname(normalized);
  if (!ext) return normalized.slice(0, maxLen);
  const stem = normalized.slice(0, Math.max(1, maxLen - ext.length));
  return `${stem}${ext}`;
}

export function pickExtensionFromContentType(contentType) {
  return CONTENT_TYPE_EXTENSIONS.get(normalizeContentType(contentType)) || "";
}

export function extractFilenameFromContentDisposition(contentDisposition) {
  const header = String(contentDisposition ?? "").trim();
  if (!header) return "";

  const encodedMatch = header.match(/filename\*\s*=\s*([^;]+)/i);
  if (encodedMatch?.[1]) {
    const raw = encodedMatch[1].trim().replace(/^"(.*)"$/, "$1");
    const encoded = raw.includes("''") ? raw.split("''").slice(1).join("''") : raw;
    const decoded = safeDecode(encoded);
    const safe = sanitizeWecomFileName(decoded, "");
    if (safe) return safe;
  }

  const plainMatch = header.match(/filename\s*=\s*("([^"]+)"|[^;]+)/i);
  if (plainMatch) {
    const rawValue = plainMatch[2] || plainMatch[1] || "";
    const decoded = safeDecode(String(rawValue).trim().replace(/^"(.*)"$/, "$1"));
    const safe = sanitizeWecomFileName(decoded, "");
    if (safe) return safe;
  }

  return "";
}

export function extractFilenameFromUrl(sourceUrl) {
  const raw = String(sourceUrl ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const qKeys = ["filename", "file", "name", "download", "attname"];
    for (const key of qKeys) {
      const value = parsed.searchParams.get(key);
      const safe = sanitizeWecomFileName(safeDecode(String(value ?? "")), "");
      if (safe) return safe;
    }
    const pathName = basename(parsed.pathname || "");
    return sanitizeWecomFileName(pathName, "");
  } catch {
    const noQuery = raw.split("?")[0].split("#")[0];
    return sanitizeWecomFileName(basename(noQuery), "");
  }
}

export function inferFilenameFromMediaDownload({
  explicitName,
  contentDisposition,
  sourceUrl,
  contentType,
}) {
  const explicit = sanitizeWecomFileName(explicitName, "");
  const dispositionName = extractFilenameFromContentDisposition(contentDisposition);
  const fromUrl = extractFilenameFromUrl(sourceUrl);

  let selected = explicit || dispositionName || fromUrl || "file";
  if (GENERIC_FILENAMES.has(selected.toLowerCase()) && (dispositionName || fromUrl)) {
    selected = dispositionName || fromUrl;
  }
  if (!extname(selected)) {
    const ext = pickExtensionFromContentType(contentType);
    if (ext) selected = `${selected}${ext}`;
  }
  return sanitizeWecomFileName(selected, "file");
}
