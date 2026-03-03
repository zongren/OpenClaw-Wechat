import assert from "node:assert/strict";
import test from "node:test";

import { createWecomAgentPushDeliverer } from "../src/wecom/outbound-agent-push.js";

test("deliverAgentPushReply returns missing when account config is absent", async () => {
  const deliver = createWecomAgentPushDeliverer({
    getWecomConfig: () => null,
    sendWecomText: async () => {},
  });
  const result = await deliver({
    api: { logger: { warn() {} } },
    fromUser: "u1",
    content: "hello",
    fallbackText: "fallback",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "agent-config-missing");
});

test("deliverAgentPushReply sends text with fallback suffix", async () => {
  const calls = [];
  const deliver = createWecomAgentPushDeliverer({
    getWecomConfig: () => ({
      accountId: "default",
      corpId: "ww-test",
      corpSecret: "secret",
      agentId: "100001",
      outboundProxy: "",
    }),
    sendWecomText: async (payload) => calls.push(payload),
  });
  const result = await deliver({
    api: { logger: { warn() {} } },
    fromUser: "u1",
    content: "",
    fallbackText: "fallback",
    mediaFallbackSuffix: "\n\n媒体链接：\nhttps://example.com/a.png",
  });
  assert.equal(result.ok, true);
  assert.equal(result.meta.accountId, "default");
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /fallback/);
  assert.match(calls[0].text, /媒体链接/);
});
