function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`prepareWecomAgentRuntimeContext: ${name} is required`);
  }
}

export async function prepareWecomAgentRuntimeContext({
  api,
  runtime,
  cfg,
  baseSessionId,
  fromUser,
  chatId,
  isGroupChat = false,
  msgId = "",
  messageText = "",
  commandBody = "",
  commandAuthorized = false,
  originalContent = "",
  fromAddress = "",
  accountId = "default",
  groupChatPolicy = {},
  dynamicAgentPolicy = {},
  isAdminUser = false,
  resolveWecomAgentRoute,
  seedDynamicAgentWorkspace,
  buildWecomInboundEnvelopePayload,
  buildWecomInboundContextPayload,
} = {}) {
  assertFunction("resolveWecomAgentRoute", resolveWecomAgentRoute);
  assertFunction("seedDynamicAgentWorkspace", seedDynamicAgentWorkspace);
  assertFunction("buildWecomInboundEnvelopePayload", buildWecomInboundEnvelopePayload);
  assertFunction("buildWecomInboundContextPayload", buildWecomInboundContextPayload);

  const resolvedAccountId = String(accountId ?? "").trim() || "default";
  const route = resolveWecomAgentRoute({
    runtime,
    cfg,
    channel: "wechat_work",
    accountId: resolvedAccountId,
    sessionKey: baseSessionId,
    fromUser,
    chatId,
    isGroupChat,
    content: commandBody || messageText,
    mentionPatterns: groupChatPolicy.mentionPatterns,
    dynamicConfig: dynamicAgentPolicy,
    isAdminUser,
    logger: api?.logger,
  });
  const routedAgentId = String(route?.agentId ?? "").trim();
  const sessionId = String(route?.sessionKey ?? "").trim() || baseSessionId;
  api?.logger?.info?.(
    `wechat_work: routed agent=${route.agentId} session=${sessionId} matchedBy=${route.dynamicMatchedBy || route.matchedBy || "default"}`,
  );

  try {
    await seedDynamicAgentWorkspace({
      api,
      agentId: route.agentId,
      workspaceTemplate: dynamicAgentPolicy.workspaceTemplate,
    });
  } catch (seedErr) {
    api?.logger?.warn?.(`wechat_work: workspace seed failed: ${String(seedErr?.message || seedErr)}`);
  }

  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const body = runtime.channel.reply.formatInboundEnvelope({
    ...buildWecomInboundEnvelopePayload({
      fromUser,
      chatId,
      isGroupChat,
      messageText,
    }),
    ...envelopeOptions,
  });
  const ctxPayload = runtime.channel.reply.finalizeInboundContext(
    buildWecomInboundContextPayload({
      body,
      messageText,
      originalContent,
      commandBody,
      commandAuthorized,
      commandSource: commandAuthorized ? "text" : "",
      fromAddress,
      sessionId,
      accountId: resolvedAccountId,
      isGroupChat,
      chatId,
      fromUser,
      msgId,
    }),
  );

  await runtime.channel.session.recordInboundSession({
    storePath,
    sessionKey: sessionId,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: sessionId,
      channel: "wechat_work",
      to: fromUser,
      accountId: resolvedAccountId,
    },
    onRecordError: (err) => {
      api?.logger?.warn?.(`wechat_work: failed to record session: ${err}`);
    },
  });
  api?.logger?.info?.(`wechat_work: session registered for ${sessionId}`);

  runtime.channel.activity.record({
    channel: "wechat_work",
    accountId: resolvedAccountId,
    direction: "inbound",
  });

  return {
    route,
    routedAgentId,
    sessionId,
    storePath,
    ctxPayload,
    accountId: resolvedAccountId,
  };
}
