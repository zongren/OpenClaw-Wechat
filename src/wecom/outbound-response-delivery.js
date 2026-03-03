function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomResponseUrlDeliverer: ${name} is required`);
  }
}

export function createWecomResponseUrlDeliverer({
  sendWecomBotPayloadViaResponseUrl,
  markBotResponseUrlUsed,
} = {}) {
  assertFunction("sendWecomBotPayloadViaResponseUrl", sendWecomBotPayloadViaResponseUrl);
  assertFunction("markBotResponseUrlUsed", markBotResponseUrlUsed);

  return async function deliverResponseUrlReply({
    sessionId,
    inlineResponseUrl = "",
    cachedResponseUrl = null,
    mixedPayload = null,
    content = "",
    fallbackText = "",
    logger,
    proxyUrl = "",
    timeoutMs = 8000,
  } = {}) {
    const targetUrl = String(inlineResponseUrl ?? "").trim() || String(cachedResponseUrl?.url ?? "").trim();
    if (!targetUrl) {
      return { ok: false, reason: "response-url-missing" };
    }
    if (cachedResponseUrl?.used) {
      return { ok: false, reason: "response-url-used" };
    }
    const payload = mixedPayload || {
      msgtype: "text",
      text: {
        content: content || fallbackText,
      },
    };
    const result = await sendWecomBotPayloadViaResponseUrl({
      responseUrl: targetUrl,
      payload,
      logger,
      proxyUrl,
      timeoutMs,
    });
    markBotResponseUrlUsed(sessionId);
    return {
      ok: true,
      meta: {
        status: result.status,
        errcode: result.errcode ?? 0,
      },
    };
  };
}
