import { looksLikePlainFileBuffer } from "./media-download-plain.js";

export function smartDecryptWecomFileBuffer({
  buffer,
  aesKey,
  contentType,
  sourceUrl,
  decryptFn,
  logger,
}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { buffer, decrypted: false, reason: "empty-buffer" };
  }

  if (looksLikePlainFileBuffer({ buffer, contentType })) {
    return { buffer, decrypted: false, reason: "plain-buffer" };
  }

  const normalizedAesKey = String(aesKey ?? "").trim();
  if (!normalizedAesKey || typeof decryptFn !== "function") {
    return { buffer, decrypted: false, reason: "decrypt-unavailable" };
  }

  try {
    const decryptedBuffer = decryptFn({
      aesKey: normalizedAesKey,
      encryptedBuffer: buffer,
    });
    if (!Buffer.isBuffer(decryptedBuffer) || decryptedBuffer.length === 0) {
      return { buffer, decrypted: false, reason: "decrypt-empty" };
    }

    const rawLooksPlain = looksLikePlainFileBuffer({ buffer, contentType });
    const decryptedLooksPlain = looksLikePlainFileBuffer({
      buffer: decryptedBuffer,
      contentType,
    });
    if (decryptedLooksPlain && !rawLooksPlain) {
      return { buffer: decryptedBuffer, decrypted: true, reason: "decrypt-plain-detected" };
    }
    if (rawLooksPlain && !decryptedLooksPlain) {
      return { buffer, decrypted: false, reason: "raw-plain-preferred" };
    }
    if (decryptedLooksPlain) {
      return { buffer: decryptedBuffer, decrypted: true, reason: "decrypt-plain-possible" };
    }

    const lengthRatio = decryptedBuffer.length / Math.max(1, buffer.length);
    if (lengthRatio > 0.5 && lengthRatio < 2.5) {
      logger?.warn?.(
        `wechat_work: decrypt result uncertain (source=${sourceUrl || "unknown"}) raw=${buffer.length} decrypted=${decryptedBuffer.length}; fallback to decrypted`,
      );
      return { buffer: decryptedBuffer, decrypted: true, reason: "decrypt-length-ratio" };
    }

    return { buffer, decrypted: false, reason: "decrypt-not-recognized" };
  } catch (err) {
    logger?.warn?.(
      `wecom(bot): smart decrypt failed url=${String(sourceUrl ?? "").slice(0, 120)} reason=${String(err?.message || err)}`,
    );
    return { buffer, decrypted: false, reason: "decrypt-failed" };
  }
}
