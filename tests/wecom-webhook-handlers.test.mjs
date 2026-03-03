import assert from "node:assert/strict";
import test from "node:test";

import { createWecomBotWebhookHandler } from "../src/wecom/bot-webhook-handler.js";
import { createWecomAgentWebhookHandler } from "../src/wecom/agent-webhook-handler.js";

function createResponseMock() {
  const headers = {};
  let body = "";
  const res = {
    statusCode: 0,
    writableEnded: false,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    end(chunk = "") {
      body = String(chunk ?? "");
      this.writableEnded = true;
    },
  };
  return {
    res,
    getBody: () => body,
    getHeader: (name) => headers[String(name).toLowerCase()],
  };
}

test("bot webhook handler returns health text on GET without echostr", async () => {
  const { res, getBody, getHeader } = createResponseMock();
  const handler = createWecomBotWebhookHandler({
    api: { logger: {} },
    botConfig: {
      token: "token",
      encodingAesKey: "a".repeat(43),
      placeholderText: "处理中",
      streamExpireMs: 600000,
    },
    normalizedPath: "/wecom/bot/callback",
    readRequestBody: async () => "",
    parseIncomingJson: () => ({}),
    computeMsgSignature: () => "",
    decryptWecom: () => ({ msg: "" }),
    parseWecomBotInboundMessage: () => null,
    describeWecomBotParsedMessage: () => "n/a",
    cleanupExpiredBotStreams: () => {},
    getBotStream: () => null,
    buildWecomBotEncryptedResponse: () => "{}",
    markInboundMessageSeen: () => true,
    buildWecomBotSessionId: () => "wecom-bot:test",
    createBotStream: () => ({}),
    upsertBotResponseUrlCache: () => {},
    messageProcessLimiter: { execute: async (fn) => fn() },
    executeInboundTaskWithSessionQueue: async ({ task }) => task(),
    processBotInboundMessage: async () => {},
    deliverBotReplyText: async () => ({ ok: true }),
    finishBotStream: () => ({}),
  });

  await handler({ method: "GET", url: "/wecom/bot/callback" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(getHeader("content-type"), "text/plain; charset=utf-8");
  assert.equal(getBody(), "wecom bot webhook ok");
});

test("agent webhook handler health reflects signed account availability", async () => {
  const baseDeps = {
    readRequestBody: async () => "",
    parseIncomingXml: () => ({}),
    pickAccountBySignature: () => null,
    decryptWecom: () => ({ msg: "" }),
    markInboundMessageSeen: () => true,
    extractWecomXmlInboundEnvelope: () => ({}),
    buildWecomSessionId: () => "wecom:test",
    scheduleTextInboundProcessing: () => {},
    messageProcessLimiter: { execute: async (fn) => fn() },
    executeInboundTaskWithSessionQueue: async ({ task }) => task(),
    processInboundMessage: async () => {},
  };

  {
    const { res, getBody } = createResponseMock();
    const handler = createWecomAgentWebhookHandler({
      api: { logger: {} },
      accounts: [{ accountId: "default", callbackToken: "t", callbackAesKey: "k" }],
      ...baseDeps,
    });
    await handler({ method: "GET", url: "/wecom/callback" }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(getBody(), "wecom webhook ok");
  }

  {
    const { res, getBody } = createResponseMock();
    const handler = createWecomAgentWebhookHandler({
      api: { logger: {} },
      accounts: [{ accountId: "default", callbackToken: "", callbackAesKey: "" }],
      ...baseDeps,
    });
    await handler({ method: "GET", url: "/wecom/callback" }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(getBody(), "wecom webhook not configured");
  }

  {
    const { res, getBody } = createResponseMock();
    const handler = createWecomAgentWebhookHandler({
      api: { logger: {} },
      accounts: undefined,
      ...baseDeps,
    });
    await handler({ method: "GET", url: "/wecom/callback" }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(getBody(), "wecom webhook not configured");
  }
});
