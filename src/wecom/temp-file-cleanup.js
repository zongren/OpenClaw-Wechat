import { unlink } from "node:fs/promises";

export function createTempFileCleanupScheduler({ unlinkImpl = unlink, defaultRetentionMs = 30 * 60 * 1000 } = {}) {
  function scheduleTempFileCleanup(filePath, logger, delayMs = defaultRetentionMs) {
    if (!filePath) return;
    const timer = setTimeout(() => {
      unlinkImpl(filePath).catch((err) => {
        logger?.warn?.(`wecom: failed to cleanup temp file ${filePath}: ${String(err?.message || err)}`);
      });
    }, delayMs);
    timer.unref?.();
  }

  return {
    scheduleTempFileCleanup,
  };
}
