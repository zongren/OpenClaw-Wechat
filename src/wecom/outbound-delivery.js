import crypto from "node:crypto";
import { basename } from "node:path";

import { createWecomDeliveryRouter, parseWecomResponseUrlResult } from "../core/delivery-router.js";
import { buildWecomBotMixedPayload, normalizeWecomBotOutboundMediaUrls } from "./webhook-adapter.js";
import {
  resolveWebhookBotSendUrl,
  webhookSendFileBuffer,
  webhookSendImage,
  webhookSendText,
} from "./webhook-bot.js";

function assertFunction(name, fn) {
  if (typeof fn !== "function") {
    throw new Error(`createWecomBotReplyDeliverer missing function dependency: ${name}`);
  }
}

function resolveWecomOutboundMediaTarget({ mediaUrl, mediaType }) {
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
  if (normalizedType === "file") return { type: "file", filename: inferredName || "file.bin" };

  const imageExts = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "heif"]);
  const videoExts = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv"]);

  if (imageExts.has(ext)) return { type: "image", filename: inferredName || `image.${ext}` };
  if (videoExts.has(ext)) return { type: "video", filename: inferredName || `video.${ext}` };
  return { type: "file", filename: inferredName || "file.bin" };
}

export function createWecomBotReplyDeliverer({
  attachWecomProxyDispatcher,
  resolveWecomDeliveryFallbackPolicy,
  resolveWecomWebhookBotDeliveryPolicy,
  resolveWecomObservabilityPolicy,
  resolveWecomBotProxyConfig,
  buildWecomBotSessionId,
  upsertBotResponseUrlCache,
  getBotResponseUrlCache,
  markBotResponseUrlUsed,
  createDeliveryTraceId,
  hasBotStream,
  finishBotStream,
  getWecomConfig,
  sendWecomText,
  fetchMediaFromUrl,
  resolveWebhookBotSendUrlFn = resolveWebhookBotSendUrl,
  webhookSendTextFn = webhookSendText,
  webhookSendImageFn = webhookSendImage,
  webhookSendFileBufferFn = webhookSendFileBuffer,
  fetchImpl = fetch,
} = {}) {
  assertFunction("attachWecomProxyDispatcher", attachWecomProxyDispatcher);
  assertFunction("resolveWecomDeliveryFallbackPolicy", resolveWecomDeliveryFallbackPolicy);
  assertFunction("resolveWecomWebhookBotDeliveryPolicy", resolveWecomWebhookBotDeliveryPolicy);
  assertFunction("resolveWecomObservabilityPolicy", resolveWecomObservabilityPolicy);
  assertFunction("resolveWecomBotProxyConfig", resolveWecomBotProxyConfig);
  assertFunction("buildWecomBotSessionId", buildWecomBotSessionId);
  assertFunction("upsertBotResponseUrlCache", upsertBotResponseUrlCache);
  assertFunction("getBotResponseUrlCache", getBotResponseUrlCache);
  assertFunction("markBotResponseUrlUsed", markBotResponseUrlUsed);
  assertFunction("createDeliveryTraceId", createDeliveryTraceId);
  assertFunction("hasBotStream", hasBotStream);
  assertFunction("finishBotStream", finishBotStream);
  assertFunction("getWecomConfig", getWecomConfig);
  assertFunction("sendWecomText", sendWecomText);
  assertFunction("fetchMediaFromUrl", fetchMediaFromUrl);
  assertFunction("resolveWebhookBotSendUrlFn", resolveWebhookBotSendUrlFn);
  assertFunction("webhookSendTextFn", webhookSendTextFn);
  assertFunction("webhookSendImageFn", webhookSendImageFn);
  assertFunction("webhookSendFileBufferFn", webhookSendFileBufferFn);

  function resolveWebhookDispatcher(url, proxyUrl, logger) {
    const options = attachWecomProxyDispatcher(url, {}, { proxyUrl, logger });
    return options?.dispatcher;
  }

  async function sendWecomBotPayloadViaResponseUrl({
    responseUrl,
    payload,
    logger,
    proxyUrl,
    timeoutMs = 8000,
  }) {
    const normalizedUrl = String(responseUrl ?? "").trim();
    if (!normalizedUrl) {
      throw new Error("missing response_url");
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("missing response payload");
    }
    const requestOptions = attachWecomProxyDispatcher(
      normalizedUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 8000)),
      },
      { proxyUrl, logger },
    );
    const response = await fetchImpl(normalizedUrl, requestOptions);
    const responseBody = await response.text().catch(() => "");
    const result = parseWecomResponseUrlResult(response, responseBody);
    if (!result.accepted) {
      throw new Error(
        `response_url rejected: status=${response.status} errcode=${result.errcode ?? "unknown"} errmsg=${result.errmsg || "n/a"}`,
      );
    }
    return {
      status: response.status,
      errcode: result.errcode,
    };
  }

  async function sendWebhookBotMediaBatch({
    api,
    webhookBotPolicy,
    proxyUrl,
    mediaUrls,
    mediaType,
  }) {
    const sendUrl = resolveWebhookBotSendUrlFn({
      url: webhookBotPolicy.url,
      key: webhookBotPolicy.key,
    });
    if (!sendUrl) {
      return { sentCount: 0, failedCount: mediaUrls.length, failedUrls: mediaUrls, reason: "webhook-bot-url-missing" };
    }

    const dispatcher = resolveWebhookDispatcher(sendUrl, proxyUrl, api.logger);
    let sentCount = 0;
    const failedUrls = [];

    for (const mediaUrl of mediaUrls) {
      const target = resolveWecomOutboundMediaTarget({ mediaUrl, mediaType });
      try {
        const { buffer } = await fetchMediaFromUrl(mediaUrl, {
          proxyUrl,
          logger: api.logger,
          forceProxy: Boolean(proxyUrl),
          maxBytes: 20 * 1024 * 1024,
        });
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
          throw new Error("empty media buffer");
        }

        if (target.type === "image") {
          const base64 = buffer.toString("base64");
          const md5 = crypto.createHash("md5").update(buffer).digest("hex");
          await webhookSendImageFn({
            url: webhookBotPolicy.url,
            key: webhookBotPolicy.key,
            base64,
            md5,
            timeoutMs: webhookBotPolicy.timeoutMs,
            dispatcher,
            fetchImpl,
          });
        } else {
          await webhookSendFileBufferFn({
            url: webhookBotPolicy.url,
            key: webhookBotPolicy.key,
            buffer,
            filename: target.filename,
            timeoutMs: webhookBotPolicy.timeoutMs,
            dispatcher,
            fetchImpl,
          });
        }
        sentCount += 1;
      } catch (err) {
        failedUrls.push(mediaUrl);
        api.logger.warn?.(
          `wecom(bot): webhook media send failed target=${mediaUrl} type=${target.type} reason=${String(err?.message || err)}`,
        );
      }
    }

    return {
      sentCount,
      failedCount: failedUrls.length,
      failedUrls,
      reason: failedUrls.length > 0 && sentCount === 0 ? "webhook-bot-media-failed" : "ok",
    };
  }

  async function deliverBotReplyText({
    api,
    fromUser,
    sessionId,
    streamId,
    responseUrl,
    text,
    mediaUrl,
    mediaUrls,
    mediaType,
    reason = "reply",
  } = {}) {
    const fallbackPolicy = resolveWecomDeliveryFallbackPolicy(api);
    const webhookBotPolicy = resolveWecomWebhookBotDeliveryPolicy(api);
    const observabilityPolicy = resolveWecomObservabilityPolicy(api);
    const botProxyUrl = resolveWecomBotProxyConfig(api);
    const normalizedText = String(text ?? "").trim();
    const normalizedMediaUrls = normalizeWecomBotOutboundMediaUrls({ mediaUrl, mediaUrls });
    const mixedPayload = buildWecomBotMixedPayload({
      text: normalizedText,
      mediaUrls: normalizedMediaUrls,
    });
    const mediaFallbackSuffix =
      normalizedMediaUrls.length > 0 ? `\n\n媒体链接：\n${normalizedMediaUrls.join("\n")}` : "";
    const fallbackText = normalizedText || "已收到模型返回的媒体结果，请查看以下链接。";

    const normalizedSessionId = String(sessionId ?? "").trim() || buildWecomBotSessionId(fromUser);
    const inlineResponseUrl = String(responseUrl ?? "").trim();
    if (inlineResponseUrl) {
      upsertBotResponseUrlCache({
        sessionId: normalizedSessionId,
        responseUrl: inlineResponseUrl,
      });
    }
    const cachedResponseUrl = getBotResponseUrlCache(normalizedSessionId);
    const traceId = createDeliveryTraceId("wecom-bot");
    const router = createWecomDeliveryRouter({
      logger: api.logger,
      fallbackConfig: fallbackPolicy,
      observability: observabilityPolicy,
      handlers: {
        active_stream: async ({ text: content }) => {
          if (normalizedMediaUrls.length > 0) {
            return { ok: false, reason: "stream-media-unsupported" };
          }
          if (!streamId || !hasBotStream(streamId)) {
            return { ok: false, reason: "stream-missing" };
          }
          finishBotStream(streamId, content);
          return {
            ok: true,
            meta: {
              streamId,
            },
          };
        },
        response_url: async ({ text: content }) => {
          const targetUrl = inlineResponseUrl || cachedResponseUrl?.url || "";
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
            logger: api.logger,
            proxyUrl: botProxyUrl,
            timeoutMs: webhookBotPolicy.timeoutMs,
          });
          markBotResponseUrlUsed(normalizedSessionId);
          return {
            ok: true,
            meta: {
              status: result.status,
              errcode: result.errcode ?? 0,
            },
          };
        },
        webhook_bot: async ({ text: content }) => {
          if (!webhookBotPolicy.enabled) {
            return { ok: false, reason: "webhook-bot-disabled" };
          }
          const sendUrl = resolveWebhookBotSendUrlFn({
            url: webhookBotPolicy.url,
            key: webhookBotPolicy.key,
          });
          if (!sendUrl) {
            return { ok: false, reason: "webhook-bot-url-missing" };
          }

          const dispatcher = resolveWebhookDispatcher(sendUrl, botProxyUrl, api.logger);
          const textPayload = `${content || fallbackText}`.trim();
          let sentAny = false;

          if (textPayload && (normalizedText || normalizedMediaUrls.length === 0)) {
            await webhookSendTextFn({
              url: webhookBotPolicy.url,
              key: webhookBotPolicy.key,
              content: textPayload,
              timeoutMs: webhookBotPolicy.timeoutMs,
              dispatcher,
              fetchImpl,
            });
            sentAny = true;
          }

          let mediaMeta = { sentCount: 0, failedCount: 0, failedUrls: [] };
          if (normalizedMediaUrls.length > 0) {
            mediaMeta = await sendWebhookBotMediaBatch({
              api,
              webhookBotPolicy,
              proxyUrl: botProxyUrl,
              mediaUrls: normalizedMediaUrls,
              mediaType,
            });
            sentAny = sentAny || mediaMeta.sentCount > 0;
          }

          if (!sentAny) {
            return { ok: false, reason: mediaMeta.reason || "webhook-bot-send-failed" };
          }

          if (mediaMeta.failedCount > 0) {
            await webhookSendTextFn({
              url: webhookBotPolicy.url,
              key: webhookBotPolicy.key,
              content: `以下媒体回传失败，已自动降级为链接：\n${mediaMeta.failedUrls.join("\n")}`,
              timeoutMs: webhookBotPolicy.timeoutMs,
              dispatcher,
              fetchImpl,
            });
          }

          return {
            ok: true,
            meta: {
              mediaSent: mediaMeta.sentCount,
              mediaFailed: mediaMeta.failedCount,
            },
          };
        },
        agent_push: async ({ text: content }) => {
          const account = getWecomConfig(api, "default") ?? getWecomConfig(api);
          if (!account?.corpId || !account?.corpSecret || !account?.agentId) {
            return { ok: false, reason: "agent-config-missing" };
          }
          await sendWecomText({
            corpId: account.corpId,
            corpSecret: account.corpSecret,
            agentId: account.agentId,
            toUser: fromUser,
            text: `${content || fallbackText}${mediaFallbackSuffix}`.trim(),
            logger: api.logger,
            proxyUrl: account.outboundProxy,
          });
          return {
            ok: true,
            meta: {
              accountId: account.accountId || "default",
            },
          };
        },
      },
    });

    return router.deliverText({
      text: normalizedText || fallbackText,
      traceId,
      meta: {
        reason,
        fromUser,
        sessionId: normalizedSessionId,
        streamId: streamId || "",
        hasResponseUrl: Boolean(inlineResponseUrl || cachedResponseUrl?.url),
        mediaCount: normalizedMediaUrls.length,
      },
    });
  }

  return {
    deliverBotReplyText,
    sendWecomBotPayloadViaResponseUrl,
  };
}
