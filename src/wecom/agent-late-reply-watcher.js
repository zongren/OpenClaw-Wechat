import { stat } from "node:fs/promises";

function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomLateReplyWatcher: ${name} is required`);
  }
}

export function createWecomLateReplyWatcher({
  resolveSessionTranscriptFilePath,
  readTranscriptAppendedChunk,
  parseLateAssistantReplyFromTranscriptLine,
  hasTranscriptReplyBeenDelivered,
  markTranscriptReplyDelivered,
  sleep,
  markdownToWecomText,
  now = () => Date.now(),
  statImpl = stat,
} = {}) {
  assertFunction("resolveSessionTranscriptFilePath", resolveSessionTranscriptFilePath);
  assertFunction("readTranscriptAppendedChunk", readTranscriptAppendedChunk);
  assertFunction("parseLateAssistantReplyFromTranscriptLine", parseLateAssistantReplyFromTranscriptLine);
  assertFunction("hasTranscriptReplyBeenDelivered", hasTranscriptReplyBeenDelivered);
  assertFunction("markTranscriptReplyDelivered", markTranscriptReplyDelivered);
  assertFunction("sleep", sleep);
  assertFunction("markdownToWecomText", markdownToWecomText);
  assertFunction("now", now);
  assertFunction("statImpl", statImpl);

  return async function runWecomLateReplyWatcher({
    watchId,
    reason = "pending-final",
    sessionId,
    sessionTranscriptId,
    accountId = "default",
    storePath,
    logger,
    watchStartedAt = now(),
    watchMs,
    pollMs,
    activeWatchers,
    isDelivered,
    markDelivered,
    sendText,
    onFailureFallback,
  } = {}) {
    assertFunction("isDelivered", isDelivered);
    assertFunction("markDelivered", markDelivered);
    assertFunction("sendText", sendText);
    assertFunction("onFailureFallback", onFailureFallback);

    const watcherMap = activeWatchers instanceof Map ? activeWatchers : null;
    if (watcherMap && watchId) {
      watcherMap.set(watchId, {
        sessionId,
        sessionKey: sessionId,
        accountId,
        startedAt: watchStartedAt,
        reason,
      });
    }

    try {
      const transcriptPath = await resolveSessionTranscriptFilePath({
        storePath,
        sessionKey: sessionId,
        sessionId: sessionTranscriptId,
        logger,
      });
      let offset = 0;
      let remainder = "";
      try {
        const fileStat = await statImpl(transcriptPath);
        offset = Number(fileStat.size ?? 0);
      } catch {
        offset = 0;
      }

      const timeoutMs = Math.max(1, Number(watchMs) || 1);
      const pollingMs = Math.max(0, Number(pollMs) || 0);
      const deadline = watchStartedAt + timeoutMs;
      logger?.info?.(`wechat_work: late reply watcher started session=${sessionId} reason=${reason} timeoutMs=${timeoutMs}`);

      while (now() < deadline) {
        if (isDelivered()) return;
        await sleep(pollingMs);
        if (isDelivered()) return;

        const { nextOffset, chunk } = await readTranscriptAppendedChunk(transcriptPath, offset);
        offset = nextOffset;
        if (!chunk) continue;

        const combined = remainder + chunk;
        const lines = combined.split("\n");
        remainder = lines.pop() ?? "";

        for (const line of lines) {
          const parsed = parseLateAssistantReplyFromTranscriptLine(line, watchStartedAt);
          if (!parsed) continue;
          if (hasTranscriptReplyBeenDelivered(sessionId, parsed.transcriptMessageId)) continue;
          if (isDelivered()) return;

          const formattedReply = markdownToWecomText(parsed.text);
          if (!formattedReply) continue;

          await sendText(formattedReply);
          markTranscriptReplyDelivered(sessionId, parsed.transcriptMessageId);
          markDelivered();
          logger?.info?.(
            `wechat_work: delivered async late reply session=${sessionId} transcriptMessageId=${parsed.transcriptMessageId}`,
          );
          return;
        }
      }

      if (!isDelivered()) {
        logger?.warn?.(`wechat_work: late reply watcher timed out session=${sessionId} timeoutMs=${timeoutMs}`);
        await onFailureFallback(`late reply watcher timed out after ${timeoutMs}ms`);
      }
    } catch (err) {
      logger?.warn?.(`wechat_work: late reply watcher failed: ${String(err?.message || err)}`);
      if (!isDelivered()) {
        await onFailureFallback(err);
      }
    } finally {
      if (watcherMap && watchId) {
        watcherMap.delete(watchId);
      }
    }
  };
}
