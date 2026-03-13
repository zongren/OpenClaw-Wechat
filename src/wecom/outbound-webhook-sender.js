function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomWebhookOutboundSender: ${name} is required`);
  }
}

export function createWecomWebhookOutboundSender({
  resolveWecomWebhookTargetConfig,
  resolveWebhookBotSendUrl,
  attachWecomProxyDispatcher,
  splitWecomText,
  webhookSendText,
  webhookSendImage,
  webhookSendFileBuffer,
  normalizeOutboundMediaUrls,
  resolveWecomOutboundMediaTarget,
  fetchMediaFromUrl,
  createHash,
  sleep,
  fetchImpl = fetch,
} = {}) {
  assertFunction("resolveWecomWebhookTargetConfig", resolveWecomWebhookTargetConfig);
  assertFunction("resolveWebhookBotSendUrl", resolveWebhookBotSendUrl);
  assertFunction("attachWecomProxyDispatcher", attachWecomProxyDispatcher);
  assertFunction("splitWecomText", splitWecomText);
  assertFunction("webhookSendText", webhookSendText);
  assertFunction("webhookSendImage", webhookSendImage);
  assertFunction("webhookSendFileBuffer", webhookSendFileBuffer);
  assertFunction("normalizeOutboundMediaUrls", normalizeOutboundMediaUrls);
  assertFunction("resolveWecomOutboundMediaTarget", resolveWecomOutboundMediaTarget);
  assertFunction("fetchMediaFromUrl", fetchMediaFromUrl);
  assertFunction("createHash", createHash);
  assertFunction("sleep", sleep);

  function resolveWebhookSendContext({ webhook, webhookTargets, proxyUrl, logger }) {
    const target = resolveWecomWebhookTargetConfig(webhook, webhookTargets);
    if (!target) {
      throw new Error("invalid webhook target");
    }
    const sendUrl = resolveWebhookBotSendUrl({
      url: target.url,
      key: target.key,
    });
    if (!sendUrl) {
      throw new Error("invalid webhook target url/key");
    }
    const dispatcher = attachWecomProxyDispatcher(sendUrl, {}, { proxyUrl, logger })?.dispatcher;
    return { target, dispatcher };
  }

  async function sendWecomWebhookText({ webhook, webhookTargets, text, logger, proxyUrl }) {
    const { target, dispatcher } = resolveWebhookSendContext({
      webhook,
      webhookTargets,
      proxyUrl,
      logger,
    });
    const chunks = splitWecomText(String(text ?? ""));
    for (let i = 0; i < chunks.length; i += 1) {
      await webhookSendText({
        url: target.url,
        key: target.key,
        content: chunks[i],
        timeoutMs: 15000,
        dispatcher,
        fetchImpl,
      });
      if (i < chunks.length - 1) {
        await sleep(200);
      }
    }
    logger?.info?.(`wechat_work: webhook text sent chunks=${chunks.length}`);
  }

  async function sendWecomWebhookMediaBatch({
    webhook,
    webhookTargets,
    mediaUrl,
    mediaUrls,
    mediaType,
    logger,
    proxyUrl,
    maxBytes = 20 * 1024 * 1024,
  } = {}) {
    const { target, dispatcher } = resolveWebhookSendContext({
      webhook,
      webhookTargets,
      proxyUrl,
      logger,
    });
    const candidates = normalizeOutboundMediaUrls({ mediaUrl, mediaUrls });
    if (candidates.length === 0) {
      return { total: 0, sentCount: 0, failed: [] };
    }

    let sentCount = 0;
    const failed = [];
    for (const candidate of candidates) {
      try {
        const mediaTarget = resolveWecomOutboundMediaTarget({
          mediaUrl: candidate,
          mediaType: candidates.length === 1 ? mediaType : undefined,
        });
        const { buffer } = await fetchMediaFromUrl(candidate, {
          proxyUrl,
          logger,
          forceProxy: Boolean(proxyUrl),
          maxBytes,
        });
        if (mediaTarget.type === "image") {
          const base64 = buffer.toString("base64");
          const md5 = createHash("md5", buffer);
          await webhookSendImage({
            url: target.url,
            key: target.key,
            base64,
            md5,
            timeoutMs: 15000,
            dispatcher,
            fetchImpl,
          });
        } else {
          await webhookSendFileBuffer({
            url: target.url,
            key: target.key,
            buffer,
            filename: mediaTarget.filename,
            timeoutMs: 15000,
            dispatcher,
            fetchImpl,
          });
        }
        sentCount += 1;
      } catch (err) {
        failed.push({
          url: candidate,
          reason: String(err?.message || err),
        });
        logger?.warn?.(`wechat_work: webhook media send failed ${candidate}: ${String(err?.message || err)}`);
      }
    }
    return {
      total: candidates.length,
      sentCount,
      failed,
    };
  }

  return {
    sendWecomWebhookText,
    sendWecomWebhookMediaBatch,
  };
}
