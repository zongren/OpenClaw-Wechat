import {
  buildDefaultAgentWebhookPath,
  buildDefaultBotWebhookPath,
  buildLegacyAgentWebhookPath,
  buildLegacyBotWebhookPath,
} from "./account-paths.js";

export function createWecomRouteRegistrar({
  resolveWecomBotConfig,
  resolveWecomBotConfigs,
  normalizePluginHttpPath,
  ensureBotStreamCleanupTimer,
  cleanupExpiredBotStreams,
  createWecomBotWebhookHandler,
  createWecomAgentWebhookHandler,
  readRequestBody,
  parseIncomingJson,
  parseIncomingXml,
  pickAccountBySignature,
  decryptWecom,
  computeMsgSignature,
  parseWecomBotInboundMessage,
  describeWecomBotParsedMessage,
  markInboundMessageSeen,
  extractWecomXmlInboundEnvelope,
  buildWecomSessionId,
  buildWecomBotSessionId,
  buildWecomBotEncryptedResponse,
  createBotStream,
  getBotStream,
  upsertBotResponseUrlCache,
  messageProcessLimiter,
  executeInboundTaskWithSessionQueue,
  processBotInboundMessage,
  processInboundMessage,
  scheduleTextInboundProcessing,
  deliverBotReplyText,
  finishBotStream,
  groupAccountsByWebhookPath,
  recordInboundMetric = () => {},
  recordRuntimeErrorMetric = () => {},
} = {}) {
  if (typeof resolveWecomBotConfig !== "function") throw new Error("createWecomRouteRegistrar: resolveWecomBotConfig is required");
  if (typeof resolveWecomBotConfigs !== "function") {
    throw new Error("createWecomRouteRegistrar: resolveWecomBotConfigs is required");
  }
  if (typeof normalizePluginHttpPath !== "function") {
    throw new Error("createWecomRouteRegistrar: normalizePluginHttpPath is required");
  }
  if (typeof ensureBotStreamCleanupTimer !== "function") {
    throw new Error("createWecomRouteRegistrar: ensureBotStreamCleanupTimer is required");
  }
  if (typeof cleanupExpiredBotStreams !== "function") {
    throw new Error("createWecomRouteRegistrar: cleanupExpiredBotStreams is required");
  }
  if (typeof createWecomBotWebhookHandler !== "function") {
    throw new Error("createWecomRouteRegistrar: createWecomBotWebhookHandler is required");
  }
  if (typeof createWecomAgentWebhookHandler !== "function") {
    throw new Error("createWecomRouteRegistrar: createWecomAgentWebhookHandler is required");
  }
  if (typeof groupAccountsByWebhookPath !== "function") {
    throw new Error("createWecomRouteRegistrar: groupAccountsByWebhookPath is required");
  }

  function registerWecomBotWebhookRoute(api) {
    const botConfigs = resolveWecomBotConfigs(api);
    const enabledBotConfigs = (Array.isArray(botConfigs) ? botConfigs : []).filter((item) => item?.enabled === true);
    if (enabledBotConfigs.length === 0) return false;

    const signedBotConfigs = enabledBotConfigs.filter((item) => item?.token && item?.encodingAesKey);
    if (signedBotConfigs.length === 0) {
      const longConnectionOnly = enabledBotConfigs.some((item) => item?.longConnection?.enabled === true);
      if (!longConnectionOnly) {
        api.logger.warn?.("wecom(bot): enabled but missing token/encodingAesKey; route not registered");
      }
      return false;
    }

    const grouped = new Map();
    const agentWebhookGroups = groupAccountsByWebhookPath(api);
    const agentPathSet = new Set(
      Array.from(agentWebhookGroups.keys()).map(
        (path) => normalizePluginHttpPath(path ?? "/wecom/callback", "/wecom/callback") ?? "/wecom/callback",
      ),
    );
    for (const botConfig of signedBotConfigs) {
      const normalizedAccountId = String(botConfig?.accountId ?? "default").trim().toLowerCase() || "default";
      const normalizedPath =
        normalizePluginHttpPath(botConfig.webhookPath ?? "/wecom/bot/callback", "/wecom/bot/callback") ??
        "/wecom/bot/callback";
      const registerGroupedPath = (candidatePath) => {
        const existing = grouped.get(candidatePath);
        if (existing) existing.push(botConfig);
        else grouped.set(candidatePath, [botConfig]);
      };
      registerGroupedPath(normalizedPath);

      const normalizedDefaultPath = normalizePluginHttpPath(
        buildDefaultBotWebhookPath(normalizedAccountId),
        "/wecom/bot/callback",
      );
      if (normalizedDefaultPath && normalizedPath === normalizedDefaultPath) {
        const legacyAliasPath =
          normalizePluginHttpPath(buildLegacyBotWebhookPath(normalizedAccountId), "/webhooks/wecom") ??
          "/webhooks/wecom";
        if (legacyAliasPath !== normalizedPath) {
          if (agentPathSet.has(legacyAliasPath)) {
            api.logger.warn?.(
              `wecom(bot): skip legacy alias ${legacyAliasPath} for account=${normalizedAccountId} (conflicts with agent webhook path)`,
            );
          } else {
            registerGroupedPath(legacyAliasPath);
            api.logger.info?.(
              `wecom(bot): registered legacy alias ${legacyAliasPath} for account=${normalizedAccountId}`,
            );
          }
        }
      }
    }

    let registeredCount = 0;
    for (const [normalizedPath, pathConfigs] of grouped.entries()) {
      const maxStreamExpireMs = pathConfigs.reduce(
        (acc, item) => Math.max(acc, Number(item?.streamExpireMs) || 0),
        0,
      );
      ensureBotStreamCleanupTimer(maxStreamExpireMs || 600000, api.logger);
      cleanupExpiredBotStreams(maxStreamExpireMs || 600000);

      const handler = createWecomBotWebhookHandler({
        api,
        botConfigs: pathConfigs,
        normalizedPath,
        readRequestBody,
        parseIncomingJson,
        computeMsgSignature,
        decryptWecom,
        parseWecomBotInboundMessage,
        describeWecomBotParsedMessage,
        cleanupExpiredBotStreams,
        getBotStream,
        buildWecomBotEncryptedResponse,
        markInboundMessageSeen,
        buildWecomBotSessionId,
        createBotStream,
        upsertBotResponseUrlCache,
        messageProcessLimiter,
        executeInboundTaskWithSessionQueue,
        processBotInboundMessage,
        deliverBotReplyText,
        finishBotStream,
        recordInboundMetric,
        recordRuntimeErrorMetric,
      });

      api.registerHttpRoute({
        path: normalizedPath,
        auth: "plugin",
        handler,
      });

      const accountIds = pathConfigs.map((item) => String(item?.accountId ?? "default")).join(", ");
      api.logger.info?.(`wecom(bot): registered webhook at ${normalizedPath} (accounts=${accountIds})`);
      registeredCount += 1;
    }
    return registeredCount > 0;
  }

  function buildBotWebhookPathSet(api) {
    const botPathSet = new Set();
    const botConfigs = resolveWecomBotConfigs(api);
    const enabledBotConfigs = (Array.isArray(botConfigs) ? botConfigs : []).filter((item) => item?.enabled === true);
    for (const botConfig of enabledBotConfigs) {
      const normalizedAccountId = String(botConfig?.accountId ?? "default").trim().toLowerCase() || "default";
      const normalizedPath =
        normalizePluginHttpPath(botConfig.webhookPath ?? "/wecom/bot/callback", "/wecom/bot/callback") ??
        "/wecom/bot/callback";
      botPathSet.add(normalizedPath);

      const normalizedDefaultPath = normalizePluginHttpPath(
        buildDefaultBotWebhookPath(normalizedAccountId),
        "/wecom/bot/callback",
      );
      if (normalizedDefaultPath && normalizedPath === normalizedDefaultPath) {
        const legacyAliasPath =
          normalizePluginHttpPath(buildLegacyBotWebhookPath(normalizedAccountId), "/webhooks/wecom") ??
          "/webhooks/wecom";
        botPathSet.add(legacyAliasPath);
      }
    }
    return botPathSet;
  }

  function registerWecomAgentWebhookRoutes(api) {
    const webhookGroups = groupAccountsByWebhookPath(api);
    const grouped = new Map();
    for (const [normalizedPath, accounts] of webhookGroups.entries()) {
      grouped.set(normalizedPath, [...accounts]);
    }

    const botPathSet = buildBotWebhookPathSet(api);
    for (const [normalizedPath, accounts] of webhookGroups.entries()) {
      for (const account of accounts) {
        const normalizedAccountId = String(account?.accountId ?? "default").trim().toLowerCase() || "default";
        const normalizedDefaultPath =
          normalizePluginHttpPath(buildDefaultAgentWebhookPath(normalizedAccountId), "/wecom/callback") ??
          "/wecom/callback";
        if (normalizedPath !== normalizedDefaultPath) continue;

        const legacyAliasPath =
          normalizePluginHttpPath(buildLegacyAgentWebhookPath(normalizedAccountId), "/webhooks/app") ??
          "/webhooks/app";
        if (!legacyAliasPath || legacyAliasPath === normalizedPath) continue;
        if (botPathSet.has(legacyAliasPath)) {
          api.logger.warn?.(
            `wecom: skip legacy agent alias ${legacyAliasPath} for account=${normalizedAccountId} (conflicts with bot webhook path)`,
          );
          continue;
        }

        const existing = grouped.get(legacyAliasPath);
        if (existing) {
          const duplicated = existing.some(
            (item) =>
              (String(item?.accountId ?? "default").trim().toLowerCase() || "default") === normalizedAccountId,
          );
          if (!duplicated) existing.push(account);
        } else {
          grouped.set(legacyAliasPath, [account]);
        }
        api.logger.info?.(`wecom: registered legacy agent alias ${legacyAliasPath} for account=${normalizedAccountId}`);
      }
    }

    for (const [normalizedPath, accounts] of grouped.entries()) {
      const handler = createWecomAgentWebhookHandler({
        api,
        accounts,
        readRequestBody,
        parseIncomingXml,
        pickAccountBySignature,
        decryptWecom,
        markInboundMessageSeen,
        extractWecomXmlInboundEnvelope,
        buildWecomSessionId,
        scheduleTextInboundProcessing,
        messageProcessLimiter,
        executeInboundTaskWithSessionQueue,
        processInboundMessage,
        recordInboundMetric,
        recordRuntimeErrorMetric,
      });
      api.registerHttpRoute({
        path: normalizedPath,
        auth: "plugin",
        handler,
      });

      const accountIds = accounts.map((a) => a.accountId).join(", ");
      api.logger.info?.(`wecom: registered webhook at ${normalizedPath} (accounts=${accountIds})`);
    }
    return webhookGroups;
  }

  return {
    registerWecomBotWebhookRoute,
    registerWecomAgentWebhookRoutes,
  };
}
