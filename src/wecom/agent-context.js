export function buildWecomInboundEnvelopePayload({
  fromUser,
  chatId,
  isGroupChat,
  messageText,
  timestamp = Date.now(),
} = {}) {
  return {
    channel: "WeCom",
    from: isGroupChat && chatId ? `${fromUser} (group:${chatId})` : fromUser,
    timestamp,
    body: messageText,
    chatType: isGroupChat ? "group" : "direct",
    sender: {
      name: fromUser,
      id: fromUser,
    },
  };
}

export function buildWecomInboundContextPayload({
  body,
  messageText,
  originalContent,
  commandBody,
  commandAuthorized = false,
  commandSource = "",
  fromAddress,
  sessionId,
  accountId,
  isGroupChat,
  chatId,
  fromUser,
  msgId,
  timestamp = Date.now(),
} = {}) {
  const normalizedSenderId = String(fromUser ?? "").trim().toLowerCase();
  return {
    Body: body,
    BodyForAgent: messageText,
    BodyForCommands: commandAuthorized ? commandBody : "",
    RawBody: originalContent,
    CommandBody: commandBody,
    CommandAuthorized: commandAuthorized === true,
    CommandSource: commandAuthorized ? String(commandSource || "text") : "",
    From: fromAddress,
    To: fromAddress,
    SessionKey: sessionId,
    AccountId: accountId || "default",
    ChatType: isGroupChat ? "group" : "direct",
    ConversationLabel: isGroupChat && chatId ? `group:${chatId}` : fromUser,
    SenderName: fromUser,
    SenderId: normalizedSenderId,
    Provider: "wechat_work",
    Surface: "wechat_work",
    MessageSid: msgId || `wechat_work-${timestamp}`,
    Timestamp: timestamp,
    OriginatingChannel: "wechat_work",
    OriginatingTo: fromAddress,
  };
}
