function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`handleWecomAgentPostDispatchFallback: ${name} is required`);
  }
}

export async function finalizeWecomAgentVisiblePartialReply({
  api,
  state,
  flushStreamingBuffer,
  reason = "partial-finalize",
} = {}) {
  if (!state || typeof state !== "object") {
    throw new Error("finalizeWecomAgentVisiblePartialReply: state is required");
  }
  assertFunction("flushStreamingBuffer", flushStreamingBuffer);
  if (state.hasDeliveredReply || !state.hasDeliveredPartialReply) return false;

  api?.logger?.info?.(
    `wecom: finalizing partial reply (${reason}), streamChunkSentCount=${state.streamChunkSentCount}`,
  );
  await flushStreamingBuffer({ force: true, reason });
  await state.streamChunkSendChain;
  state.hasDeliveredReply = true;
  api?.logger?.info?.(`wecom: finalized visible partial reply (${reason})`);
  return true;
}

export async function handleWecomAgentPostDispatchFallback({
  api,
  state,
  streamingEnabled = false,
  flushStreamingBuffer,
  sendTextToUser,
  markdownToWecomText,
  sendProgressNotice,
  startLateReplyWatcher,
  processingNoticeText = "",
  queuedNoticeText = "",
  dispatchResult = null,
} = {}) {
  if (!state || typeof state !== "object") {
    throw new Error("handleWecomAgentPostDispatchFallback: state is required");
  }
  assertFunction("flushStreamingBuffer", flushStreamingBuffer);
  assertFunction("sendTextToUser", sendTextToUser);
  assertFunction("markdownToWecomText", markdownToWecomText);
  assertFunction("sendProgressNotice", sendProgressNotice);
  assertFunction("startLateReplyWatcher", startLateReplyWatcher);

  const logger = api?.logger;

  if (streamingEnabled) {
    await flushStreamingBuffer({ force: true, reason: "post-dispatch" });
    await state.streamChunkSendChain;
  }

  if (await finalizeWecomAgentVisiblePartialReply({ api, state, flushStreamingBuffer, reason: "post-dispatch" })) {
    return;
  }

  if (!state.hasDeliveredReply && !state.hasDeliveredPartialReply) {
    const blockText = String(state.blockTextFallback || "").trim();
    if (blockText) {
      await sendTextToUser(markdownToWecomText(blockText));
      state.hasDeliveredReply = true;
      logger?.info?.("wecom: delivered accumulated block reply as final fallback");
      return;
    }
  }

  if (state.hasDeliveredReply || state.hasDeliveredPartialReply) return;

  const counts = dispatchResult?.counts ?? {};
  const queuedFinal = dispatchResult?.queuedFinal === true;
  const deliveredCount = Number(counts.final ?? 0) + Number(counts.block ?? 0) + Number(counts.tool ?? 0);
  if (!queuedFinal && deliveredCount === 0) {
    logger?.warn?.("wecom: no immediate deliverable reply (likely queued behind active run)");
    await sendProgressNotice(queuedNoticeText);
    await startLateReplyWatcher("queued-no-final");
    return;
  }

  logger?.warn?.("wecom: dispatch finished without direct final delivery; waiting via late watcher");
  await sendProgressNotice(processingNoticeText);
  await startLateReplyWatcher("dispatch-finished-without-final");
}
