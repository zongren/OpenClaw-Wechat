import { open, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export function normalizeAssistantReplyText(text) {
  if (text == null) return "";
  return String(text)
    .replace(/\[\[\s*reply_to(?:_|:|\s*)current\s*\]\]/gi, "")
    .replace(/\[\[\s*reply_to\s*:\s*current\s*\]\]/gi, "")
    .trim();
}

export function extractAssistantTextFromTranscriptMessage(message) {
  if (!message || typeof message !== "object") return "";
  if (message.role !== "assistant") return "";
  const stopReason = String(message.stopReason ?? "").trim().toLowerCase();
  if (stopReason === "error" || stopReason === "aborted") return "";

  const content = message.content;
  if (typeof content === "string") {
    return normalizeAssistantReplyText(content);
  }
  if (!Array.isArray(content)) return "";

  const chunks = [];
  for (const block of content) {
    if (typeof block === "string") {
      const text = normalizeAssistantReplyText(block);
      if (text) chunks.push(text);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const blockType = String(block.type ?? "").trim().toLowerCase();
    if (!["text", "output_text", "markdown", "final_text"].includes(blockType)) continue;
    const text = normalizeAssistantReplyText(block.text);
    if (text) chunks.push(text);
  }
  return normalizeAssistantReplyText(chunks.join("\n").trim());
}

export function createDeliveredTranscriptReplyTracker({ ttlMs = 30 * 60 * 1000 } = {}) {
  const cache = new Map();

  function prune(now = Date.now()) {
    for (const [cacheKey, expiresAt] of cache.entries()) {
      if (expiresAt <= now) cache.delete(cacheKey);
    }
  }

  function markTranscriptReplyDelivered(sessionId, transcriptMessageId) {
    const cacheKey = `${String(sessionId ?? "")}::${String(transcriptMessageId ?? "")}`;
    if (!sessionId || !transcriptMessageId) return;
    prune();
    cache.set(cacheKey, Date.now() + ttlMs);
  }

  function hasTranscriptReplyBeenDelivered(sessionId, transcriptMessageId) {
    const cacheKey = `${String(sessionId ?? "")}::${String(transcriptMessageId ?? "")}`;
    if (!sessionId || !transcriptMessageId) return false;
    prune();
    const expiresAt = cache.get(cacheKey);
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  }

  return {
    markTranscriptReplyDelivered,
    hasTranscriptReplyBeenDelivered,
  };
}

export async function resolveSessionTranscriptFilePath({ storePath, sessionKey, sessionId, logger }) {
  const fallbackPath = join(dirname(storePath), `${sessionId}.jsonl`);
  try {
    const raw = await readFile(storePath, "utf8");
    const store = JSON.parse(raw);
    if (!store || typeof store !== "object") return fallbackPath;
    const entry =
      store?.[sessionKey] ??
      Object.values(store).find((value) => value?.sessionId === sessionId && typeof value?.sessionFile === "string");
    const sessionFile = String(entry?.sessionFile ?? "").trim();
    if (!sessionFile) return fallbackPath;
    if (isAbsolute(sessionFile)) return sessionFile;
    return join(dirname(storePath), sessionFile);
  } catch (err) {
    logger?.warn?.(
      `wechat_work: failed to resolve session transcript path from store (${sessionKey}): ${String(err?.message || err)}`,
    );
    return fallbackPath;
  }
}

export async function readTranscriptAppendedChunk(filePath, offset) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return { nextOffset: offset, chunk: "" };
  }

  const fileSize = Number(fileStat.size ?? 0);
  if (!Number.isFinite(fileSize) || fileSize <= offset) {
    return { nextOffset: offset, chunk: "" };
  }

  const readLength = fileSize - offset;
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(readLength);
    await handle.read(buffer, 0, readLength, offset);
    return { nextOffset: fileSize, chunk: buffer.toString("utf8") };
  } finally {
    await handle.close();
  }
}

export function parseLateAssistantReplyFromTranscriptLine(line, minTimestamp = 0) {
  if (!line?.trim()) return null;
  try {
    const entry = JSON.parse(line);
    if (entry?.type !== "message") return null;
    const message = entry?.message;
    const text = extractAssistantTextFromTranscriptMessage(message);
    if (!text) return null;
    const normalized = String(text ?? "").trim().toLowerCase();
    if (normalized.includes("request was aborted") || normalized.includes("fetch failed")) return null;
    const timestamp = Number(message?.timestamp ?? Date.parse(String(entry?.timestamp ?? "")) ?? 0);
    if (minTimestamp > 0 && Number.isFinite(timestamp) && timestamp > 0 && timestamp + 1000 < minTimestamp) {
      return null;
    }
    const transcriptMessageId = String(entry?.id ?? "").trim() || `${timestamp || Date.now()}-${text.slice(0, 32)}`;
    return {
      transcriptMessageId,
      text,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    };
  } catch {
    return null;
  }
}
