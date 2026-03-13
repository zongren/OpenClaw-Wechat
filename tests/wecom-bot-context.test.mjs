import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWecomBotInboundContextPayload,
  buildWecomBotInboundEnvelopePayload,
} from "../src/wecom/bot-context.js";

test("buildWecomBotInboundEnvelopePayload builds direct payload", () => {
  const payload = buildWecomBotInboundEnvelopePayload({
    fromUser: "dingxiang",
    chatId: "",
    isGroupChat: false,
    messageText: "hello bot",
    timestamp: 123,
  });
  assert.deepEqual(payload, {
    channel: "WeCom Bot",
    from: "dingxiang",
    timestamp: 123,
    body: "hello bot",
    chatType: "direct",
    sender: {
      name: "dingxiang",
      id: "dingxiang",
    },
  });
});

test("buildWecomBotInboundContextPayload builds group payload with defaults", () => {
  const payload = buildWecomBotInboundContextPayload({
    body: "formatted",
    messageText: "raw",
    originalContent: "orig",
    commandBody: "/reset",
    commandAuthorized: true,
    commandSource: "text",
    fromAddress: "wecom-bot:dingxiang",
    sessionId: "wecom-bot:dingxiang",
    accountId: "bot",
    isGroupChat: true,
    chatId: "room-1",
    fromUser: "dingxiang",
    msgId: "",
    timestamp: 456,
  });
  assert.equal(payload.Body, "formatted");
  assert.equal(payload.BodyForAgent, "raw");
  assert.equal(payload.BodyForCommands, "/reset");
  assert.equal(payload.RawBody, "orig");
  assert.equal(payload.CommandBody, "/reset");
  assert.equal(payload.CommandAuthorized, true);
  assert.equal(payload.CommandSource, "text");
  assert.equal(payload.From, "wecom-bot:dingxiang");
  assert.equal(payload.To, "wecom-bot:dingxiang");
  assert.equal(payload.SessionKey, "wecom-bot:dingxiang");
  assert.equal(payload.AccountId, "bot");
  assert.equal(payload.ChatType, "group");
  assert.equal(payload.ConversationLabel, "group:room-1");
  assert.equal(payload.SenderName, "dingxiang");
  assert.equal(payload.SenderId, "dingxiang");
  assert.equal(payload.Provider, "wechat_work");
  assert.equal(payload.Surface, "wechat_work-bot");
  assert.equal(payload.MessageSid, "wechat_work-bot-456");
  assert.equal(payload.Timestamp, 456);
  assert.equal(payload.OriginatingChannel, "wechat_work");
  assert.equal(payload.OriginatingTo, "wechat_work-bot:dingxiang");
});

test("buildWecomBotInboundContextPayload normalizes SenderId to lowercase", () => {
  const payload = buildWecomBotInboundContextPayload({
    body: "formatted",
    messageText: "raw",
    originalContent: "orig",
    commandBody: "",
    fromAddress: "wecom-bot:dingxiang",
    sessionId: "wecom-bot:dingxiang",
    fromUser: "DingXiang",
  });

  assert.equal(payload.SenderName, "DingXiang");
  assert.equal(payload.SenderId, "dingxiang");
});
