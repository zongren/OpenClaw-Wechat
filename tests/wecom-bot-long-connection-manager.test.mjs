import assert from "node:assert/strict";
import test from "node:test";

import { createWecomBotLongConnectionManager } from "../src/wecom/bot-long-connection-manager.js";
import { parseWecomBotInboundMessage, describeWecomBotParsedMessage } from "../src/wecom/webhook-adapter.js";

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url, protocols = [], options = undefined) {
    this.url = url;
    this.protocols = protocols;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  on(type, handler) {
    this.addEventListener(type, handler);
  }

  send(payload) {
    this.sent.push(JSON.parse(String(payload)));
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  terminate() {
    this.close(1006, "terminated");
  }

  emit(type, event = {}) {
    const list = this.listeners.get(type) ?? [];
    for (const handler of list) {
      handler(event);
    }
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  pushMessage(payload) {
    this.emit("message", { data: JSON.stringify(payload) });
  }
}

function createLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

test("bot long connection subscribes, receives push, and sends stream replies", async () => {
  FakeWebSocket.instances.length = 0;
  const createdStreams = [];
  const processed = [];
  const manager = createWecomBotLongConnectionManager({
    attachWecomProxyDispatcher: (_url, options) => options,
    resolveWecomBotConfigs: () => [
      {
        accountId: "default",
        enabled: true,
        placeholderText: "处理中",
        longConnection: {
          enabled: true,
          botId: "bot-123",
          secret: "secret-xyz",
          url: "wss://example.test/longconn",
          pingIntervalMs: 30000,
          reconnectDelayMs: 1000,
          maxReconnectDelayMs: 5000,
        },
      },
    ],
    resolveWecomBotProxyConfig: () => "",
    parseWecomBotInboundMessage,
    describeWecomBotParsedMessage,
    buildWecomBotSessionId: (fromUser, accountId) => `wecom-bot:${accountId}:${fromUser}`,
    createBotStream: (streamId, content, options) => {
      createdStreams.push({ streamId, content, options });
    },
    upsertBotResponseUrlCache: () => {},
    markInboundMessageSeen: () => true,
    messageProcessLimiter: {
      execute(fn) {
        return Promise.resolve().then(fn);
      },
    },
    executeInboundTaskWithSessionQueue: async ({ task }) => task(),
    deliverBotReplyText: async () => ({ ok: true }),
    webSocketCtor: FakeWebSocket,
  });
  manager.setProcessBotInboundHandler(async (payload) => {
    processed.push(payload);
  });

  manager.sync({
    logger: createLogger(),
  });

  assert.equal(FakeWebSocket.instances.length, 1);
  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.url, "wss://example.test/longconn");

  ws.open();
  assert.equal(ws.sent[0].cmd, "aibot_subscribe");
  assert.equal(typeof ws.sent[0].headers.req_id, "string");
  assert.equal(ws.sent[0].body.bot_id, "bot-123");
  assert.equal(ws.sent[0].body.secret, "secret-xyz");

  ws.pushMessage({
    headers: {
      req_id: ws.sent[0].headers.req_id,
    },
    errcode: 0,
    errmsg: "ok",
  });

  ws.pushMessage({
    cmd: "aibot_msg_callback",
    headers: {
      req_id: "callback-001",
    },
    body: {
      msgtype: "text",
      msgid: "msg-001",
      chattype: "single",
      from: { userid: "dingxiang" },
      text: { content: "你好" },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(createdStreams.length, 1);
  assert.equal(createdStreams[0].content, "处理中");
  assert.equal(ws.sent[1].cmd, "aibot_respond_msg");
  assert.equal(ws.sent[1].headers.req_id, "callback-001");
  assert.equal(ws.sent[1].body.msgtype, "stream");
  assert.equal(ws.sent[1].body.stream.finish, false);
  assert.equal(processed.length, 1);
  assert.equal(processed[0].msgId, "msg-001");

  ws.pushMessage({
    headers: {
      req_id: "callback-001",
    },
    errcode: 0,
    errmsg: "ok",
  });

  const streamId = createdStreams[0].streamId;
  const pushPromise = manager.pushStreamUpdate({
    accountId: "default",
    sessionId: "wecom-bot:default:dingxiang",
    streamId,
    content: "最终回复",
    finish: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  ws.pushMessage({
    headers: {
      req_id: "callback-001",
    },
    errcode: 0,
    errmsg: "ok",
  });
  const pushResult = await pushPromise;

  assert.equal(pushResult.ok, true);
  assert.equal(ws.sent[2].cmd, "aibot_respond_msg");
  assert.equal(ws.sent[2].headers.req_id, "callback-001");
  assert.equal(ws.sent[2].body.stream.id, streamId);
  assert.equal(ws.sent[2].body.stream.content, "最终回复");
  assert.equal(ws.sent[2].body.stream.finish, true);
});
