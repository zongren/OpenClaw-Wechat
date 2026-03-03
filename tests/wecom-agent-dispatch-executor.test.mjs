import assert from "node:assert/strict";
import test from "node:test";

import { executeWecomAgentDispatchFlow } from "../src/wecom/agent-dispatch-executor.js";

function createBaseInput(overrides = {}) {
  const sentTexts = [];
  const cleanupCalls = [];
  const watcherReasons = [];
  const runtime = {
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async ({ dispatcherOptions }) => {
          await dispatcherOptions.deliver({ text: "final reply" }, { kind: "final" });
          return { counts: { final: 1 }, queuedFinal: false };
        },
      },
    },
  };
  return {
    input: {
      api: {
        logger: {
          info() {},
          warn() {},
          error() {},
        },
      },
      runtime,
      cfg: { env: { vars: {} } },
      ctxPayload: { SessionId: "session-runtime-1" },
      sessionId: "wecom:u1",
      routedAgentId: "main",
      runtimeAccountId: "default",
      msgId: "msg-1",
      storePath: "/tmp/store/main",
      fromUser: "u1",
      corpId: "ww-test",
      corpSecret: "secret",
      agentId: "100001",
      proxyUrl: "",
      tempPathsToCleanup: ["/tmp/a", "/tmp/b"],
      resolveWecomReplyStreamingPolicy: () => ({ enabled: false }),
      asNumber: (value, fallback) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
      },
      requireEnv: () => undefined,
      getByteLength: (text) => Buffer.byteLength(String(text ?? ""), "utf8"),
      markdownToWecomText: (text) => String(text ?? ""),
      autoSendWorkspaceFilesFromReplyText: async () => ({ sentCount: 0, failed: [] }),
      sendWecomOutboundMediaBatch: async () => ({ sentCount: 0, failed: [] }),
      withTimeout: async (promise) => promise,
      isDispatchTimeoutError: () => false,
      isAgentFailureText: () => false,
      scheduleTempFileCleanup: (filePath) => cleanupCalls.push(String(filePath)),
      ensureLateReplyWatcherRunner: () => async ({ reason }) => {
        watcherReasons.push(String(reason));
      },
      ACTIVE_LATE_REPLY_WATCHERS: new Map(),
      sendTextToUser: async (text) => sentTexts.push(String(text)),
      ...overrides,
    },
    sentTexts,
    cleanupCalls,
    watcherReasons,
  };
}

test("executeWecomAgentDispatchFlow dispatches final reply and cleans temp files", async () => {
  const { input, sentTexts, cleanupCalls, watcherReasons } = createBaseInput();
  await executeWecomAgentDispatchFlow(input);
  assert.equal(sentTexts.length, 1);
  assert.equal(sentTexts[0], "final reply");
  assert.deepEqual(cleanupCalls, ["/tmp/a", "/tmp/b"]);
  assert.equal(watcherReasons.length, 0);
});

test("executeWecomAgentDispatchFlow starts late watcher on timeout", async () => {
  const { input, sentTexts, cleanupCalls, watcherReasons } = createBaseInput({
    runtime: {
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async () => new Promise(() => {}),
        },
      },
    },
    withTimeout: async () => {
      throw new Error("dispatch timed out after 90000ms");
    },
    isDispatchTimeoutError: (err) => String(err?.message || "").includes("timed out"),
  });
  await executeWecomAgentDispatchFlow(input);
  assert.equal(sentTexts.length, 0);
  assert.equal(watcherReasons.length, 1);
  assert.equal(watcherReasons[0], "dispatch-timeout");
  assert.deepEqual(cleanupCalls, ["/tmp/a", "/tmp/b"]);
});

test("executeWecomAgentDispatchFlow uses failure fallback for non-timeout errors", async () => {
  const { input, sentTexts, watcherReasons } = createBaseInput({
    runtime: {
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async () => new Promise(() => {}),
        },
      },
    },
    withTimeout: async () => {
      throw new Error("unexpected failure");
    },
    isDispatchTimeoutError: () => false,
  });
  await executeWecomAgentDispatchFlow(input);
  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0], /抱歉，当前模型请求超时或网络不稳定/);
  assert.equal(watcherReasons.length, 0);
});
