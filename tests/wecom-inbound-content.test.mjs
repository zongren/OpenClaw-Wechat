import assert from "node:assert/strict";
import test from "node:test";

import { createWecomInboundContentBuilder } from "../src/wecom/inbound-content.js";

function createApiMock() {
  return {
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  };
}

test("buildInboundContent saves image to temp path", async () => {
  const writes = [];
  const builder = createWecomInboundContentBuilder({
    downloadWecomMedia: async () => ({
      buffer: Buffer.from("image-binary"),
      contentType: "image/png",
    }),
    fetchMediaFromUrl: async () => ({ buffer: Buffer.from(""), contentType: "" }),
    resolveWecomVoiceTranscriptionConfig: () => ({ enabled: true, model: "base" }),
    transcribeInboundVoice: async () => "",
    sendWecomText: async () => {},
    ensureDir: async () => {},
    writeFile: async (filePath, data) => {
      writes.push({ filePath, bytes: data.length });
    },
    now: () => 1700000000000,
    randomSuffix: () => "abc123",
    tmpDirResolver: () => "/tmp",
  });

  const result = await builder.buildInboundContent({
    api: createApiMock(),
    corpId: "ww",
    corpSecret: "secret",
    agentId: "1000002",
    proxyUrl: "",
    fromUser: "dingxiang",
    msgType: "image",
    baseText: "",
    mediaId: "MEDIA_1",
    picUrl: "",
  });

  assert.equal(result.aborted, false);
  assert.equal(result.tempPathsToCleanup.length, 1);
  assert.ok(result.messageText.includes("用户发送了一张图片"));
  assert.ok(result.messageText.includes("/tmp/openclaw-wechat/image-1700000000000-abc123.png"));
  assert.equal(writes.length, 1);
});

test("buildInboundContent aborts when voice fallback disabled", async () => {
  const sent = [];
  const builder = createWecomInboundContentBuilder({
    downloadWecomMedia: async () => ({
      buffer: Buffer.from("voice"),
      contentType: "audio/amr",
    }),
    fetchMediaFromUrl: async () => ({ buffer: Buffer.from(""), contentType: "" }),
    resolveWecomVoiceTranscriptionConfig: () => ({ enabled: false }),
    transcribeInboundVoice: async () => "ignored",
    sendWecomText: async (payload) => {
      sent.push(payload);
    },
    ensureDir: async () => {},
    writeFile: async () => {},
    tmpDirResolver: () => "/tmp",
  });

  const result = await builder.buildInboundContent({
    api: createApiMock(),
    corpId: "ww",
    corpSecret: "secret",
    agentId: "1000002",
    proxyUrl: "",
    fromUser: "dingxiang",
    msgType: "voice",
    baseText: "",
    mediaId: "VOICE_1",
    recognition: "",
  });

  assert.equal(result.aborted, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /语音识别未启用/);
});

test("buildInboundContent formats link message", async () => {
  const builder = createWecomInboundContentBuilder({
    downloadWecomMedia: async () => ({
      buffer: Buffer.from(""),
      contentType: "",
    }),
    fetchMediaFromUrl: async () => ({ buffer: Buffer.from(""), contentType: "" }),
    resolveWecomVoiceTranscriptionConfig: () => ({ enabled: true, model: "base" }),
    transcribeInboundVoice: async () => "",
    sendWecomText: async () => {},
    ensureDir: async () => {},
    writeFile: async () => {},
    tmpDirResolver: () => "/tmp",
  });

  const result = await builder.buildInboundContent({
    api: createApiMock(),
    corpId: "ww",
    corpSecret: "secret",
    agentId: "1000002",
    proxyUrl: "",
    fromUser: "dingxiang",
    msgType: "link",
    baseText: "",
    linkTitle: "测试链接",
    linkDescription: "描述",
    linkUrl: "https://example.com",
  });

  assert.equal(result.aborted, false);
  assert.ok(result.messageText.includes("用户分享了一个链接"));
  assert.ok(result.messageText.includes("测试链接"));
  assert.ok(result.messageText.includes("https://example.com"));
});
