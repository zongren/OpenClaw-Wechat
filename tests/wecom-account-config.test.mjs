import assert from "node:assert/strict";
import test from "node:test";

import { createWecomAccountRegistry } from "../src/wecom/account-config.js";

function normalizeWecomWebhookTargetMap(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return { ...input };
}

test("createWecomAccountRegistry supports legacy inline account entries", () => {
  const registry = createWecomAccountRegistry({
    normalizeWecomWebhookTargetMap,
    resolveWecomProxyConfig: () => undefined,
    processEnv: {},
  });
  const cfg = {
    channels: {
      wecom: {
        corpId: "ww_default",
        corpSecret: "secret-default",
        agentId: 1000001,
        callbackToken: "default-callback-token",
        callbackAesKey: "default-callback-aes",
        sales: {
          token: "legacy-sales-bot-token",
          encodingAesKey: "legacy-sales-bot-aes",
          agent: {
            corpId: "ww_sales",
            corpSecret: "secret-sales",
            agentId: 1000009,
            token: "sales-callback-token",
            encodingAesKey: "sales-callback-aes",
          },
        },
      },
    },
  };
  const list = registry.listEnabledWecomAccounts({
    api: { config: cfg },
  });
  const byId = new Map(list.map((item) => [item.accountId, item]));
  assert.equal(byId.has("default"), true);
  assert.equal(byId.has("sales"), true);
  assert.equal(byId.get("sales")?.corpId, "ww_sales");
  assert.equal(byId.get("sales")?.callbackToken, "sales-callback-token");
  assert.equal(byId.get("sales")?.webhookPath, "/wecom/sales/callback");
});

test("createWecomAccountRegistry supports legacy inline default account block", () => {
  const registry = createWecomAccountRegistry({
    normalizeWecomWebhookTargetMap,
    resolveWecomProxyConfig: () => undefined,
    processEnv: {},
  });
  const cfg = {
    channels: {
      wecom: {
        default: {
          token: "legacy-default-bot-token",
          encodingAesKey: "legacy-default-bot-aes",
          agent: {
            corpId: "ww_default",
            corpSecret: "secret-default",
            agentId: 1000001,
            token: "default-callback-token",
            encodingAesKey: "default-callback-aes",
          },
        },
      },
    },
  };
  const account = registry.getWecomConfig({
    api: { config: cfg },
    accountId: "default",
  });
  assert.equal(account?.accountId, "default");
  assert.equal(account?.corpId, "ww_default");
  assert.equal(account?.callbackToken, "default-callback-token");
  assert.equal(account?.webhookPath, "/wecom/callback");
});
