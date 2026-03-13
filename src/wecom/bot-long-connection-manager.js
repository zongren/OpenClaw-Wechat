import crypto from "node:crypto";
import WebSocket from "ws";
import { markWecomInboundActivity, setWecomConnectionState } from "./channel-status-state.js";

const DEFAULT_LONG_CONNECTION_URL = "wss://openws.work.weixin.qq.com";
const LEGACY_LONG_CONNECTION_URL = "wss://open.work.weixin.qq.com/ws/aibot";
const DEFAULT_CONTEXT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_REPLY_ACK_TIMEOUT_MS = 5000;
const LONG_CONNECTION_RUNTIME_MARKER = "openclaw-wechat-longconn-2026-03-08";
const CMD_SUBSCRIBE = "aibot_subscribe";
const CMD_PING = "ping";
const CMD_RESPONSE = "aibot_respond_msg";
const CMD_CALLBACK = "aibot_msg_callback";
const CMD_EVENT_CALLBACK = "aibot_event_callback";

function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomBotLongConnectionManager: ${name} is required`);
  }
}

function normalizeAccountId(accountId) {
  const normalized = String(accountId ?? "default").trim().toLowerCase();
  return normalized || "default";
}

function normalizeLongConnectionUrl(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return DEFAULT_LONG_CONNECTION_URL;
  if (normalized === LEGACY_LONG_CONNECTION_URL) return DEFAULT_LONG_CONNECTION_URL;
  return normalized;
}

function normalizeReplyContext(context = {}) {
  const accountId = normalizeAccountId(context.accountId);
  const sessionId = String(context.sessionId ?? "").trim();
  const streamId = String(context.streamId ?? "").trim();
  const msgId = String(context.msgId ?? "").trim();
  const reqId = String(context.reqId ?? "").trim();
  if (!accountId || !sessionId || !streamId || !msgId || !reqId) return null;
  return {
    accountId,
    sessionId,
    streamId,
    msgId,
    reqId,
    fromUser: String(context.fromUser ?? "").trim(),
    chatId: String(context.chatId ?? "").trim(),
    expiresAt: Date.now() + DEFAULT_CONTEXT_TTL_MS,
    updatedAt: Date.now(),
  };
}

async function readWebSocketMessageData(data) {
  const source = data && typeof data === "object" && "data" in data ? data.data : data;
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array || Buffer.isBuffer(source)) {
    return Buffer.from(source).toString("utf8");
  }
  if (source instanceof ArrayBuffer) {
    return Buffer.from(source).toString("utf8");
  }
  if (source && typeof source.text === "function") {
    return await source.text();
  }
  return String(source ?? "");
}

function bindSocketListener(ws, type, handler) {
  if (!ws || typeof handler !== "function") return;
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener(type, handler);
    return;
  }
  if (typeof ws.on === "function") {
    ws.on(type, handler);
    return;
  }
  throw new Error(`Unsupported WebSocket listener API for event: ${type}`);
}

function safeCloseSocket(ws, code = 1000, reason = "") {
  if (!ws) return;
  try {
    ws.close?.(code, reason);
  } catch {
    // ignore close failure
  }
}

function safeTerminateSocket(ws) {
  if (!ws) return;
  try {
    if (typeof ws.terminate === "function") {
      ws.terminate();
      return;
    }
  } catch {
    // ignore terminate failure
  }
  safeCloseSocket(ws, 1000, "terminated");
}

function socketOpenState(webSocketCtor) {
  return Number(webSocketCtor?.OPEN ?? 1);
}

function isSocketOpen(ws, webSocketCtor) {
  return Boolean(ws) && Number(ws.readyState) === socketOpenState(webSocketCtor);
}

function normalizeCloseReason(reason) {
  if (reason == null) return "";
  if (typeof reason === "string") return reason;
  if (reason instanceof Uint8Array || Buffer.isBuffer(reason)) return Buffer.from(reason).toString("utf8");
  return String(reason);
}

export function createWecomBotLongConnectionManager({
  attachWecomProxyDispatcher,
  resolveWecomBotConfigs,
  resolveWecomBotProxyConfig,
  parseWecomBotInboundMessage,
  describeWecomBotParsedMessage,
  buildWecomBotSessionId,
  createBotStream,
  upsertBotResponseUrlCache,
  markInboundMessageSeen,
  messageProcessLimiter,
  executeInboundTaskWithSessionQueue,
  deliverBotReplyText,
  recordInboundMetric = () => {},
  recordRuntimeErrorMetric = () => {},
  webSocketCtor = WebSocket,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  randomUuid = () => crypto.randomUUID?.(),
} = {}) {
  assertFunction("attachWecomProxyDispatcher", attachWecomProxyDispatcher);
  assertFunction("resolveWecomBotConfigs", resolveWecomBotConfigs);
  assertFunction("resolveWecomBotProxyConfig", resolveWecomBotProxyConfig);
  assertFunction("parseWecomBotInboundMessage", parseWecomBotInboundMessage);
  assertFunction("describeWecomBotParsedMessage", describeWecomBotParsedMessage);
  assertFunction("buildWecomBotSessionId", buildWecomBotSessionId);
  assertFunction("createBotStream", createBotStream);
  assertFunction("upsertBotResponseUrlCache", upsertBotResponseUrlCache);
  assertFunction("markInboundMessageSeen", markInboundMessageSeen);
  if (!messageProcessLimiter || typeof messageProcessLimiter.execute !== "function") {
    throw new Error("createWecomBotLongConnectionManager: messageProcessLimiter.execute is required");
  }
  assertFunction("executeInboundTaskWithSessionQueue", executeInboundTaskWithSessionQueue);
  assertFunction("deliverBotReplyText", deliverBotReplyText);
  if (typeof webSocketCtor !== "function") {
    throw new Error("createWecomBotLongConnectionManager: webSocketCtor is required");
  }

  let processBotInboundMessage = null;
  const clients = new Map();
  const streamContexts = new Map();
  const sessionContexts = new Map();

  function setProcessBotInboundHandler(handler) {
    processBotInboundMessage = typeof handler === "function" ? handler : null;
  }

  function pruneReplyContexts() {
    const now = Date.now();
    for (const [streamId, context] of streamContexts.entries()) {
      if (Number(context?.expiresAt ?? 0) <= now) {
        streamContexts.delete(streamId);
      }
    }
    for (const [sessionId, context] of sessionContexts.entries()) {
      if (Number(context?.expiresAt ?? 0) <= now) {
        sessionContexts.delete(sessionId);
      }
    }
  }

  function rememberReplyContext(context = {}) {
    const normalized = normalizeReplyContext(context);
    if (!normalized) return null;
    streamContexts.set(normalized.streamId, normalized);
    sessionContexts.set(normalized.sessionId, normalized);
    return normalized;
  }

  function resolveReplyContext({ accountId = "default", streamId = "", sessionId = "" } = {}) {
    pruneReplyContexts();
    const normalizedStreamId = String(streamId ?? "").trim();
    const normalizedSessionId = String(sessionId ?? "").trim();
    const normalizedAccountId = normalizeAccountId(accountId);
    const match =
      (normalizedStreamId ? streamContexts.get(normalizedStreamId) : null) ??
      (normalizedSessionId ? sessionContexts.get(normalizedSessionId) : null) ??
      null;
    if (!match) return null;
    if (normalizeAccountId(match.accountId) !== normalizedAccountId) return null;
    return match;
  }

  function buildStreamId(accountId = "default") {
    const normalized = String(randomUuid() || "").trim();
    const accountSlug = normalizeAccountId(accountId).replace(/[^a-z0-9_-]/g, "_") || "default";
    if (normalized) return `stream_${normalized}`;
    return `stream_${accountSlug}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function buildRequestId(prefix = "req") {
    const normalizedPrefix = String(prefix ?? "req")
      .trim()
      .replace(/[^a-z0-9_-]/gi, "_") || "req";
    const normalized = String(randomUuid() || "").trim();
    if (normalized) return `${normalizedPrefix}_${normalized}`;
    return `${normalizedPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function getClient(accountId = "default") {
    return clients.get(normalizeAccountId(accountId)) ?? null;
  }

  function sendRawJson(client, payload) {
    if (!client?.ws || !isSocketOpen(client.ws, webSocketCtor)) {
      return false;
    }
    client.ws.send(JSON.stringify(payload));
    client.lastSentAt = Date.now();
    return true;
  }

  function sendCommand(client, { cmd = "", body, reqId = "", reqIdPrefix = cmd, headers = {} } = {}) {
    const normalizedCmd = String(cmd ?? "").trim();
    if (!normalizedCmd) return "";
    const resolvedReqId = String(reqId ?? "").trim() || buildRequestId(reqIdPrefix || normalizedCmd);
    const payload = {
      cmd: normalizedCmd,
      headers: {
        ...headers,
        req_id: resolvedReqId,
      },
    };
    if (body !== undefined) {
      payload.body = body;
    }
    const sent = sendRawJson(client, payload);
    return sent ? resolvedReqId : "";
  }

  function clearClientTimers(client) {
    if (!client) return;
    if (client.pingTimer) {
      clearIntervalFn(client.pingTimer);
      client.pingTimer = null;
    }
    if (client.reconnectTimer) {
      clearTimeoutFn(client.reconnectTimer);
      client.reconnectTimer = null;
    }
  }

  function clearPendingReplies(client, reason = "connection reset") {
    if (!client) return;
    for (const pending of client.pendingAcks.values()) {
      clearTimeoutFn(pending.timer);
      pending.reject(new Error(reason));
    }
    client.pendingAcks.clear();
    for (const [reqId, queue] of client.replyQueues.entries()) {
      for (const item of queue) {
        item.reject(new Error(`${reason} (${reqId})`));
      }
    }
    client.replyQueues.clear();
  }

  function handleReplyAck(client, reqId, frame) {
    const pending = client?.pendingAcks?.get(reqId);
    if (!pending) return;
    clearTimeoutFn(pending.timer);
    client.pendingAcks.delete(reqId);
    const queue = client.replyQueues.get(reqId);
    if (queue) {
      queue.shift();
      if (queue.length === 0) {
        client.replyQueues.delete(reqId);
      }
    }
    if (Number(frame?.errcode ?? -1) === 0) {
      pending.resolve(frame);
    } else {
      pending.reject(
        new Error(
          `reply rejected errcode=${Number(frame?.errcode ?? -1)} errmsg=${String(frame?.errmsg ?? "unknown")}`,
        ),
      );
    }
    if (client.replyQueues.has(reqId)) {
      processReplyQueue(client, reqId);
    }
  }

  function processReplyQueue(client, reqId) {
    if (!client || !reqId) return;
    if (client.pendingAcks.has(reqId)) return;
    const queue = client.replyQueues.get(reqId);
    if (!Array.isArray(queue) || queue.length === 0) {
      client.replyQueues.delete(reqId);
      return;
    }
    const item = queue[0];
    if (!client.connected || !client.ws || !isSocketOpen(client.ws, webSocketCtor)) {
      queue.shift();
      item.reject(new Error("long connection is not ready"));
      if (queue.length === 0) {
        client.replyQueues.delete(reqId);
      } else {
        processReplyQueue(client, reqId);
      }
      return;
    }
    const sent = sendRawJson(client, item.frame);
    if (!sent) {
      queue.shift();
      item.reject(new Error("failed to send long connection frame"));
      if (queue.length === 0) {
        client.replyQueues.delete(reqId);
      } else {
        processReplyQueue(client, reqId);
      }
      return;
    }
    const timer = setTimeoutFn(() => {
      client.pendingAcks.delete(reqId);
      const currentQueue = client.replyQueues.get(reqId);
      if (currentQueue?.length) {
        currentQueue.shift();
        if (currentQueue.length === 0) {
          client.replyQueues.delete(reqId);
        }
      }
      item.reject(new Error(`reply ack timeout (${DEFAULT_REPLY_ACK_TIMEOUT_MS}ms)`));
      if (client.replyQueues.has(reqId)) {
        processReplyQueue(client, reqId);
      }
    }, DEFAULT_REPLY_ACK_TIMEOUT_MS);
    timer?.unref?.();
    client.pendingAcks.set(reqId, {
      timer,
      resolve: item.resolve,
      reject: item.reject,
    });
  }

  function enqueueReplyFrame(client, { reqId = "", cmd = CMD_RESPONSE, body } = {}) {
    const normalizedReqId = String(reqId ?? "").trim();
    if (!normalizedReqId) {
      return Promise.reject(new Error("missing req_id for long connection reply"));
    }
    const payload = {
      cmd,
      headers: {
        req_id: normalizedReqId,
      },
      body,
    };
    return new Promise((resolve, reject) => {
      const queue = client.replyQueues.get(normalizedReqId) ?? [];
      queue.push({ frame: payload, resolve, reject });
      client.replyQueues.set(normalizedReqId, queue);
      if (queue.length === 1) {
        processReplyQueue(client, normalizedReqId);
      }
    });
  }

  function startPingLoop(client, api) {
    if (client.pingTimer) {
      clearIntervalFn(client.pingTimer);
      client.pingTimer = null;
    }
    const intervalMs = Math.max(10000, Number(client?.config?.longConnection?.pingIntervalMs) || 30000);
    client.missedHeartbeatAcks = 0;
    client.pingTimer = setIntervalFn(() => {
      try {
        if (client.missedHeartbeatAcks >= 2) {
          api?.logger?.warn?.(
            `wechat_work(bot-longconn): heartbeat missed twice, force reconnect account=${client.accountId}`,
          );
          safeTerminateSocket(client.ws);
          return;
        }
        client.missedHeartbeatAcks += 1;
        client.lastPingReqId =
          sendCommand(client, {
            cmd: CMD_PING,
            reqIdPrefix: CMD_PING,
          }) || client.lastPingReqId;
      } catch (err) {
        api?.logger?.warn?.(
          `wechat_work(bot-longconn): ping failed account=${client.accountId}: ${String(err?.message || err)}`,
        );
      }
    }, intervalMs);
    client.pingTimer?.unref?.();
  }

  function scheduleReconnect(client, api) {
    if (!client?.shouldRun) return;
    if (client.reconnectTimer) return;
    const baseDelay = Math.max(1000, Number(client?.config?.longConnection?.reconnectDelayMs) || 5000);
    const maxDelay = Math.max(baseDelay, Number(client?.config?.longConnection?.maxReconnectDelayMs) || 60000);
    const delayMs = Math.min(baseDelay * Math.pow(2, Math.max(0, client.reconnectAttempts || 0)), maxDelay);
    client.reconnectAttempts = Math.max(0, client.reconnectAttempts || 0) + 1;
    client.reconnectTimer = setTimeoutFn(() => {
      client.reconnectTimer = null;
      connectClient(client, api);
    }, delayMs);
    client.reconnectTimer?.unref?.();
    api?.logger?.warn?.(
      `wechat_work(bot-longconn): reconnect scheduled account=${client.accountId} in ${delayMs}ms`,
    );
  }

  function stopClient(client, { closeCode = 1000, reason = "stopped" } = {}) {
    if (!client) return;
    client.shouldRun = false;
    clearClientTimers(client);
    clearPendingReplies(client, `long connection stopped: ${reason}`);
    client.connected = false;
    client.socketOpen = false;
    client.subscribeReqId = "";
    client.lastPingReqId = "";
    client.missedHeartbeatAcks = 0;
    setWecomConnectionState({
      accountId: client.accountId,
      connected: false,
      transport: "bot.longConnection",
    });
    safeCloseSocket(client.ws, closeCode, reason);
    client.ws = null;
  }

  async function scheduleInboundTask({ api, parsed, botSessionId, streamId }) {
    if (typeof processBotInboundMessage !== "function") {
      throw new Error("bot long connection inbound processor not configured");
    }
    messageProcessLimiter
      .execute(() =>
        executeInboundTaskWithSessionQueue({
          api,
          sessionId: botSessionId,
          isBot: true,
          task: () =>
            processBotInboundMessage({
              api,
              streamId,
              fromUser: parsed.fromUser,
              content: parsed.content,
              msgType: parsed.msgType,
              msgId: parsed.msgId,
              chatId: parsed.chatId,
              isGroupChat: parsed.isGroupChat,
              imageUrls: parsed.imageUrls,
              fileUrl: parsed.fileUrl,
              fileName: parsed.fileName,
              quote: parsed.quote,
              responseUrl: parsed.responseUrl,
              accountId: parsed.accountId,
              voiceUrl: parsed.voiceUrl,
              voiceMediaId: parsed.voiceMediaId,
              voiceContentType: parsed.voiceContentType,
            }),
        }),
      )
      .catch((err) => {
        api?.logger?.error?.(
          `wechat_work(bot-longconn): async message processing failed: ${String(err?.message || err)}`,
        );
        recordRuntimeErrorMetric({
          scope: "bot-longconn-dispatch",
          reason: String(err?.message || err),
          accountId: parsed.accountId,
        });
        deliverBotReplyText({
          api,
          fromUser: parsed.fromUser,
          sessionId: botSessionId,
          streamId,
          accountId: parsed.accountId,
          text: `抱歉，当前模型请求失败，请稍后重试。\n故障信息: ${String(err?.message || err).slice(0, 160)}`,
          reason: "bot-longconn-processing-error",
        }).catch((deliveryErr) => {
          api?.logger?.warn?.(
            `wechat_work(bot-longconn): failed to deliver async error reply: ${String(deliveryErr?.message || deliveryErr)}`,
          );
        });
      });
  }

  async function pushStreamUpdate({
    accountId = "default",
    sessionId = "",
    streamId = "",
    content = "",
    finish = false,
    msgItem,
    thinkingContent = "",
  } = {}) {
    const context = resolveReplyContext({ accountId, streamId, sessionId });
    if (!context) return { ok: false, reason: "context-missing" };
    const client = getClient(context.accountId);
    if (!client || client.connected !== true) {
      return { ok: false, reason: "connection-missing" };
    }

    const body = {
      msgtype: "stream",
      stream: {
        id: String(streamId || context.streamId),
        content: String(content ?? ""),
        finish: finish === true,
      },
    };
    if (Array.isArray(msgItem) && msgItem.length > 0) {
      body.stream.msg_item = msgItem;
    }
    if (String(thinkingContent ?? "").trim()) {
      body.stream.thinking_content = String(thinkingContent).trim();
    }

    await enqueueReplyFrame(client, {
      reqId: context.reqId,
      cmd: CMD_RESPONSE,
      body,
    });

    if (finish === true) {
      const nextContext = {
        ...context,
        expiresAt: Date.now() + DEFAULT_CONTEXT_TTL_MS,
        updatedAt: Date.now(),
      };
      streamContexts.set(context.streamId, nextContext);
      sessionContexts.set(context.sessionId, nextContext);
    }
    return { ok: true, mode: "long_connection", msgId: context.msgId };
  }

  async function handleParsedMessage({ api, client, parsed }) {
    if (!parsed || typeof parsed !== "object") return;
    parsed.accountId = client.accountId;
    markWecomInboundActivity({
      accountId: client.accountId,
      timestamp: Date.now(),
    });
    api?.logger?.info?.(
      `wechat_work(bot-longconn): inbound ${describeWecomBotParsedMessage(parsed)} account=${client.accountId}`,
    );

    if (parsed.kind === "event" || parsed.kind === "unsupported" || parsed.kind === "invalid") {
      return;
    }
    if (parsed.kind !== "message") return;

    recordInboundMetric({
      mode: "bot-longconn",
      msgType: parsed.msgType || parsed.kind || "unknown",
      accountId: client.accountId,
    });
    const dedupeStub = {
      MsgId: parsed.msgId,
      FromUserName: parsed.fromUser,
      MsgType: parsed.msgType,
      Content: parsed.content,
      CreateTime: String(Math.floor(Date.now() / 1000)),
    };
    if (!markInboundMessageSeen(dedupeStub, `bot:${client.accountId}`)) {
      return;
    }

    const botSessionId = buildWecomBotSessionId(parsed.fromUser, client.accountId);
    const streamId = buildStreamId(client.accountId);
    createBotStream(streamId, client.config.placeholderText, {
      feedbackId: parsed.feedbackId,
      sessionId: botSessionId,
      accountId: client.accountId,
    });
    if (parsed.responseUrl) {
      upsertBotResponseUrlCache({
        sessionId: botSessionId,
        responseUrl: parsed.responseUrl,
      });
    }
    rememberReplyContext({
      accountId: client.accountId,
      sessionId: botSessionId,
      streamId,
      msgId: parsed.msgId,
      reqId: parsed.reqId,
      fromUser: parsed.fromUser,
      chatId: parsed.chatId,
    });
    void pushStreamUpdate({
      accountId: client.accountId,
      sessionId: botSessionId,
      streamId,
      content: client.config.placeholderText,
      finish: false,
    }).catch((err) => {
      api?.logger?.warn?.(
        `wechat_work(bot-longconn): placeholder push failed account=${client.accountId}: ${String(err?.message || err)}`,
      );
    });
    await scheduleInboundTask({
      api,
      parsed,
      botSessionId,
      streamId,
    });
  }

  async function handleSocketFrame(client, api, payload) {
    const command = String(payload?.cmd ?? "").trim().toLowerCase();
    const reqId = String(payload?.headers?.req_id ?? payload?.headers?.reqId ?? "").trim();

    if (reqId && client.pendingAcks.has(reqId)) {
      handleReplyAck(client, reqId, payload);
      return;
    }

    if (command === "pong") {
      client.missedHeartbeatAcks = 0;
      return;
    }

    if (command === CMD_CALLBACK || command === CMD_EVENT_CALLBACK) {
      const normalizedBody =
        command === CMD_EVENT_CALLBACK && payload?.body && typeof payload.body === "object" && !payload.body.msgtype
          ? { ...payload.body, msgtype: "event" }
          : payload?.body;
      const parsed = parseWecomBotInboundMessage(normalizedBody);
      if (parsed && typeof parsed === "object") {
        parsed.reqId = reqId || buildRequestId(CMD_CALLBACK);
      }
      await handleParsedMessage({
        api,
        client,
        parsed,
      });
      return;
    }

    if (payload && typeof payload === "object" && Object.hasOwn(payload, "errcode")) {
      const errcode = Number(payload?.errcode ?? -1);
      const errmsg = String(payload?.errmsg ?? "").trim() || "n/a";
      if (reqId && (reqId === client.subscribeReqId || reqId.startsWith(`${CMD_SUBSCRIBE}_`))) {
        if (errcode === 0) {
          client.connected = true;
          client.socketOpen = true;
          client.reconnectAttempts = 0;
          client.missedHeartbeatAcks = 0;
          setWecomConnectionState({
            accountId: client.accountId,
            connected: true,
            transport: "bot.longConnection",
          });
          startPingLoop(client, api);
          api?.logger?.info?.(`wechat_work(bot-longconn): subscribed account=${client.accountId}`);
        } else {
          api?.logger?.warn?.(
            `wechat_work(bot-longconn): subscribe failed account=${client.accountId} errcode=${errcode} errmsg=${errmsg}`,
          );
          safeCloseSocket(client.ws, 4001, `subscribe failed: ${errmsg}`);
        }
        return;
      }
      if (reqId && (reqId === client.lastPingReqId || reqId.startsWith(`${CMD_PING}_`))) {
        if (errcode !== 0) {
          api?.logger?.warn?.(
            `wechat_work(bot-longconn): ping rejected account=${client.accountId} errcode=${errcode} errmsg=${errmsg}`,
          );
          return;
        }
        client.missedHeartbeatAcks = 0;
        return;
      }
      if (errcode !== 0) {
        api?.logger?.warn?.(
          `wechat_work(bot-longconn): command rejected account=${client.accountId} reqId=${reqId || "n/a"} errcode=${errcode} errmsg=${errmsg}`,
        );
      }
      return;
    }

    if (command && command !== CMD_PING) {
      api?.logger?.debug?.(
        `wechat_work(bot-longconn): ignore message cmd=${command} account=${client.accountId}`,
      );
    }
  }

  async function handleSocketMessage(client, api, eventOrData) {
    try {
      const raw = await readWebSocketMessageData(eventOrData);
      const payload = JSON.parse(String(raw ?? "{}"));
      await handleSocketFrame(client, api, payload);
    } catch (err) {
      api?.logger?.warn?.(
        `wechat_work(bot-longconn): failed to handle socket message account=${client.accountId}: ${String(err?.message || err)}`,
      );
      recordRuntimeErrorMetric({
        scope: "bot-longconn-message",
        reason: String(err?.message || err),
        accountId: client.accountId,
      });
    }
  }

  function connectClient(client, api) {
    if (!client?.shouldRun) return;
    clearClientTimers(client);
    clearPendingReplies(client, "reconnecting");
    setWecomConnectionState({
      accountId: client.accountId,
      connected: false,
      transport: "bot.longConnection",
    });
    const wsUrl = normalizeLongConnectionUrl(client?.config?.longConnection?.url ?? DEFAULT_LONG_CONNECTION_URL);
    const proxyUrl = String(client?.proxyUrl ?? "").trim();
    attachWecomProxyDispatcher(wsUrl, { forceProxy: true }, { proxyUrl, logger: api?.logger });
    api?.logger?.info?.(
      `wechat_work(bot-longconn): connect attempt account=${client.accountId} marker=${LONG_CONNECTION_RUNTIME_MARKER} url=${wsUrl} proxy=${proxyUrl || "direct"} wsCtor=${String(webSocketCtor?.name || "unknown")}`,
    );
    if (proxyUrl) {
      api?.logger?.debug?.(
        `wechat_work(bot-longconn): outboundProxy configured for account=${client.accountId}; current ws runtime uses direct WebSocket dialing`,
      );
    }
    client.ws = new webSocketCtor(wsUrl);
    client.connected = false;
    client.socketOpen = false;
    client.subscribeReqId = "";
    client.lastPingReqId = "";
    client.missedHeartbeatAcks = 0;
    client.lastConnectStartedAt = Date.now();

    bindSocketListener(client.ws, "open", () => {
      client.socketOpen = true;
      client.reconnectAttempts = 0;
      client.subscribeReqId =
        sendCommand(client, {
          cmd: CMD_SUBSCRIBE,
          reqIdPrefix: CMD_SUBSCRIBE,
          body: {
            bot_id: client.config.longConnection.botId,
            secret: client.config.longConnection.secret,
          },
        }) || "";
      api?.logger?.info?.(`wechat_work(bot-longconn): socket opened account=${client.accountId} url=${wsUrl}`);
    });
    bindSocketListener(client.ws, "message", (event) => {
      void handleSocketMessage(client, api, event);
    });
    bindSocketListener(client.ws, "error", (event) => {
      const err = event?.error ?? event;
      api?.logger?.warn?.(
        `wechat_work(bot-longconn): socket error account=${client.accountId}: ${String(err?.stack || err?.message || err || "unknown error")}`,
      );
    });
    bindSocketListener(client.ws, "close", (eventOrCode, maybeReason) => {
      const event =
        eventOrCode && typeof eventOrCode === "object"
          ? eventOrCode
          : { code: eventOrCode, reason: maybeReason };
      client.connected = false;
      client.socketOpen = false;
      client.subscribeReqId = "";
      client.lastPingReqId = "";
      client.missedHeartbeatAcks = 0;
      clearClientTimers(client);
      clearPendingReplies(client, `socket closed (${normalizeCloseReason(event?.reason) || event?.code || 0})`);
      setWecomConnectionState({
        accountId: client.accountId,
        connected: false,
        transport: "bot.longConnection",
      });
      client.ws = null;
      api?.logger?.warn?.(
        `wechat_work(bot-longconn): closed account=${client.accountId} code=${Number(event?.code ?? 0)} reason=${normalizeCloseReason(event?.reason)}`,
      );
      scheduleReconnect(client, api);
    });
    bindSocketListener(client.ws, "ping", () => {
      try {
        client.ws?.pong?.();
      } catch {
        // ignore pong failure
      }
    });
    bindSocketListener(client.ws, "pong", () => {
      client.missedHeartbeatAcks = 0;
    });
  }

  function buildClientSignature(config, proxyUrl) {
    return JSON.stringify({
      accountId: normalizeAccountId(config?.accountId),
      enabled: config?.longConnection?.enabled === true,
      botId: String(config?.longConnection?.botId ?? ""),
      secret: String(config?.longConnection?.secret ?? ""),
      url: normalizeLongConnectionUrl(config?.longConnection?.url ?? DEFAULT_LONG_CONNECTION_URL),
      pingIntervalMs: Number(config?.longConnection?.pingIntervalMs) || 0,
      reconnectDelayMs: Number(config?.longConnection?.reconnectDelayMs) || 0,
      maxReconnectDelayMs: Number(config?.longConnection?.maxReconnectDelayMs) || 0,
      proxyUrl: String(proxyUrl ?? ""),
    });
  }

  function sync(api) {
    const botConfigs = resolveWecomBotConfigs(api);
    const targetConfigs = (Array.isArray(botConfigs) ? botConfigs : [])
      .filter((item) => item?.enabled === true && item?.longConnection?.enabled === true)
      .map((item) => ({
        ...item,
        accountId: normalizeAccountId(item?.accountId),
        proxyUrl: resolveWecomBotProxyConfig(api, item?.accountId),
        longConnection: {
          ...(item?.longConnection || {}),
          url: normalizeLongConnectionUrl(item?.longConnection?.url),
        },
      }))
      .filter((item) => {
        const botId = String(item?.longConnection?.botId ?? "").trim();
        const secret = String(item?.longConnection?.secret ?? "").trim();
        if (botId && secret) return true;
        api?.logger?.warn?.(
          `wechat_work(bot-longconn): skipped account=${normalizeAccountId(item?.accountId)} (missing botId/secret)`,
        );
        return false;
      });

    const wantedAccountIds = new Set(targetConfigs.map((item) => item.accountId));
    for (const [accountId, client] of clients.entries()) {
      if (wantedAccountIds.has(accountId)) continue;
      stopClient(client);
      clients.delete(accountId);
      api?.logger?.info?.(`wechat_work(bot-longconn): stopped account=${accountId}`);
    }

    let started = 0;
    for (const config of targetConfigs) {
      const signature = buildClientSignature(config, config.proxyUrl);
      const existing = clients.get(config.accountId);
      if (existing && existing.signature === signature) {
        existing.shouldRun = true;
        if (!existing.connected && !existing.reconnectTimer && !existing.ws) {
          connectClient(existing, api);
        }
        started += 1;
        continue;
      }
      if (existing) {
        stopClient(existing, { reason: "reconfigure" });
      }
      const client = {
        accountId: config.accountId,
        config,
        proxyUrl: config.proxyUrl,
        signature,
        ws: null,
        connected: false,
        shouldRun: true,
        reconnectAttempts: 0,
        pingTimer: null,
        reconnectTimer: null,
        lastConnectStartedAt: 0,
        lastSentAt: 0,
        lastPingReqId: "",
        subscribeReqId: "",
        socketOpen: false,
        missedHeartbeatAcks: 0,
        replyQueues: new Map(),
        pendingAcks: new Map(),
      };
      clients.set(config.accountId, client);
      connectClient(client, api);
      started += 1;
    }
    return { started };
  }

  function stopAll() {
    for (const client of clients.values()) {
      stopClient(client);
    }
    clients.clear();
  }

  function getConnectionState(accountId = "default") {
    const client = getClient(accountId);
    return {
      accountId: normalizeAccountId(accountId),
      connected: client?.connected === true,
      longConnectionEnabled: client?.config?.longConnection?.enabled === true,
    };
  }

  return {
    setProcessBotInboundHandler,
    rememberReplyContext,
    resolveReplyContext,
    pushStreamUpdate,
    sync,
    stopAll,
    getConnectionState,
  };
}
