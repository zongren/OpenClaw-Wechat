function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomAgentTextSender: ${name} is required`);
  }
}

export function createWecomAgentTextSender({
  sendWecomText,
  corpId,
  corpSecret,
  agentId,
  toUser,
  logger,
  proxyUrl,
} = {}) {
  assertFunction("sendWecomText", sendWecomText);

  return async function sendText(text) {
    logger?.info?.(`wechat_work: sending text to user=${toUser}, bytes=${Buffer.byteLength(String(text ?? ""), "utf8")}`);
    const result = await sendWecomText({
      corpId,
      corpSecret,
      agentId,
      toUser,
      text,
      logger,
      proxyUrl,
    });
    logger?.info?.(`wechat_work: text sent successfully to user=${toUser}, msgid=${result?.msgid || "n/a"}`);
    return result;
  };
}
