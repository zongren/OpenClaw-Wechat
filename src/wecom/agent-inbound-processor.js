import { buildWecomInboundContextPayload, buildWecomInboundEnvelopePayload } from "./agent-context.js";
import { createWecomAgentDispatchHandlers } from "./agent-dispatch-handlers.js";
import { handleWecomAgentPostDispatchFallback } from "./agent-dispatch-fallback.js";
import { createWecomAgentLateReplyRuntime } from "./agent-late-reply-runtime.js";
import { createWecomAgentDispatchState, resolveWecomAgentReplyRuntimePolicy } from "./agent-reply-runtime.js";
import { prepareWecomAgentRuntimeContext } from "./agent-runtime-context.js";
import { createWecomAgentStreamingChunkManager } from "./agent-streaming-chunks.js";
import { createWecomLateReplyWatcher } from "./agent-late-reply-watcher.js";
import { buildWorkspaceAutoSendHints, computeStreamingTailText } from "./agent-reply-format.js";
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

    // 群聊触发策略（仅对文本消息）
    if (msgType === "text" && isGroupChat) {
      if (!groupChatPolicy.enabled) {
        api.logger.info?.(`wecom: group chat processing disabled, skipped chatId=${chatId || "unknown"}`);
        return;
      }
      if (!shouldTriggerWecomGroupResponse(commandBody, groupChatPolicy)) {
        api.logger.info?.(
          `wecom: group message skipped by trigger policy chatId=${chatId || "unknown"} mode=${groupChatPolicy.triggerMode || "direct"}`,
        );
        return;
      }
      if (shouldStripWecomGroupMentions(groupChatPolicy)) {
        commandBody = stripWecomGroupMentions(commandBody, groupChatPolicy.mentionPatterns);
      }
      if (!commandBody.trim()) {
        api.logger.info?.(`wecom: group message became empty after mention strip chatId=${chatId || "unknown"}`);
        return;
      }
    }

    const commandPolicy = resolveWecomCommandPolicy(api);
    const isAdminUser = commandPolicy.adminUsers.includes(normalizedFromUser);
    const allowFromPolicy = resolveWecomAllowFromPolicy(api, config.accountId || accountId || "default", config);
    const senderAllowed = isAdminUser || isWecomSenderAllowed({
      senderId: normalizedFromUser,
      allowFrom: allowFromPolicy.allowFrom,
    });
    if (!senderAllowed) {
      api.logger.warn?.(
        `wecom: sender blocked by allowFrom account=${config.accountId || "default"} user=${normalizedFromUser}`,
      );
      if (allowFromPolicy.rejectMessage) {
        await sendTextToUser(allowFromPolicy.rejectMessage);
      }
      return;
    }

    // 命令检测（仅对文本消息）
    if (msgType === "text") {
      let commandKey = extractLeadingSlashCommand(commandBody);
      if (commandKey === "/clear") {
        api.logger.info?.("wecom: translating /clear to native /reset command");
        commandBody = commandBody.replace(/^\/clear\b/i, "/reset");
        commandKey = "/reset";
      }
      if (commandKey) {
        const commandAllowed =
          commandPolicy.allowlist.includes(commandKey) ||
          (commandKey === "/reset" && commandPolicy.allowlist.includes("/clear"));
        if (commandPolicy.enabled && !isAdminUser && !commandAllowed) {
          api.logger.info?.(`wecom: command blocked by allowlist user=${fromUser} command=${commandKey}`);
          await sendTextToUser(commandPolicy.rejectMessage);
          return;
        }
        const handler = COMMANDS[commandKey];
        if (handler) {
          api.logger.info?.(`wecom: handling command ${commandKey}`);
          await handler({
            api,
            fromUser,
            corpId,
            corpSecret,
            agentId,
            accountId: config.accountId || "default",
            proxyUrl,
            chatId,
            isGroupChat,
          });
          return; // 命令已处理，不再调用 AI
        }
      }
    }

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

    // 使用 gateway 内部 agent runtime API 调用 AI
    // 对标 Telegram 的 dispatchReplyWithBufferedBlockDispatcher

    const dispatchState = createWecomAgentDispatchState();
    let progressNoticeTimer = null;
    const streamingPolicy = resolveWecomReplyStreamingPolicy(api);
    const streamingEnabled = streamingPolicy.enabled === true;
    const { replyTimeoutMs, progressNoticeDelayMs, lateReplyWatchMs, lateReplyPollMs } =
      resolveWecomAgentReplyRuntimePolicy({
        cfg,
        asNumber,
        requireEnv,
      });
    // 自建应用模式默认不发送“处理中”提示，避免打扰用户。
    const processingNoticeText = "";
    const queuedNoticeText = "";
    const { flushStreamingBuffer } = createWecomAgentStreamingChunkManager({
      state: dispatchState,
      streamingEnabled,
      streamingPolicy,
      markdownToWecomText,
      getByteLength,
      sendTextToUser,
      logger: api.logger,
    });
    const lateReplyRuntime = createWecomAgentLateReplyRuntime({
      dispatchState,
      sessionId,
      msgId,
      transcriptSessionId: ctxPayload.SessionId || sessionId,
      accountId: runtimeAccountId,
      storePath,
      lateReplyWatchMs,
      lateReplyPollMs,
      sendTextToUser,
      ensureLateReplyWatcherRunner,
      activeWatchers: ACTIVE_LATE_REPLY_WATCHERS,
      logger: api.logger,
    });
    const sendProgressNotice = lateReplyRuntime.sendProgressNotice;
    const sendFailureFallback = lateReplyRuntime.sendFailureFallback;
    const startLateReplyWatcher = lateReplyRuntime.startLateReplyWatcher;

    try {
      if (progressNoticeDelayMs > 0) {
        progressNoticeTimer = setTimeout(() => {
          sendProgressNotice().catch((noticeErr) => {
            api.logger.warn?.(`wecom: failed to send progress notice: ${String(noticeErr)}`);
          });
        }, progressNoticeDelayMs);
      }

      let dispatchResult = null;
      api.logger.info?.(`wecom: waiting for agent reply (timeout=${replyTimeoutMs}ms)`);
      const dispatchHandlers = createWecomAgentDispatchHandlers({
        api,
        state: dispatchState,
        streamingEnabled,
        fromUser,
        routedAgentId,
        corpId,
        corpSecret,
        agentId,
        proxyUrl,
        flushStreamingBuffer,
        sendFailureFallback,
        sendTextToUser,
        markdownToWecomText,
        isAgentFailureText,
        computeStreamingTailText,
        autoSendWorkspaceFilesFromReplyText,
        buildWorkspaceAutoSendHints,
        sendWecomOutboundMediaBatch,
      });
      dispatchResult = await withTimeout(
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          dispatcherOptions: {
            deliver: dispatchHandlers.deliver,
            onError: dispatchHandlers.onError,
          },
          replyOptions: {
            // 企业微信不支持编辑消息；开启流式时会以“多条文本消息”模拟增量输出。
            disableBlockStreaming: !streamingEnabled,
            routeOverrides:
              routedAgentId && sessionId
                ? {
                    sessionKey: sessionId,
                    agentId: routedAgentId,
                    accountId: runtimeAccountId,
                  }
                : undefined,
          },
        }),
        replyTimeoutMs,
        `dispatch timed out after ${replyTimeoutMs}ms`,
      );

      await handleWecomAgentPostDispatchFallback({
        api,
        state: dispatchState,
        streamingEnabled,
        flushStreamingBuffer,
        sendTextToUser,
        markdownToWecomText,
        sendProgressNotice,
        startLateReplyWatcher,
        processingNoticeText,
        queuedNoticeText,
        dispatchResult,
      });
    } catch (dispatchErr) {
      api.logger.warn?.(`wecom: dispatch failed: ${String(dispatchErr)}`);
      if (isDispatchTimeoutError(dispatchErr)) {
        dispatchState.suppressLateDispatcherDeliveries = true;
        await sendProgressNotice(queuedNoticeText);
        await startLateReplyWatcher("dispatch-timeout");
      } else {
        await sendFailureFallback(dispatchErr);
      }
    } finally {
      if (progressNoticeTimer) clearTimeout(progressNoticeTimer);
      for (const filePath of tempPathsToCleanup) {
        scheduleTempFileCleanup(filePath, api.logger);
      }
    }

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
