function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`executeWecomBotInboundFlow: ${name} is required`);
  }
}

export function assertWecomBotInboundFlowDeps({ api, ...deps } = {}) {
  if (!api || typeof api !== "object") {
    throw new Error("executeWecomBotInboundFlow: api is required");
  }
  const requiredFns = [
    "buildWecomBotSessionId",
    "resolveWecomBotConfig",
    "resolveWecomBotProxyConfig",
    "normalizeWecomBotOutboundMediaUrls",
    "resolveWecomGroupChatPolicy",
    "resolveWecomDynamicAgentPolicy",
    "hasBotStream",
    "finishBotStream",
    "deliverBotReplyText",
    "shouldTriggerWecomGroupResponse",
    "shouldStripWecomGroupMentions",
    "stripWecomGroupMentions",
    "resolveWecomCommandPolicy",
    "resolveWecomAllowFromPolicy",
    "isWecomSenderAllowed",
    "extractLeadingSlashCommand",
    "buildWecomBotHelpText",
    "buildWecomBotStatusText",
    "buildBotInboundContent",
    "resolveWecomAgentRoute",
    "seedDynamicAgentWorkspace",
    "markTranscriptReplyDelivered",
    "markdownToWecomText",
    "withTimeout",
    "isDispatchTimeoutError",
    "queueBotStreamMedia",
    "updateBotStream",
    "isAgentFailureText",
    "scheduleTempFileCleanup",
    "ensureLateReplyWatcherRunner",
    "ensureTranscriptFallbackReader",
  ];
  for (const name of requiredFns) {
    assertFunction(name, deps[name]);
  }
}

export function createWecomBotInboundFlowState({
  api,
  fromUser,
  content,
  imageUrls,
  fileUrl,
  fileName,
  quote,
  buildWecomBotSessionId,
  resolveWecomBotConfig,
  resolveWecomBotProxyConfig,
  resolveWecomGroupChatPolicy,
  resolveWecomDynamicAgentPolicy,
} = {}) {
  const runtime = api.runtime;
  const cfg = api.config;
  const baseSessionId = buildWecomBotSessionId(fromUser);
  const state = {
    runtime,
    cfg,
    baseSessionId,
    sessionId: baseSessionId,
    routedAgentId: "",
    fromAddress: `wecom-bot:${fromUser}`,
    normalizedFromUser: String(fromUser ?? "").trim().toLowerCase(),
    originalContent: String(content ?? ""),
    commandBody: String(content ?? ""),
    dispatchStartedAt: Date.now(),
    tempPathsToCleanup: [],
    botModeConfig: resolveWecomBotConfig(api),
    botProxyUrl: resolveWecomBotProxyConfig(api),
    normalizedFileUrl: String(fileUrl ?? "").trim(),
    normalizedFileName: String(fileName ?? "").trim(),
    normalizedQuote:
      quote && typeof quote === "object"
        ? {
            msgType: String(quote.msgType ?? "").trim().toLowerCase(),
            content: String(quote.content ?? "").trim(),
          }
        : null,
    normalizedImageUrls: Array.from(
      new Set(
        (Array.isArray(imageUrls) ? imageUrls : [])
          .map((item) => String(item ?? "").trim())
          .filter(Boolean),
      ),
    ),
    groupChatPolicy: resolveWecomGroupChatPolicy(api),
    dynamicAgentPolicy: resolveWecomDynamicAgentPolicy(api),
    isAdminUser: false,
  };
  return state;
}

export function createWecomBotSafeReplyHelpers({
  api,
  fromUser,
  streamId,
  responseUrl,
  state,
  hasBotStream,
  finishBotStream,
  normalizeWecomBotOutboundMediaUrls,
  deliverBotReplyText,
} = {}) {
  const safeFinishStream = (text) => {
    if (!hasBotStream(streamId)) return;
    finishBotStream(streamId, String(text ?? ""));
  };

  const safeDeliverReply = async (reply, reason = "reply") => {
    const normalizedReply =
      typeof reply === "string"
        ? { text: reply }
        : reply && typeof reply === "object"
          ? reply
          : { text: "" };
    const contentText = String(normalizedReply.text ?? "").trim();
    const replyMediaUrls = normalizeWecomBotOutboundMediaUrls(normalizedReply);
    if (!contentText && replyMediaUrls.length === 0) return false;
    const result = await deliverBotReplyText({
      api,
      fromUser,
      sessionId: state.sessionId,
      streamId,
      responseUrl,
      text: contentText,
      mediaUrls: replyMediaUrls,
      mediaType: String(normalizedReply.mediaType ?? "").trim().toLowerCase() || undefined,
      reason,
    });
    if (!result?.ok && hasBotStream(streamId)) {
      finishBotStream(streamId, contentText || "已收到模型返回的媒体结果，请稍后刷新。");
    }
    return result?.ok === true;
  };

  return {
    safeFinishStream,
    safeDeliverReply,
  };
}
