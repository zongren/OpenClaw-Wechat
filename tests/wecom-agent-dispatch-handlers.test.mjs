import assert from "node:assert/strict";
import test from "node:test";

import {
  appendWecomAgentBlockFallback,
  createWecomAgentDispatchHandlers,
} from "../src/wecom/agent-dispatch-handlers.js";

function createBaseDeps(overrides = {}) {
  const sentTexts = [];
  const state = {
    hasDeliveredReply: false,
    hasDeliveredPartialReply: false,
    hasDeliveredFinalText: false,
    hasSentProgressNotice: false,
    blockTextFallback: "",
    streamChunkBuffer: "",
    streamChunkLastSentAt: 0,
    streamChunkSentCount: 0,
    streamChunkSendChain: Promise.resolve(),
    suppressLateDispatcherDeliveries: false,
  };
  const deps = {
    api: { logger: { info() {}, warn() {}, error() {} } },
    state,
    streamingEnabled: false,
    fromUser: "dingxiang",
    routedAgentId: "main",
    corpId: "ww1",
    corpSecret: "s1",
    agentId: "100001",
    proxyUrl: "",
    flushStreamingBuffer: async () => false,
    sendFailureFallback: async () => {
      state.hasDeliveredReply = true;
      sentTexts.push("fallback");
    },
    sendTextToUser: async (text) => {
      sentTexts.push(String(text));
    },
    markdownToWecomText: (text) => String(text),
    isAgentFailureText: () => false,
    computeStreamingTailText: () => "",
    autoSendWorkspaceFilesFromReplyText: async () => ({ sent: [], failed: [] }),
    buildWorkspaceAutoSendHints: () => [],
    sendWecomOutboundMediaBatch: async () => ({ sentCount: 0, failed: [] }),
    ...overrides,
  };
  return { deps, state, sentTexts };
}

test("appendWecomAgentBlockFallback appends with newline", () => {
  assert.equal(appendWecomAgentBlockFallback("", "a"), "a");
  assert.equal(appendWecomAgentBlockFallback("a", "b"), "a\nb");
  assert.equal(appendWecomAgentBlockFallback("a\nb", "c"), "a\nb\nc");
});

test("createWecomAgentDispatchHandlers handles block payload with streaming", async () => {
  const { deps, state } = createBaseDeps({
    streamingEnabled: true,
    flushStreamingBuffer: async () => true,
  });
  const handlers = createWecomAgentDispatchHandlers(deps);

  await handlers.deliver({ text: "first block" }, { kind: "block" });
  await handlers.deliver({ text: "second block" }, { kind: "block" });

  assert.equal(state.blockTextFallback, "first block\nsecond block");
  assert.equal(state.streamChunkBuffer, "first blocksecond block");
  assert.equal(state.hasDeliveredReply, false);
});

test("createWecomAgentDispatchHandlers sends formatted final text with workspace hints", async () => {
  const { deps, state, sentTexts } = createBaseDeps({
    autoSendWorkspaceFilesFromReplyText: async () => ({
      sent: [{ path: "/workspace/a.png" }],
      failed: [{ path: "/workspace/b.png", reason: "not found" }],
    }),
    buildWorkspaceAutoSendHints: ({ sent, failed }) => [
      `sent:${sent.length}`,
      `failed:${failed.length}`,
    ],
  });
  const handlers = createWecomAgentDispatchHandlers(deps);

  await handlers.deliver({ text: "hello final" }, { kind: "final" });

  assert.equal(state.hasDeliveredReply, true);
  assert.equal(state.hasDeliveredFinalText, true);
  assert.equal(sentTexts.length, 1);
  assert.equal(sentTexts[0], "hello final\n\nsent:1\n\nfailed:1");
});

test("createWecomAgentDispatchHandlers handles final failure and onError", async () => {
  const { deps, state, sentTexts } = createBaseDeps({
    isAgentFailureText: () => true,
  });
  const handlers = createWecomAgentDispatchHandlers(deps);

  await handlers.deliver({ text: "request was aborted" }, { kind: "final" });
  assert.equal(state.hasDeliveredReply, true);
  assert.deepEqual(sentTexts, ["fallback"]);

  state.hasDeliveredReply = false;
  sentTexts.length = 0;
  await handlers.onError(new Error("boom"), { kind: "final" });
  assert.equal(state.hasDeliveredReply, true);
  assert.deepEqual(sentTexts, ["fallback"]);
});

test("createWecomAgentDispatchHandlers delivers tail when final arrives after partial finalization", async () => {
  const sentTexts = [];
  const state = {
    hasDeliveredReply: true,
    hasDeliveredPartialReply: true,
    hasDeliveredFinalText: false,
    hasSentProgressNotice: false,
    blockTextFallback: "Hello, here is",
    streamChunkBuffer: "",
    streamChunkLastSentAt: 0,
    streamChunkSentCount: 2,
    streamChunkSendChain: Promise.resolve(),
    suppressLateDispatcherDeliveries: false,
  };
  const { deps } = createBaseDeps({
    state,
    streamingEnabled: true,
    sendTextToUser: async (text) => sentTexts.push(String(text)),
    markdownToWecomText: (text) => String(text),
    computeStreamingTailText: ({ finalText, streamedText }) => {
      if (finalText.startsWith(streamedText)) return finalText.slice(streamedText.length).trim();
      return "";
    },
  });
  const handlers = createWecomAgentDispatchHandlers(deps);

  await handlers.deliver({ text: "Hello, here is the full answer." }, { kind: "final" });

  assert.deepEqual(sentTexts, ["the full answer."]);
  assert.equal(state.hasDeliveredFinalText, true);
});

test("createWecomAgentDispatchHandlers delivers additional final when hasDeliveredFinalText is already true", async () => {
  const sentTexts = [];
  const state = {
    hasDeliveredReply: true,
    hasDeliveredPartialReply: true,
    hasDeliveredFinalText: true,
    hasSentProgressNotice: false,
    blockTextFallback: "Hello, here is the full answer.",
    streamChunkBuffer: "",
    streamChunkLastSentAt: 0,
    streamChunkSentCount: 3,
    streamChunkSendChain: Promise.resolve(),
    suppressLateDispatcherDeliveries: false,
  };
  const { deps } = createBaseDeps({
    state,
    streamingEnabled: false,
    sendTextToUser: async (text) => sentTexts.push(String(text)),
  });
  const handlers = createWecomAgentDispatchHandlers(deps);

  await handlers.deliver({ text: "Here are the actual final results." }, { kind: "final" });

  assert.deepEqual(sentTexts, ["Here are the actual final results."]);
});
