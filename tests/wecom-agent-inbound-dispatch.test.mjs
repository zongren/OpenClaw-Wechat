import assert from "node:assert/strict";
import test from "node:test";

import { createWecomAgentInboundDispatcher } from "../src/wecom/agent-inbound-dispatch.js";

function createContext() {
  const scheduled = [];
  const queuedCalls = [];
  const processedPayloads = [];
  const errors = [];

  const api = {
    logger: {
      error(message) {
        errors.push(String(message));
      },
    },
  };

  const dispatch = createWecomAgentInboundDispatcher({
    api,
    buildWecomSessionId: (fromUser) => `wecom:${fromUser}`,
    scheduleTextInboundProcessing: (_api, basePayload, content) => {
      scheduled.push({ basePayload, content });
    },
    messageProcessLimiter: {
      execute(fn) {
        queuedCalls.push("execute");
        return Promise.resolve().then(fn);
      },
    },
    executeInboundTaskWithSessionQueue: async ({ task, sessionId, isBot }) => {
      queuedCalls.push({ sessionId, isBot });
      return task();
    },
    processInboundMessage: async (payload) => {
      processedPayloads.push(payload);
    },
  });

  return {
    dispatch,
    scheduled,
    queuedCalls,
    processedPayloads,
    errors,
  };
}

test("dispatchWecomAgentInbound schedules text inbound", () => {
  const { dispatch, scheduled, processedPayloads } = createContext();
  const handled = dispatch({
    inbound: { msgType: "text", content: "你好" },
    basePayload: { fromUser: "u1" },
  });

  assert.equal(handled, true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].content, "你好");
  assert.equal(processedPayloads.length, 0);
});

test("dispatchWecomAgentInbound enqueues image inbound task", async () => {
  const { dispatch, queuedCalls, processedPayloads } = createContext();
  const handled = dispatch({
    inbound: { msgType: "image", mediaId: "m1", picUrl: "https://example.com/pic.jpg" },
    basePayload: { fromUser: "u1", accountId: "default" },
  });

  assert.equal(handled, true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(queuedCalls[0], "execute");
  assert.deepEqual(queuedCalls[1], { sessionId: "wecom:u1", isBot: false });
  assert.equal(processedPayloads.length, 1);
  assert.equal(processedPayloads[0].msgType, "image");
  assert.equal(processedPayloads[0].mediaId, "m1");
});

test("dispatchWecomAgentInbound returns false when media type lacks mediaId", () => {
  const { dispatch, queuedCalls, processedPayloads } = createContext();
  const handled = dispatch({
    inbound: { msgType: "voice", mediaId: "" },
    basePayload: { fromUser: "u1" },
  });

  assert.equal(handled, false);
  assert.equal(queuedCalls.length, 0);
  assert.equal(processedPayloads.length, 0);
});

test("dispatchWecomAgentInbound returns false for unsupported message type", () => {
  const { dispatch, queuedCalls, processedPayloads } = createContext();
  const handled = dispatch({
    inbound: { msgType: "event" },
    basePayload: { fromUser: "u1" },
  });

  assert.equal(handled, false);
  assert.equal(queuedCalls.length, 0);
  assert.equal(processedPayloads.length, 0);
});
