function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomAgentInboundDispatcher: ${name} is required`);
  }
}

const ASYNC_INBOUND_HANDLERS = {
  image: {
    requiresMediaId: true,
    errorLabel: "image",
    buildTaskPayload: (inbound) => ({
      mediaId: inbound.mediaId,
      msgType: "image",
      picUrl: inbound.picUrl,
    }),
  },
  voice: {
    requiresMediaId: true,
    errorLabel: "voice",
    buildTaskPayload: (inbound) => ({
      mediaId: inbound.mediaId,
      msgType: "voice",
      recognition: inbound.recognition,
    }),
  },
  video: {
    requiresMediaId: true,
    errorLabel: "video",
    buildTaskPayload: (inbound) => ({
      mediaId: inbound.mediaId,
      msgType: "video",
      thumbMediaId: inbound.thumbMediaId,
    }),
  },
  file: {
    requiresMediaId: true,
    errorLabel: "file",
    buildTaskPayload: (inbound) => ({
      mediaId: inbound.mediaId,
      msgType: "file",
      fileName: inbound.fileName,
      fileSize: inbound.fileSize,
    }),
  },
  link: {
    requiresMediaId: false,
    errorLabel: "link",
    buildTaskPayload: (inbound) => ({
      msgType: "link",
      linkTitle: inbound.linkTitle,
      linkDescription: inbound.linkDescription,
      linkUrl: inbound.linkUrl,
      linkPicUrl: inbound.linkPicUrl,
    }),
  },
};

function enqueueInboundTask({
  api,
  inboundSessionId,
  basePayload,
  taskPayload,
  errorLabel,
  messageProcessLimiter,
  executeInboundTaskWithSessionQueue,
  processInboundMessage,
}) {
  messageProcessLimiter
    .execute(() =>
      executeInboundTaskWithSessionQueue({
        api,
        sessionId: inboundSessionId,
        isBot: false,
        task: () =>
          processInboundMessage({
            ...basePayload,
            ...taskPayload,
          }),
      }),
    )
    .catch((err) => {
      api.logger.error?.(`wecom: async ${errorLabel} processing failed: ${err.message}`);
    });
}

export function createWecomAgentInboundDispatcher({
  api,
  buildWecomSessionId,
  scheduleTextInboundProcessing,
  messageProcessLimiter,
  executeInboundTaskWithSessionQueue,
  processInboundMessage,
} = {}) {
  assertFunction("buildWecomSessionId", buildWecomSessionId);
  assertFunction("scheduleTextInboundProcessing", scheduleTextInboundProcessing);
  if (!messageProcessLimiter || typeof messageProcessLimiter.execute !== "function") {
    throw new Error("createWecomAgentInboundDispatcher: messageProcessLimiter.execute is required");
  }
  assertFunction("executeInboundTaskWithSessionQueue", executeInboundTaskWithSessionQueue);
  assertFunction("processInboundMessage", processInboundMessage);

  return function dispatchWecomAgentInbound({ inbound, basePayload } = {}) {
    const msgType = String(inbound?.msgType ?? "").trim().toLowerCase();
    if (!msgType) return false;

    if (msgType === "text") {
      const content = String(inbound?.content ?? "");
      if (!content) return false;
      scheduleTextInboundProcessing(api, basePayload, content);
      return true;
    }

    const handler = ASYNC_INBOUND_HANDLERS[msgType];
    if (!handler) return false;
    if (handler.requiresMediaId && !String(inbound?.mediaId ?? "").trim()) return false;

    const fromUser = String(basePayload?.fromUser ?? "");
    if (!fromUser) return false;
    const inboundSessionId = buildWecomSessionId(fromUser);
    const taskPayload = handler.buildTaskPayload(inbound);

    enqueueInboundTask({
      api,
      inboundSessionId,
      basePayload,
      taskPayload,
      errorLabel: handler.errorLabel,
      messageProcessLimiter,
      executeInboundTaskWithSessionQueue,
      processInboundMessage,
    });
    return true;
  };
}
