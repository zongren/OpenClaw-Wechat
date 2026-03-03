import assert from "node:assert/strict";
import test from "node:test";

import { prepareWecomAgentRuntimeContext } from "../src/wecom/agent-runtime-context.js";

function createRuntimeMocks() {
  const recordedSessions = [];
  const activities = [];
  return {
    runtime: {
      channel: {
        session: {
          resolveStorePath: (_store, { agentId }) => `/tmp/store/${agentId || "main"}`,
          recordInboundSession: async (payload) => {
            recordedSessions.push(payload);
          },
        },
        reply: {
          resolveEnvelopeFormatOptions: () => ({ envelope: true }),
          formatInboundEnvelope: (payload) => ({ ...payload, formatted: true }),
          finalizeInboundContext: (payload) => ({ ...payload, SessionId: "agent-runtime-session-1" }),
        },
        activity: {
          record: (payload) => activities.push(payload),
        },
      },
    },
    recordedSessions,
    activities,
  };
}

test("prepareWecomAgentRuntimeContext builds route/context and records session", async () => {
  const logs = [];
  const { runtime, recordedSessions, activities } = createRuntimeMocks();
  const result = await prepareWecomAgentRuntimeContext({
    api: {
      logger: {
        info: (line) => logs.push(String(line)),
        warn: (line) => logs.push(String(line)),
      },
    },
    runtime,
    cfg: { session: { store: "default" } },
    baseSessionId: "wecom:user-a",
    fromUser: "user-a",
    chatId: "chat-1",
    isGroupChat: false,
    msgId: "msg-1",
    messageText: "hello",
    commandBody: "hello",
    originalContent: "hello",
    fromAddress: "wecom:user-a",
    accountId: "default",
    groupChatPolicy: { mentionPatterns: ["@bot"] },
    dynamicAgentPolicy: { workspaceTemplate: "tpl" },
    isAdminUser: false,
    resolveWecomAgentRoute: () => ({ agentId: "main", sessionKey: "wecom:user-a" }),
    seedDynamicAgentWorkspace: async () => {},
    buildWecomInboundEnvelopePayload: ({ messageText }) => ({ text: messageText }),
    buildWecomInboundContextPayload: ({ messageText, sessionId }) => ({ messageText, sessionId }),
  });

  assert.equal(result.routedAgentId, "main");
  assert.equal(result.sessionId, "wecom:user-a");
  assert.equal(result.storePath, "/tmp/store/main");
  assert.equal(result.accountId, "default");
  assert.equal(recordedSessions.length, 1);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].channel, "wecom");
  assert.ok(logs.some((line) => line.includes("wecom: routed agent=main")));
});

test("prepareWecomAgentRuntimeContext swallows workspace seed failure", async () => {
  const warns = [];
  const { runtime } = createRuntimeMocks();
  const result = await prepareWecomAgentRuntimeContext({
    api: {
      logger: {
        info() {},
        warn: (line) => warns.push(String(line)),
      },
    },
    runtime,
    cfg: { session: { store: "default" } },
    baseSessionId: "wecom:user-b",
    fromUser: "user-b",
    chatId: "",
    isGroupChat: false,
    msgId: "msg-2",
    messageText: "hello",
    commandBody: "hello",
    originalContent: "hello",
    fromAddress: "wecom:user-b",
    accountId: "default",
    groupChatPolicy: {},
    dynamicAgentPolicy: {},
    isAdminUser: false,
    resolveWecomAgentRoute: () => ({ agentId: "main", sessionKey: "wecom:user-b" }),
    seedDynamicAgentWorkspace: async () => {
      throw new Error("seed failed");
    },
    buildWecomInboundEnvelopePayload: ({ messageText }) => ({ text: messageText }),
    buildWecomInboundContextPayload: ({ messageText, sessionId }) => ({ messageText, sessionId }),
  });

  assert.equal(result.sessionId, "wecom:user-b");
  assert.equal(warns.length > 0, true);
  assert.ok(warns.some((line) => line.includes("workspace seed failed")));
});
