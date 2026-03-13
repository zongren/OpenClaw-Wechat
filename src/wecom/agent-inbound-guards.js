function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`agent-inbound-guards: ${name} is required`);
  }
}

export async function applyWecomAgentInboundGuards({
  api,
  config,
  accountId = "",
  fromUser,
  msgType = "text",
  isGroupChat = false,
  chatId = "",
  commandBody = "",
  normalizedFromUser = "",
  groupChatPolicy = {},
  shouldTriggerWecomGroupResponse,
  shouldStripWecomGroupMentions,
  stripWecomGroupMentions,
  resolveWecomCommandPolicy,
  resolveWecomAllowFromPolicy,
  resolveWecomDmPolicy,
  isWecomSenderAllowed,
  extractLeadingSlashCommand,
  COMMANDS,
  sendTextToUser,
  commandHandlerContext = {},
} = {}) {
  assertFunction("shouldTriggerWecomGroupResponse", shouldTriggerWecomGroupResponse);
  assertFunction("shouldStripWecomGroupMentions", shouldStripWecomGroupMentions);
  assertFunction("stripWecomGroupMentions", stripWecomGroupMentions);
  assertFunction("resolveWecomCommandPolicy", resolveWecomCommandPolicy);
  assertFunction("resolveWecomAllowFromPolicy", resolveWecomAllowFromPolicy);
  assertFunction("resolveWecomDmPolicy", resolveWecomDmPolicy);
  assertFunction("isWecomSenderAllowed", isWecomSenderAllowed);
  assertFunction("extractLeadingSlashCommand", extractLeadingSlashCommand);
  assertFunction("sendTextToUser", sendTextToUser);

  let nextCommandBody = String(commandBody ?? "");

  if (msgType === "text" && isGroupChat) {
    if (!groupChatPolicy.enabled) {
      api?.logger?.info?.(`wechat_work: group chat processing disabled, skipped chatId=${chatId || "unknown"}`);
      return { ok: false, commandBody: nextCommandBody, isAdminUser: false };
    }
    if (!shouldTriggerWecomGroupResponse(nextCommandBody, groupChatPolicy)) {
      api?.logger?.info?.(
        `wechat_work: group message skipped by trigger policy chatId=${chatId || "unknown"} mode=${groupChatPolicy.triggerMode || "direct"}`,
      );
      return { ok: false, commandBody: nextCommandBody, isAdminUser: false };
    }
    if (shouldStripWecomGroupMentions(groupChatPolicy)) {
      nextCommandBody = stripWecomGroupMentions(nextCommandBody, groupChatPolicy.mentionPatterns);
    }
    if (!nextCommandBody.trim()) {
      api?.logger?.info?.(`wechat_work: group message became empty after mention strip chatId=${chatId || "unknown"}`);
      return { ok: false, commandBody: nextCommandBody, isAdminUser: false };
    }
  }

  const commandPolicy = resolveWecomCommandPolicy(api);
  const isAdminUser = commandPolicy.adminUsers.includes(normalizedFromUser);
  const dmPolicy = resolveWecomDmPolicy(api, config?.accountId || accountId || "default", config);
  if (!isGroupChat) {
    if (dmPolicy.mode === "deny") {
      await sendTextToUser(dmPolicy.rejectMessage || "当前渠道私聊已关闭，请联系管理员。");
      return { ok: false, commandBody: nextCommandBody, isAdminUser };
    }
    if (dmPolicy.mode === "allowlist") {
      const dmSenderAllowed = isAdminUser || isWecomSenderAllowed({
        senderId: normalizedFromUser,
        allowFrom: dmPolicy.allowFrom,
      });
      if (!dmSenderAllowed) {
        await sendTextToUser(dmPolicy.rejectMessage || "当前私聊账号未授权，请联系管理员。");
        return { ok: false, commandBody: nextCommandBody, isAdminUser };
      }
    }
  }
  const allowFromPolicy = resolveWecomAllowFromPolicy(api, config?.accountId || accountId || "default", config);
  const senderAllowed = isAdminUser || isWecomSenderAllowed({
    senderId: normalizedFromUser,
    allowFrom: allowFromPolicy.allowFrom,
  });
  if (!senderAllowed) {
    api?.logger?.warn?.(
      `wechat_work: sender blocked by allowFrom account=${config?.accountId || "default"} user=${normalizedFromUser}`,
    );
    if (allowFromPolicy.rejectMessage) {
      await sendTextToUser(allowFromPolicy.rejectMessage);
    }
    return { ok: false, commandBody: nextCommandBody, isAdminUser };
  }

  if (msgType === "text") {
    let commandKey = extractLeadingSlashCommand(nextCommandBody);
    if (commandKey === "/clear" || commandKey === "/new") {
      api?.logger?.info?.(`wechat_work: translating ${commandKey} to native /reset command`);
      nextCommandBody = nextCommandBody.replace(/^\/(?:clear|new)\b/i, "/reset");
      commandKey = "/reset";
    }
    if (commandKey) {
      const commandAllowed =
        commandPolicy.allowlist.includes(commandKey) ||
        (commandKey === "/reset" &&
          (commandPolicy.allowlist.includes("/clear") || commandPolicy.allowlist.includes("/new")));
      if (commandPolicy.enabled && !isAdminUser && !commandAllowed) {
        api?.logger?.info?.(`wechat_work: command blocked by allowlist user=${fromUser} command=${commandKey}`);
        await sendTextToUser(commandPolicy.rejectMessage);
        return { ok: false, commandBody: nextCommandBody, isAdminUser };
      }
      const handler = COMMANDS?.[commandKey];
      if (typeof handler === "function") {
        api?.logger?.info?.(`wechat_work: handling command ${commandKey}`);
        await handler(commandHandlerContext);
        return { ok: false, commandBody: nextCommandBody, isAdminUser, commandHandled: true };
      }
    }
  }

  return {
    ok: true,
    commandBody: nextCommandBody,
    isAdminUser,
    commandHandled: false,
  };
}
