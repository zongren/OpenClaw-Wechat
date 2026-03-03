import { buildWecomInboundContextPayload, buildWecomInboundEnvelopePayload } from "./agent-context.js";
import { executeWecomAgentDispatchFlow } from "./agent-dispatch-executor.js";
import { applyWecomAgentInboundGuards } from "./agent-inbound-guards.js";
import { prepareWecomAgentRuntimeContext } from "./agent-runtime-context.js";
import { createWecomLateReplyWatcher } from "./agent-late-reply-watcher.js";
import { createWecomAgentTextSender } from "./agent-text-sender.js";

export function createWecomAgentInboundProcessor(deps = {}) {
  const {
    getWecomConfig,
    buildWecomSessionId,
    resolveWecomGroupChatPolicy,
    resolveWecomDynamicAgentPolicy,
    shouldTriggerWecomGroupResponse,
    shouldStripWecomGroupMentions,
    stripWecomGroupMentions,
    resolveWecomCommandPolicy,
    resolveWecomAllowFromPolicy,
    isWecomSenderAllowed,
    sendWecomText,
    extractLeadingSlashCommand,
    COMMANDS,
    buildInboundContent,
    resolveWecomAgentRoute,
    seedDynamicAgentWorkspace,
    resolveWecomReplyStreamingPolicy,
    asNumber,
    requireEnv,
    getByteLength,
    markdownToWecomText,
    autoSendWorkspaceFilesFromReplyText,
    sendWecomOutboundMediaBatch,
    sleep,
    resolveSessionTranscriptFilePath,
    readTranscriptAppendedChunk,
    parseLateAssistantReplyFromTranscriptLine,
    hasTranscriptReplyBeenDelivered,
    markTranscriptReplyDelivered,
    withTimeout,
    isDispatchTimeoutError,
    isAgentFailureText,
    scheduleTempFileCleanup,
    ACTIVE_LATE_REPLY_WATCHERS,
  } = deps;
  let lateReplyWatcherRunner = null;
  function ensureLateReplyWatcherRunner() {
    if (lateReplyWatcherRunner) return lateReplyWatcherRunner;
    lateReplyWatcherRunner = createWecomLateReplyWatcher({
      resolveSessionTranscriptFilePath,
      readTranscriptAppendedChunk,
      parseLateAssistantReplyFromTranscriptLine,
      hasTranscriptReplyBeenDelivered,
      markTranscriptReplyDelivered,
      sleep,
      markdownToWecomText,
    });
    return lateReplyWatcherRunner;
  }

  async function processInboundMessage({
  api,
  accountId,
  fromUser,
  content,
  msgType,
  mediaId,
  picUrl,
  recognition,
  thumbMediaId,
  fileName,
  fileSize,
  linkTitle,
  linkDescription,
  linkUrl,
  linkPicUrl,
  chatId,
  isGroupChat,
  msgId,
}) {
  const config = getWecomConfig(api, accountId);
  const cfg = api.config;
  const runtime = api.runtime;

  if (!config?.corpId || !config?.corpSecret || !config?.agentId) {
    api.logger.warn?.("wecom: not configured (check channels.wecom in openclaw.json)");
    return;
  }

  const { corpId, corpSecret, agentId, outboundProxy: proxyUrl } = config;
  const sendTextToUser = createWecomAgentTextSender({
    sendWecomText,
    corpId,
    corpSecret,
    agentId,
    toUser: fromUser,
    logger: api.logger,
    proxyUrl,
  });

  try {
    // 一用户一会话：群聊和私聊统一归并到 wecom:<userid>
    const baseSessionId = buildWecomSessionId(fromUser);
    let sessionId = baseSessionId;
    let routedAgentId = "";
    const fromAddress = `wecom:${fromUser}`;
    const normalizedFromUser = String(fromUser ?? "").trim().toLowerCase();
    const originalContent = content || "";
    let commandBody = originalContent;
    const groupChatPolicy = resolveWecomGroupChatPolicy(api);
    const dynamicAgentPolicy = resolveWecomDynamicAgentPolicy(api);
    api.logger.info?.(`wecom: processing ${msgType} message for session ${sessionId}${isGroupChat ? " (group)" : ""}`);

    const guardResult = await applyWecomAgentInboundGuards({
      api,
      config,
      accountId,
      fromUser,
      msgType,
      isGroupChat,
      chatId,
      commandBody,
      normalizedFromUser,
      groupChatPolicy,
      shouldTriggerWecomGroupResponse,
      shouldStripWecomGroupMentions,
      stripWecomGroupMentions,
      resolveWecomCommandPolicy,
      resolveWecomAllowFromPolicy,
      isWecomSenderAllowed,
      extractLeadingSlashCommand,
      COMMANDS,
      sendTextToUser,
      commandHandlerContext: {
        api,
        fromUser,
        corpId,
        corpSecret,
        agentId,
        accountId: config.accountId || "default",
        proxyUrl,
        chatId,
        isGroupChat,
      },
    });
    if (!guardResult.ok) return;
    commandBody = guardResult.commandBody;
    const isAdminUser = guardResult.isAdminUser === true;

    const inboundResult = await buildInboundContent({
      api,
      corpId,
      corpSecret,
      agentId,
      proxyUrl,
      fromUser,
      msgType,
      baseText: msgType === "text" ? commandBody : originalContent,
      mediaId,
      picUrl,
      recognition,
      fileName,
      fileSize,
      linkTitle,
      linkDescription,
      linkUrl,
    });
    if (inboundResult.aborted) {
      return;
    }
    let messageText = String(inboundResult.messageText ?? "");
    const tempPathsToCleanup = Array.isArray(inboundResult.tempPathsToCleanup)
      ? inboundResult.tempPathsToCleanup
      : [];
    if (!messageText) {
      api.logger.warn?.("wecom: empty message content");
      return;
    }

    const runtimeContext = await prepareWecomAgentRuntimeContext({
      api,
      runtime,
      cfg,
      baseSessionId,
      fromUser,
      chatId,
      isGroupChat,
      msgId,
      messageText,
      commandBody,
      originalContent,
      fromAddress,
      accountId: config.accountId || "default",
      groupChatPolicy,
      dynamicAgentPolicy,
      isAdminUser,
      resolveWecomAgentRoute,
      seedDynamicAgentWorkspace,
      buildWecomInboundEnvelopePayload,
      buildWecomInboundContextPayload,
    });
    routedAgentId = runtimeContext.routedAgentId;
    sessionId = runtimeContext.sessionId;
    const storePath = runtimeContext.storePath;
    const ctxPayload = runtimeContext.ctxPayload;
    const runtimeAccountId = runtimeContext.accountId;

    api.logger.info?.(`wecom: dispatching message via agent runtime for session ${sessionId}`);
    await executeWecomAgentDispatchFlow({
      api,
      runtime,
      cfg,
      ctxPayload,
      sessionId,
      routedAgentId,
      runtimeAccountId,
      msgId,
      storePath,
      fromUser,
      corpId,
      corpSecret,
      agentId,
      proxyUrl,
      tempPathsToCleanup,
      resolveWecomReplyStreamingPolicy,
      asNumber,
      requireEnv,
      getByteLength,
      markdownToWecomText,
      autoSendWorkspaceFilesFromReplyText,
      sendWecomOutboundMediaBatch,
      withTimeout,
      isDispatchTimeoutError,
      isAgentFailureText,
      scheduleTempFileCleanup,
      ensureLateReplyWatcherRunner,
      ACTIVE_LATE_REPLY_WATCHERS,
      sendTextToUser,
    });

  } catch (err) {
    api.logger.error?.(`wecom: failed to process message: ${err.message}`);
    api.logger.error?.(`wecom: stack trace: ${err.stack}`);

    // 发送错误提示给用户
    try {
      await sendTextToUser(`抱歉，处理您的消息时出现错误，请稍后重试。\n错误: ${err.message?.slice(0, 100) || "未知错误"}`);
    } catch (sendErr) {
      api.logger.error?.(`wecom: failed to send error message: ${sendErr.message}`);
      api.logger.error?.(`wecom: send error stack: ${sendErr.stack}`);
      api.logger.error?.(`wecom: original error was: ${err.message}`);
    }
  }
  }


  return processInboundMessage;
}
