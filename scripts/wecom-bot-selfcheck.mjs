#!/usr/bin/env node

import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const out = {
    account: "default",
    configPath: process.env.OPENCLAW_CONFIG_PATH || "~/.openclaw/openclaw.json",
    url: "",
    fromUser: "",
    content: "/status",
    timeoutMs: 8000,
    pollCount: 12,
    pollIntervalMs: 700,
    json: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--account" && next) {
      out.account = normalizeAccountId(next);
      i += 1;
    } else if (arg === "--config" && next) {
      out.configPath = next;
      i += 1;
    } else if (arg === "--url" && next) {
      out.url = next;
      i += 1;
    } else if (arg === "--from-user" && next) {
      out.fromUser = next;
      i += 1;
    } else if (arg === "--content" && next) {
      out.content = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.timeoutMs = n;
      i += 1;
    } else if (arg === "--poll-count" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.pollCount = Math.floor(n);
      i += 1;
    } else if (arg === "--poll-interval-ms" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.pollIntervalMs = Math.floor(n);
      i += 1;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return out;
}

function printHelp() {
  console.log(`OpenClaw-Wechat Bot selfcheck (E2E)

Usage:
  npm run wecom:bot:selfcheck -- [options]

Options:
  --account <id>            Bot account id (default: default)
  --config <path>            OpenClaw config path (default: ~/.openclaw/openclaw.json)
  --url <http-url>           Override Bot callback URL
  --from-user <userid>       Simulated sender (default: auto-generated)
  --content <text>           Message text to send (default: /status)
  --timeout-ms <ms>          HTTP timeout (default: 8000)
  --poll-count <n>           stream-refresh poll attempts (default: 12)
  --poll-interval-ms <ms>    stream-refresh interval (default: 700)
  --json                     Print JSON report
  -h, --help                 Show this help
`);
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function normalizeAccountId(accountId) {
  const normalized = String(accountId ?? "default").trim().toLowerCase();
  return normalized || "default";
}

function buildDefaultBotWebhookPath(accountId) {
  const normalized = normalizeAccountId(accountId);
  if (normalized === "default") return "/wecom/bot/callback";
  return `/wecom/${normalized}/bot/callback`;
}

function normalizeWebhookPath(raw, fallback = "/wecom/bot/callback") {
  const input = String(raw ?? "").trim();
  if (!input) return fallback;
  return input.startsWith("/") ? input : `/${input}`;
}

function pickFirstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function parseBooleanLike(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function asNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function decodeAesKey(aesKey) {
  const keyBase64 = aesKey.endsWith("=") ? aesKey : `${aesKey}=`;
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error(`invalid encodingAesKey length: decoded ${key.length} bytes, expected 32`);
  }
  return key;
}

function pkcs7Pad(buf, blockSize = 32) {
  const amountToPad = blockSize - (buf.length % blockSize || blockSize);
  const pad = Buffer.alloc(amountToPad === 0 ? blockSize : amountToPad, amountToPad === 0 ? blockSize : amountToPad);
  return Buffer.concat([buf, pad]);
}

function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) return buf;
  return buf.subarray(0, buf.length - pad);
}

function encryptWecom({ aesKey, plainText, corpId = "" }) {
  const key = decodeAesKey(aesKey);
  const iv = key.subarray(0, 16);
  const random16 = crypto.randomBytes(16);
  const msgBuffer = Buffer.from(String(plainText ?? ""), "utf8");
  const lenBuffer = Buffer.alloc(4);
  lenBuffer.writeUInt32BE(msgBuffer.length, 0);
  const corpBuffer = Buffer.from(String(corpId ?? ""), "utf8");
  const raw = Buffer.concat([random16, lenBuffer, msgBuffer, corpBuffer]);
  const padded = pkcs7Pad(raw, 32);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  return encrypted.toString("base64");
}

function decryptWecom({ aesKey, cipherTextBase64 }) {
  const key = decodeAesKey(aesKey);
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(Buffer.from(cipherTextBase64, "base64")), decipher.final()]);
  const unpadded = pkcs7Unpad(plain);
  const msgLen = unpadded.readUInt32BE(16);
  const msgStart = 20;
  const msgEnd = msgStart + msgLen;
  const msg = unpadded.subarray(msgStart, msgEnd).toString("utf8");
  return msg;
}

function computeMsgSignature({ token, timestamp, nonce, encrypt }) {
  const arr = [token, timestamp, nonce, encrypt].map(String).sort();
  return crypto.createHash("sha1").update(arr.join("")).digest("hex");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const timeout = Math.max(1000, Number(timeoutMs) || 8000);
  const requestOptions = {
    ...options,
    signal: AbortSignal.timeout(timeout),
  };
  return fetch(url, requestOptions);
}

function makeCheck(name, ok, detail, data = null) {
  return { name, ok: Boolean(ok), detail: String(detail ?? ""), data };
}

function summarize(checks) {
  const failed = checks.filter((c) => !c.ok).length;
  return {
    ok: failed === 0,
    total: checks.length,
    passed: checks.length - failed,
    failed,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveBotConfig(config) {
  const accountId = normalizeAccountId(config?.accountId ?? "default");
  const channel = config?.channels?.wecom ?? {};
  const accountBlock =
    accountId === "default"
      ? channel
      : channel?.accounts && typeof channel.accounts === "object"
        ? channel.accounts[accountId] ?? {}
        : {};
  const bot =
    accountId === "default"
      ? channel?.bot ?? {}
      : accountBlock?.bot && typeof accountBlock.bot === "object"
        ? accountBlock.bot
        : {};
  const envVars = config?.env?.vars ?? {};
  const accountEnvPrefix = accountId === "default" ? null : `WECOM_${accountId.toUpperCase()}_BOT_`;
  const readBotEnv = (suffix) => {
    const scopedKey = accountEnvPrefix ? `${accountEnvPrefix}${suffix}` : "";
    return pickFirstNonEmptyString(
      scopedKey ? envVars?.[scopedKey] : "",
      scopedKey ? process.env[scopedKey] : "",
      envVars?.[`WECOM_BOT_${suffix}`],
      process.env[`WECOM_BOT_${suffix}`],
    );
  };
  const enabled = parseBooleanLike(
    bot.enabled,
    parseBooleanLike(readBotEnv("ENABLED"), false),
  );
  const token = pickFirstNonEmptyString(bot.token, bot.callbackToken, readBotEnv("TOKEN"));
  const encodingAesKey = pickFirstNonEmptyString(bot.encodingAesKey, bot.callbackAesKey, readBotEnv("ENCODING_AES_KEY"));
  const webhookPath = normalizeWebhookPath(
    pickFirstNonEmptyString(bot.webhookPath, readBotEnv("WEBHOOK_PATH")),
    buildDefaultBotWebhookPath(accountId),
  );
  const gatewayPort = asNumber(config?.gateway?.port, 8885);
  return {
    accountId,
    enabled,
    token,
    encodingAesKey,
    webhookPath,
    gatewayPort: Math.max(1, gatewayPort || 8885),
  };
}

function buildCallbackUrl({ args, botConfig }) {
  if (String(args.url ?? "").trim()) return String(args.url).trim();
  return `http://127.0.0.1:${botConfig.gatewayPort}${botConfig.webhookPath}`;
}

function buildSignedEncryptedRequest({ endpoint, token, aesKey, payload }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(8).toString("hex");
  const encrypt = encryptWecom({
    aesKey,
    plainText: JSON.stringify(payload ?? {}),
    corpId: "",
  });
  const msgSignature = computeMsgSignature({
    token,
    timestamp,
    nonce,
    encrypt,
  });
  const url = new URL(endpoint);
  url.searchParams.set("msg_signature", msgSignature);
  url.searchParams.set("timestamp", timestamp);
  url.searchParams.set("nonce", nonce);
  return {
    requestUrl: url.toString(),
    body: JSON.stringify({ encrypt }),
  };
}

function parseEncryptedCallbackResponse(rawBody) {
  const body = JSON.parse(rawBody);
  const encrypt = String(body?.encrypt ?? "").trim();
  const msgsignature = String(body?.msgsignature ?? body?.msg_signature ?? "").trim();
  const timestamp = String(body?.timestamp ?? "").trim();
  const nonce = String(body?.nonce ?? "").trim();
  if (!encrypt || !msgsignature || !timestamp || !nonce) {
    throw new Error("missing response encrypt/msgsignature/timestamp/nonce");
  }
  return { encrypt, msgsignature, timestamp, nonce };
}

function verifyEncryptedCallbackResponse({ token, aesKey, rawBody }) {
  const parsed = parseEncryptedCallbackResponse(rawBody);
  const expected = computeMsgSignature({
    token,
    timestamp: parsed.timestamp,
    nonce: parsed.nonce,
    encrypt: parsed.encrypt,
  });
  if (expected !== parsed.msgsignature) {
    throw new Error("response signature mismatch");
  }
  const decryptedText = decryptWecom({
    aesKey,
    cipherTextBase64: parsed.encrypt,
  });
  const payload = JSON.parse(decryptedText);
  return { payload, meta: parsed };
}

async function postEncryptedPayload({ endpoint, token, aesKey, payload, timeoutMs }) {
  const signed = buildSignedEncryptedRequest({
    endpoint,
    token,
    aesKey,
    payload,
  });
  const response = await fetchWithTimeout(
    signed.requestUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: signed.body,
    },
    timeoutMs,
  );
  const rawBody = await response.text();
  return { response, rawBody };
}

function reportAndExit(report, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.summary.ok ? 0 : 1);
    return;
  }
  console.log("WeCom Bot E2E selfcheck");
  console.log(`- config: ${report.configPath}`);
  console.log(`- account: ${report.account}`);
  console.log(`- endpoint: ${report.endpoint}`);
  console.log(`- fromUser: ${report.fromUser}`);
  console.log(`- content: ${report.content}`);
  for (const check of report.checks) {
    console.log(`${check.ok ? "OK " : "FAIL"} ${check.name} :: ${check.detail}`);
  }
  console.log(`Summary: ${report.summary.passed}/${report.summary.total} passed`);
  process.exit(report.summary.ok ? 0 : 1);
}

async function runBotE2E({ config, args, configPath }) {
  const checks = [];
  const botConfig = resolveBotConfig({
    ...config,
    accountId: args.account,
  });
  const endpoint = buildCallbackUrl({ args, botConfig });
  const fromUser =
    String(args.fromUser ?? "").trim() || `DxBotSelfCheck${Date.now().toString(36).slice(-6)}`;
  const content = String(args.content ?? "").trim() || "/status";

  checks.push(
    makeCheck(
      "config.account",
      true,
      `account=${botConfig.accountId}`,
    ),
  );
  checks.push(makeCheck("config.bot.enabled", botConfig.enabled, botConfig.enabled ? "enabled" : "disabled"));
  checks.push(makeCheck("config.bot.token", Boolean(botConfig.token), botConfig.token ? "present" : "missing"));
  checks.push(
    makeCheck(
      "config.bot.encodingAesKey",
      Boolean(botConfig.encodingAesKey),
      botConfig.encodingAesKey ? "present" : "missing",
    ),
  );
  checks.push(makeCheck("config.bot.webhookPath", Boolean(botConfig.webhookPath), `path=${botConfig.webhookPath}`));
  checks.push(
    makeCheck(
      "bot.entry.visibility",
      true,
      "Bot 模式在“微信插件入口”通常不会显示为联系人；建议通过机器人会话入口或群聊触发。",
    ),
  );

  let aesKeyValid = false;
  if (botConfig.encodingAesKey) {
    try {
      decodeAesKey(botConfig.encodingAesKey);
      aesKeyValid = true;
      checks.push(makeCheck("config.bot.encodingAesKey.length", true, "decoded-bytes=32"));
    } catch (err) {
      checks.push(
        makeCheck("config.bot.encodingAesKey.length", false, String(err?.message || err)),
      );
    }
  } else {
    checks.push(makeCheck("config.bot.encodingAesKey.length", false, "missing"));
  }

  if (!botConfig.enabled || !botConfig.token || !botConfig.encodingAesKey || !aesKeyValid) {
    const report = {
      configPath,
      account: botConfig.accountId,
      endpoint,
      fromUser,
      content,
      checks,
      summary: summarize(checks),
    };
    return report;
  }

  try {
    const healthResponse = await fetchWithTimeout(endpoint, { method: "GET" }, Math.min(args.timeoutMs, 4000));
    const healthBody = await healthResponse.text();
    const healthy = healthResponse.status === 200 && healthBody.includes("wecom bot webhook");
    checks.push(
      makeCheck(
        "local.webhook.health",
        healthy,
        `status=${healthResponse.status} body=${healthBody.slice(0, 120)}`,
      ),
    );
  } catch (err) {
    checks.push(makeCheck("local.webhook.health", false, `probe failed: ${String(err?.message || err)}`));
  }

  const messagePayload = {
    msgid: `selfcheck_msg_${Date.now()}`,
    msgtype: "text",
    from: {
      userid: fromUser,
    },
    chattype: "single",
    text: {
      content,
    },
  };

  let streamId = "";
  try {
    const first = await postEncryptedPayload({
      endpoint,
      token: botConfig.token,
      aesKey: botConfig.encodingAesKey,
      payload: messagePayload,
      timeoutMs: args.timeoutMs,
    });
    checks.push(makeCheck("e2e.message.post", first.response.status === 200, `status=${first.response.status}`));
    if (first.response.status === 200) {
      const verified = verifyEncryptedCallbackResponse({
        token: botConfig.token,
        aesKey: botConfig.encodingAesKey,
        rawBody: first.rawBody,
      });
      const stream = verified.payload?.stream ?? {};
      streamId = String(stream.id ?? "").trim();
      const isStream = String(verified.payload?.msgtype ?? "").trim() === "stream";
      checks.push(
        makeCheck(
          "e2e.message.response.stream",
          isStream && Boolean(streamId),
          `msgtype=${verified.payload?.msgtype ?? "n/a"} streamId=${streamId || "missing"} finish=${String(stream.finish ?? "n/a")}`,
        ),
      );
    } else {
      checks.push(makeCheck("e2e.message.response.stream", false, `unexpected status=${first.response.status}`));
    }
  } catch (err) {
    checks.push(makeCheck("e2e.message.post", false, `request failed: ${String(err?.message || err)}`));
    checks.push(makeCheck("e2e.message.response.stream", false, "request failed"));
  }

  let finalPayload = null;
  if (streamId) {
    for (let i = 0; i < args.pollCount; i += 1) {
      await sleep(args.pollIntervalMs);
      try {
        const refreshPayload = {
          msgid: `selfcheck_refresh_${Date.now()}_${i}`,
          msgtype: "stream",
          stream: {
            id: streamId,
          },
        };
        const refreshResp = await postEncryptedPayload({
          endpoint,
          token: botConfig.token,
          aesKey: botConfig.encodingAesKey,
          payload: refreshPayload,
          timeoutMs: args.timeoutMs,
        });
        if (refreshResp.response.status !== 200) continue;
        const verified = verifyEncryptedCallbackResponse({
          token: botConfig.token,
          aesKey: botConfig.encodingAesKey,
          rawBody: refreshResp.rawBody,
        });
        const stream = verified.payload?.stream ?? {};
        if (String(stream.id ?? "").trim() !== streamId) continue;
        if (stream.finish === true) {
          finalPayload = verified.payload;
          break;
        }
      } catch {
        // Keep polling until budget is exhausted.
      }
    }
  }

  if (!streamId) {
    checks.push(makeCheck("e2e.stream.refresh", false, "streamId missing"));
  } else if (!finalPayload) {
    checks.push(
      makeCheck(
        "e2e.stream.refresh",
        false,
        `did not observe finish=true within ${args.pollCount} polls`,
      ),
    );
  } else {
    const contentText = String(finalPayload?.stream?.content ?? "");
    const expectedSessionLower = `会话ID：wecom-bot:${fromUser.toLowerCase()}`;
    const expectedSessionRaw = `会话ID：wecom-bot:${fromUser}`;
    const sessionMatched = contentText.includes(expectedSessionLower) || contentText.includes(expectedSessionRaw);
    checks.push(
      makeCheck(
        "e2e.stream.refresh",
        true,
        `finish=true contentBytes=${Buffer.byteLength(contentText, "utf8")}`,
      ),
    );
    checks.push(
      makeCheck(
        "e2e.stream.content",
        sessionMatched,
        sessionMatched
          ? `contains expected session marker (${expectedSessionRaw} / ${expectedSessionLower})`
          : `missing expected session marker (${expectedSessionRaw} / ${expectedSessionLower})`,
      ),
    );
  }

  return {
    configPath,
    account: botConfig.accountId,
    endpoint,
    fromUser,
    content,
    checks,
    summary: summarize(checks),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = path.resolve(expandHome(args.configPath));
  let config;
  try {
    const raw = await readFile(configPath, "utf8");
    config = JSON.parse(raw);
  } catch (err) {
    const report = {
      configPath,
      account: normalizeAccountId(args.account),
      endpoint: "",
      fromUser: args.fromUser || "",
      content: args.content || "",
      checks: [
        makeCheck("config.load", false, `failed to load ${configPath}: ${String(err?.message || err)}`),
      ],
    };
    report.summary = summarize(report.checks);
    reportAndExit(report, args.json);
    return;
  }

  const report = await runBotE2E({ config, args, configPath });
  report.checks.unshift(makeCheck("config.load", true, `loaded ${configPath}`));
  report.summary = summarize(report.checks);
  reportAndExit(report, args.json);
}

main().catch((err) => {
  console.error(`Bot selfcheck failed: ${String(err?.message || err)}`);
  process.exit(1);
});
