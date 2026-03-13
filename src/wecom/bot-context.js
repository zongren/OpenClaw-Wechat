export function buildWecomBotInboundEnvelopePayload({
  fromUser,
  chatId,
  isGroupChat,
  messageText,
  timestamp = Date.now(),
} = {}) {
  return {
    channel: "WeCom Bot",
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

export function buildWecomBotInboundContextPayload({
  body,
  messageText,
  originalContent,
  commandBody,
  commandAuthorized = false,
  commandSource = "",
  fromAddress,
  sessionId,
  accountId = "default",
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
    AccountId: accountId,
    ChatType: isGroupChat ? "group" : "direct",
    ConversationLabel: isGroupChat && chatId ? `group:${chatId}` : fromUser,
    SenderName: fromUser,
    SenderId: normalizedSenderId,
    Provider: "wechat_work",
    Surface: "wechat_work-bot",
    MessageSid: msgId || `wechat_work-bot-${timestamp}`,
    Timestamp: timestamp,
    OriginatingChannel: "wechat_work",
    OriginatingTo: fromAddress,
  };
}
