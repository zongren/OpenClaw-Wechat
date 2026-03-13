function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomBotTranscriptFallbackReader: ${name} is required`);
  }
}

export function createWecomBotTranscriptFallbackReader({
  resolveSessionTranscriptFilePath,
  readTranscriptAppendedChunk,
  parseLateAssistantReplyFromTranscriptLine,
  hasTranscriptReplyBeenDelivered,
  markdownToWecomText,
} = {}) {
  assertFunction("resolveSessionTranscriptFilePath", resolveSessionTranscriptFilePath);
  assertFunction("readTranscriptAppendedChunk", readTranscriptAppendedChunk);
  assertFunction("parseLateAssistantReplyFromTranscriptLine", parseLateAssistantReplyFromTranscriptLine);
  assertFunction("hasTranscriptReplyBeenDelivered", hasTranscriptReplyBeenDelivered);
  assertFunction("markdownToWecomText", markdownToWecomText);

  return async function readWecomBotTranscriptFallback({
    storePath,
    sessionId,
    transcriptSessionId,
    minTimestamp = 0,
    logger,
    logErrors = true,
  } = {}) {
    try {
      const transcriptPath = await resolveSessionTranscriptFilePath({
        storePath,
        sessionKey: sessionId,
        sessionId: transcriptSessionId,
        logger,
      });
      const { chunk } = await readTranscriptAppendedChunk(transcriptPath, 0);
      if (!chunk) return { text: "", transcriptMessageId: "" };

      const lines = chunk.split("\n");
      let latestReply = null;
      for (const line of lines) {
        const parsedReply = parseLateAssistantReplyFromTranscriptLine(line, minTimestamp);
        if (!parsedReply) continue;
        if (hasTranscriptReplyBeenDelivered(sessionId, parsedReply.transcriptMessageId)) continue;
        latestReply = parsedReply;
      }

      const text = latestReply?.text ? markdownToWecomText(latestReply.text).trim() : "";
      if (!text) return { text: "", transcriptMessageId: "" };
      return {
        text,
        transcriptMessageId: String(latestReply?.transcriptMessageId ?? "").trim(),
      };
    } catch (err) {
      if (logErrors) {
        logger?.warn?.(`wechat_work(bot): transcript fallback failed: ${String(err?.message || err)}`);
      }
      return { text: "", transcriptMessageId: "" };
    }
  };
}
