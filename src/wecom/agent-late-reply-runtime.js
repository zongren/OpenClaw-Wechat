function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomAgentLateReplyRuntime: ${name} is required`);
  }
}

export function createWecomAgentLateReplyRuntime({
  dispatchState,
  sessionId,
  msgId = "",
  transcriptSessionId = "",
  accountId = "default",
  storePath,
  lateReplyWatchMs,
  lateReplyPollMs,
  sendTextToUser,
  ensureLateReplyWatcherRunner,
  activeWatchers,
  now = () => Date.now(),
  randomToken = () => Math.random().toString(36).slice(2, 8),
  logger,
} = {}) {
  if (!dispatchState || typeof dispatchState !== "object") {
    throw new Error("createWecomAgentLateReplyRuntime: dispatchState is required");
  }
  assertFunction("sendTextToUser", sendTextToUser);
  assertFunction("ensureLateReplyWatcherRunner", ensureLateReplyWatcherRunner);
  assertFunction("now", now);
  assertFunction("randomToken", randomToken);

  let lateReplyWatcherPromise = null;

  const sendProgressNotice = async (text = "") => {
    const noticeText = String(text ?? "").trim();
    if (!noticeText) return false;
    if (dispatchState.hasDeliveredReply || dispatchState.hasDeliveredPartialReply || dispatchState.hasSentProgressNotice) {
      return false;
    }
    dispatchState.hasSentProgressNotice = true;
    await sendTextToUser(noticeText);
    return true;
  };

  const sendFailureFallback = async (reason) => {
    if (dispatchState.hasDeliveredReply) return false;
    dispatchState.hasDeliveredReply = true;
    const reasonText = String(reason ?? "unknown").slice(0, 160);
    await sendTextToUser(`抱歉，当前模型请求超时或网络不稳定，请稍后重试。\n故障信息: ${reasonText}`);
    return true;
  };

  const startLateReplyWatcher = (reason = "pending-final") => {
    // Allow watcher to start even if we've already delivered a reply, to catch late sub-agent outputs
    if (lateReplyWatcherPromise) return false;

    // When a reply was already delivered (watch-for-more case), use a per-watcher flag
    // so the watcher isn't immediately short-circuited by hasDeliveredReply=true.
    // Also pass a no-op markDelivered so the watcher keeps polling after each delivery,
    // allowing it to catch multiple additional finals from sub-agents.
    const alreadyDelivered = dispatchState.hasDeliveredReply || dispatchState.hasDeliveredPartialReply;
    const watcherDelivered = { value: false };
    const watchStartedAt = now();
    const watchId = `${sessionId}:${msgId || watchStartedAt}:${randomToken()}`;
    lateReplyWatcherPromise = ensureLateReplyWatcherRunner()({
      watchId,
      reason,
      sessionId,
      sessionTranscriptId: transcriptSessionId || sessionId,
      accountId,
      storePath,
      logger,
      watchStartedAt,
      watchMs: lateReplyWatchMs,
      pollMs: lateReplyPollMs,
      activeWatchers,
      isDelivered: alreadyDelivered ? () => watcherDelivered.value : () => dispatchState.hasDeliveredReply,
      markDelivered: alreadyDelivered
        ? () => {} // no-op: keep polling to catch multiple sub-agent finals
        : () => { dispatchState.hasDeliveredReply = true; },
      sendText: async (text) => sendTextToUser(text),
      onFailureFallback: async (err) => sendFailureFallback(err),
    }).finally(() => {
      lateReplyWatcherPromise = null;
    });
    return true;
  };

  return {
    sendProgressNotice,
    sendFailureFallback,
    startLateReplyWatcher,
  };
}
