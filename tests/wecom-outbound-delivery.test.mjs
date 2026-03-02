import assert from "node:assert/strict";
import test from "node:test";

import { createWecomBotReplyDeliverer } from "../src/wecom/outbound-delivery.js";

function createApiMock() {
  return {
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  };
}

function createDeliverer(overrides = {}) {
  const responseUrlCache = new Map();
  const finishedStreams = [];
  const sentMessages = [];

  const base = {
    attachWecomProxyDispatcher: (_url, options) => options,
    resolveWecomDeliveryFallbackPolicy: () => ({
      enabled: false,
      order: ["active_stream", "response_url", "webhook_bot", "agent_push"],
    }),
    resolveWecomWebhookBotDeliveryPolicy: () => ({
      enabled: false,
      url: "",
      key: "",
      timeoutMs: 8000,
    }),
    resolveWecomObservabilityPolicy: () => ({ enabled: false, logPayloadMeta: true }),
    resolveWecomBotProxyConfig: () => "",
    buildWecomBotSessionId: (fromUser) => `wecom-bot:${String(fromUser ?? "").trim().toLowerCase()}`,
    upsertBotResponseUrlCache: ({ sessionId, responseUrl }) => {
      responseUrlCache.set(sessionId, {
        url: responseUrl,
        used: false,
      });
    },
    getBotResponseUrlCache: (sessionId) => responseUrlCache.get(sessionId) ?? null,
    markBotResponseUrlUsed: (sessionId) => {
      const row = responseUrlCache.get(sessionId);
      if (row) row.used = true;
    },
    createDeliveryTraceId: () => "trace-test",
    hasBotStream: (streamId) => streamId === "stream-ok",
    finishBotStream: (streamId, content) => {
      finishedStreams.push({ streamId, content });
    },
    getWecomConfig: () => ({
      accountId: "default",
      corpId: "ww-test",
      corpSecret: "secret",
      agentId: "1000002",
      outboundProxy: "",
    }),
    sendWecomText: async ({ toUser, text }) => {
      sentMessages.push({ toUser, text });
    },
    fetchMediaFromUrl: async () => ({
      buffer: Buffer.from("media"),
      contentType: "image/png",
    }),
  };

  return {
    ...createWecomBotReplyDeliverer({
      ...base,
      ...overrides,
    }),
    finishedStreams,
    sentMessages,
  };
}

test("deliverBotReplyText uses active_stream when available", async () => {
  const deliverer = createDeliverer();
  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    sessionId: "wecom-bot:dingxiang",
    streamId: "stream-ok",
    text: "hello",
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "active_stream");
  assert.equal(result.deliveryPath, "active_stream");
  assert.equal(result.finalStatus, "ok");
  assert.deepEqual(deliverer.finishedStreams, [{ streamId: "stream-ok", content: "hello" }]);
});

test("deliverBotReplyText falls back to agent_push with media links", async () => {
  const deliverer = createDeliverer({
    resolveWecomDeliveryFallbackPolicy: () => ({
      enabled: true,
      order: ["active_stream", "response_url", "webhook_bot", "agent_push"],
    }),
    hasBotStream: () => false,
  });

  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    sessionId: "wecom-bot:dingxiang",
    streamId: "stream-missing",
    text: "已完成",
    mediaUrls: ["https://example.com/a.png"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "agent_push");
  assert.equal(result.deliveryPath, "agent_push");
  assert.equal(result.finalStatus, "degraded");
  assert.equal(result.attempts[0].status, "miss");
  assert.equal(result.attempts[result.attempts.length - 1].status, "ok");
  assert.equal(deliverer.sentMessages.length, 1);
  assert.match(deliverer.sentMessages[0].text, /媒体链接/);
  assert.match(deliverer.sentMessages[0].text, /https:\/\/example.com\/a\.png/);
});

test("deliverBotReplyText sends webhook media when webhook bot enabled", async () => {
  const webhookCalls = {
    text: [],
    image: [],
  };
  const deliverer = createDeliverer({
    resolveWecomDeliveryFallbackPolicy: () => ({
      enabled: true,
      order: ["active_stream", "webhook_bot", "agent_push"],
    }),
    resolveWecomWebhookBotDeliveryPolicy: () => ({
      enabled: true,
      url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
      key: "",
      timeoutMs: 8000,
    }),
    hasBotStream: () => false,
    resolveWebhookBotSendUrlFn: () => "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
    webhookSendTextFn: async (payload) => {
      webhookCalls.text.push(payload);
    },
    webhookSendImageFn: async (payload) => {
      webhookCalls.image.push(payload);
    },
    webhookSendFileBufferFn: async () => {},
    fetchMediaFromUrl: async () => ({
      buffer: Buffer.from("image-binary"),
      contentType: "image/png",
    }),
  });

  const result = await deliverer.deliverBotReplyText({
    api: createApiMock(),
    fromUser: "dingxiang",
    sessionId: "wecom-bot:dingxiang",
    streamId: "stream-missing",
    text: "这是结果",
    mediaUrls: ["https://example.com/a.png"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.layer, "webhook_bot");
  assert.equal(webhookCalls.text.length, 1);
  assert.equal(webhookCalls.image.length, 1);
});
