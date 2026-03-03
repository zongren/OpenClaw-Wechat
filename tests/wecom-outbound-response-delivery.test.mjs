import assert from "node:assert/strict";
import test from "node:test";

import { createWecomResponseUrlDeliverer } from "../src/wecom/outbound-response-delivery.js";

test("deliverResponseUrlReply returns missing when no response url", async () => {
  const deliver = createWecomResponseUrlDeliverer({
    sendWecomBotPayloadViaResponseUrl: async () => ({ status: 200, errcode: 0 }),
    markBotResponseUrlUsed: () => {},
  });
  const result = await deliver({
    sessionId: "wecom-bot:u1",
    inlineResponseUrl: "",
    cachedResponseUrl: null,
    fallbackText: "fallback",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "response-url-missing");
});

test("deliverResponseUrlReply returns used when cached response url was consumed", async () => {
  const deliver = createWecomResponseUrlDeliverer({
    sendWecomBotPayloadViaResponseUrl: async () => ({ status: 200, errcode: 0 }),
    markBotResponseUrlUsed: () => {},
  });
  const result = await deliver({
    sessionId: "wecom-bot:u1",
    inlineResponseUrl: "",
    cachedResponseUrl: { url: "https://example.com/callback", used: true },
    fallbackText: "fallback",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "response-url-used");
});

test("deliverResponseUrlReply sends payload and marks used", async () => {
  const calls = [];
  const marks = [];
  const deliver = createWecomResponseUrlDeliverer({
    sendWecomBotPayloadViaResponseUrl: async (payload) => {
      calls.push(payload);
      return { status: 200, errcode: 0 };
    },
    markBotResponseUrlUsed: (sessionId) => marks.push(String(sessionId)),
  });
  const result = await deliver({
    sessionId: "wecom-bot:u1",
    inlineResponseUrl: "https://example.com/callback",
    cachedResponseUrl: null,
    mixedPayload: null,
    content: "hello",
    fallbackText: "fallback",
    timeoutMs: 5000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.meta.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].responseUrl, "https://example.com/callback");
  assert.deepEqual(marks, ["wecom-bot:u1"]);
});
