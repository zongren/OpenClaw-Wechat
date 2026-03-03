export async function handleWecomAgentInboundError({ api, err, sendTextToUser } = {}) {
  api?.logger?.error?.(`wecom: failed to process message: ${err?.message}`);
  api?.logger?.error?.(`wecom: stack trace: ${err?.stack}`);

  try {
    await sendTextToUser(`抱歉，处理您的消息时出现错误，请稍后重试。\n错误: ${err?.message?.slice(0, 100) || "未知错误"}`);
  } catch (sendErr) {
    api?.logger?.error?.(`wecom: failed to send error message: ${sendErr?.message}`);
    api?.logger?.error?.(`wecom: send error stack: ${sendErr?.stack}`);
    api?.logger?.error?.(`wecom: original error was: ${err?.message}`);
  }
}
