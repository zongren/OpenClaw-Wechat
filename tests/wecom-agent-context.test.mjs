import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWecomInboundContextPayload,
  buildWecomInboundEnvelopePayload,
} from "../src/wecom/agent-context.js";

test("buildWecomInboundEnvelopePayload builds group envelope", () => {
  const payload = buildWecomInboundEnvelopePayload({
    fromUser: "dingxiang",
    chatId: "chat-1",
    isGroupChat: true,
    messageText: "hello",
    timestamp: 123,
  });
  assert.deepEqual(payload, {
    channel: "WeCom",
    from: "dingxiang (group:chat-1)",
    timestamp: 123,
    body: "hello",
    chatType: "group",
    sender: {
      name: "dingxiang",
      id: "dingxiang",
    },
  });
});

test("buildWecomInboundContextPayload builds direct context payload", () => {
  const payload = buildWecomInboundContextPayload({
    body: "formatted",
    messageText: "raw",
    originalContent: "orig",
    commandBody: "/reset",
    commandAuthorized: true,
    commandSource: "text",
    fromAddress: "wecom:dingxiang",
    sessionId: "wecom:dingxiang",
    accountId: "default",
    isGroupChat: false,
    chatId: "",
    fromUser: "dingxiang",
    msgId: "msg-1",
    timestamp: 456,
  });
  assert.equal(payload.Body, "formatted");
  assert.equal(payload.BodyForAgent, "raw");
  assert.equal(payload.BodyForCommands, "/reset");
  assert.equal(payload.RawBody, "orig");
  assert.equal(payload.CommandBody, "/reset");
  assert.equal(payload.CommandAuthorized, true);
  assert.equal(payload.CommandSource, "text");
  assert.equal(payload.From, "wecom:dingxiang");
  assert.equal(payload.To, "wecom:dingxiang");
  assert.equal(payload.SessionKey, "wecom:dingxiang");
  assert.equal(payload.AccountId, "default");
  assert.equal(payload.ChatType, "direct");
  assert.equal(payload.ConversationLabel, "dingxiang");
  assert.equal(payload.SenderName, "dingxiang");
  assert.equal(payload.SenderId, "dingxiang");
  assert.equal(payload.Provider, "wechat_work");
  assert.equal(payload.Surface, "wechat_work");
  assert.equal(payload.MessageSid, "msg-1");
  assert.equal(payload.Timestamp, 456);
  assert.equal(payload.OriginatingChannel, "wechat_work");
  assert.equal(payload.OriginatingTo, "wechat_work:dingxiang");
});

test("buildWecomInboundContextPayload normalizes SenderId to lowercase", () => {
  const payload = buildWecomInboundContextPayload({
    body: "formatted",
    messageText: "raw",
    originalContent: "orig",
    commandBody: "",
    fromAddress: "wecom:dingxiang",
    sessionId: "wecom:dingxiang",
    accountId: "default",
    isGroupChat: false,
    fromUser: "DingXiang",
  });

  assert.equal(payload.SenderName, "DingXiang");
  assert.equal(payload.SenderId, "dingxiang");
});

test("buildWecomInboundContextPayload keeps command fields disabled for normal text", () => {
  const payload = buildWecomInboundContextPayload({
    body: "formatted",
    messageText: "hello",
    originalContent: "hello",
    commandBody: "hello",
    fromAddress: "wecom:dingxiang",
    sessionId: "wecom:dingxiang",
    accountId: "default",
    isGroupChat: false,
    chatId: "",
    fromUser: "dingxiang",
  });

  assert.equal(payload.BodyForCommands, "");
  assert.equal(payload.CommandAuthorized, false);
  assert.equal(payload.CommandSource, "");
});
