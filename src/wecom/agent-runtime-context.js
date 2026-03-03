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
    channel: "wecom",
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
    `wecom: routed agent=${route.agentId} session=${sessionId} matchedBy=${route.dynamicMatchedBy || route.matchedBy || "default"}`,
  );

  try {
    await seedDynamicAgentWorkspace({
      api,
      agentId: route.agentId,
      workspaceTemplate: dynamicAgentPolicy.workspaceTemplate,
    });
  } catch (seedErr) {
    api?.logger?.warn?.(`wecom: workspace seed failed: ${String(seedErr?.message || seedErr)}`);
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
      channel: "wecom",
      to: fromUser,
      accountId: resolvedAccountId,
    },
    onRecordError: (err) => {
      api?.logger?.warn?.(`wecom: failed to record session: ${err}`);
    },
  });
  api?.logger?.info?.(`wecom: session registered for ${sessionId}`);

  runtime.channel.activity.record({
    channel: "wecom",
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
