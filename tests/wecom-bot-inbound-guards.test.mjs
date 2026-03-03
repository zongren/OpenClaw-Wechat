import assert from "node:assert/strict";
import test from "node:test";

import { applyWecomBotCommandAndSenderGuard, applyWecomBotGroupChatGuard } from "../src/wecom/bot-inbound-guards.js";

test("applyWecomBotGroupChatGuard rejects disabled group processing", () => {
  const result = applyWecomBotGroupChatGuard({
    isGroupChat: true,
    msgType: "text",
    commandBody: "hello",
    groupChatPolicy: { enabled: false },
    shouldTriggerWecomGroupResponse: () => true,
    shouldStripWecomGroupMentions: () => false,
    stripWecomGroupMentions: (text) => text,
  });
  assert.equal(result.ok, false);
  assert.equal(result.finishText, "当前群聊消息处理未启用。");
});

test("applyWecomBotGroupChatGuard rejects untriggered mention mode with hint", () => {
  const result = applyWecomBotGroupChatGuard({
    isGroupChat: true,
    msgType: "text",
    commandBody: "hello",
    groupChatPolicy: { enabled: true, triggerMode: "mention" },
    shouldTriggerWecomGroupResponse: () => false,
    shouldStripWecomGroupMentions: () => false,
    stripWecomGroupMentions: (text) => text,
  });
  assert.equal(result.ok, false);
  assert.equal(result.finishText, "请先 @ 机器人后再发送消息。");
});

test("applyWecomBotGroupChatGuard strips mentions when configured", () => {
  const result = applyWecomBotGroupChatGuard({
    isGroupChat: true,
    msgType: "text",
    commandBody: "@bot hello",
    groupChatPolicy: { enabled: true, triggerMode: "mention", mentionPatterns: ["@bot"] },
    shouldTriggerWecomGroupResponse: () => true,
    shouldStripWecomGroupMentions: () => true,
    stripWecomGroupMentions: () => "hello",
  });
  assert.equal(result.ok, true);
  assert.equal(result.commandBody, "hello");
});

test("applyWecomBotCommandAndSenderGuard blocks unauthorized sender", () => {
  const result = applyWecomBotCommandAndSenderGuard({
    api: {},
    fromUser: "u1",
    msgType: "text",
    commandBody: "hello",
    normalizedFromUser: "u1",
    resolveWecomCommandPolicy: () => ({ enabled: true, adminUsers: [], allowlist: [], rejectMessage: "cmd blocked" }),
    resolveWecomAllowFromPolicy: () => ({ allowFrom: ["u2"], rejectMessage: "当前账号未授权，请联系管理员。" }),
    isWecomSenderAllowed: ({ senderId, allowFrom }) => allowFrom.includes(senderId),
    extractLeadingSlashCommand: () => "",
    buildWecomBotHelpText: () => "help",
    buildWecomBotStatusText: () => "status",
  });
  assert.equal(result.ok, false);
  assert.equal(result.finishText, "当前账号未授权，请联系管理员。");
});

test("applyWecomBotCommandAndSenderGuard translates /clear to /reset", () => {
  const result = applyWecomBotCommandAndSenderGuard({
    api: {},
    fromUser: "u1",
    msgType: "text",
    commandBody: "/clear now",
    normalizedFromUser: "u1",
    resolveWecomCommandPolicy: () => ({
      enabled: true,
      adminUsers: [],
      allowlist: ["/clear", "/reset"],
      rejectMessage: "cmd blocked",
    }),
    resolveWecomAllowFromPolicy: () => ({ allowFrom: ["u1"], rejectMessage: "blocked" }),
    isWecomSenderAllowed: ({ senderId, allowFrom }) => allowFrom.includes(senderId),
    extractLeadingSlashCommand: (text) => {
      if (text.startsWith("/clear")) return "/clear";
      if (text.startsWith("/reset")) return "/reset";
      return "";
    },
    buildWecomBotHelpText: () => "help",
    buildWecomBotStatusText: () => "status",
  });
  assert.equal(result.ok, true);
  assert.equal(result.commandBody.startsWith("/reset"), true);
});

test("applyWecomBotCommandAndSenderGuard handles /help and /status directly", () => {
  const common = {
    api: {},
    fromUser: "u1",
    msgType: "text",
    normalizedFromUser: "u1",
    resolveWecomCommandPolicy: () => ({
      enabled: true,
      adminUsers: [],
      allowlist: ["/help", "/status"],
      rejectMessage: "cmd blocked",
    }),
    resolveWecomAllowFromPolicy: () => ({ allowFrom: ["u1"], rejectMessage: "blocked" }),
    isWecomSenderAllowed: ({ senderId, allowFrom }) => allowFrom.includes(senderId),
    buildWecomBotHelpText: () => "help text",
    buildWecomBotStatusText: () => "status text",
  };

  const helpResult = applyWecomBotCommandAndSenderGuard({
    ...common,
    commandBody: "/help",
    extractLeadingSlashCommand: () => "/help",
  });
  assert.equal(helpResult.ok, false);
  assert.equal(helpResult.finishText, "help text");

  const statusResult = applyWecomBotCommandAndSenderGuard({
    ...common,
    commandBody: "/status",
    extractLeadingSlashCommand: () => "/status",
  });
  assert.equal(statusResult.ok, false);
  assert.equal(statusResult.finishText, "status text");
});
