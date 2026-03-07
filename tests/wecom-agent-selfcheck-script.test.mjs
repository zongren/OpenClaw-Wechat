import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function runAgentSelfcheck(args = []) {
  const scriptPath = path.resolve(process.cwd(), "scripts/wecom-agent-selfcheck.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({
        code: Number.isInteger(code) ? code : -1,
        stdout,
        stderr,
      });
    });
  });
}

function validAesKey(fill = 7) {
  return Buffer.alloc(32, fill).toString("base64").replace(/=+$/g, "");
}

function decodeAesKey(aesKey) {
  const keyBase64 = String(aesKey ?? "").endsWith("=") ? String(aesKey) : `${String(aesKey)}=`;
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error(`invalid key length=${key.length}`);
  return key;
}

function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) return buf;
  return buf.subarray(0, buf.length - pad);
}

function decryptWecomCipher({ aesKey, cipherTextBase64 }) {
  const key = decodeAesKey(aesKey);
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(Buffer.from(cipherTextBase64, "base64")), decipher.final()]);
  const unpadded = pkcs7Unpad(plain);
  const msgLen = unpadded.readUInt32BE(16);
  const msgStart = 20;
  const msgEnd = msgStart + msgLen;
  return unpadded.subarray(msgStart, msgEnd).toString("utf8");
}

function buildAgentBlock(agentId, overrides = {}) {
  return {
    corpId: `ww-${agentId}`,
    corpSecret: `secret-${agentId}`,
    agentId,
    callbackToken: `token-${agentId}`,
    callbackAesKey: validAesKey(Number(agentId) % 255 || 1),
    ...overrides,
  };
}

function buildLegacyAgentWebhookPath(accountId) {
  return accountId === "default" ? "/webhooks/app" : `/webhooks/app/${accountId}`;
}

test("wecom-agent-selfcheck supports --all-accounts discovery", async (t) => {
  const accountsByPath = new Map();
  const registerAccount = (accountId, webhookPath, aesKey) => {
    accountsByPath.set(webhookPath, { accountId, aesKey });
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const account = accountsByPath.get(url.pathname);
    if (!account) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    const echostr = String(url.searchParams.get("echostr") ?? "");
    if (req.method === "GET" && !echostr) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("wecom webhook ok");
      return;
    }

    if (req.method === "GET" && echostr) {
      const plain = decryptWecomCipher({
        aesKey: account.aesKey,
        cipherTextBase64: echostr,
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(plain);
      return;
    }

    if (req.method === "POST") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("success");
      return;
    }

    res.statusCode = 405;
    res.end("method not allowed");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.ok(port > 0);

  const defaultAgent = buildAgentBlock(1001, { webhookPath: "/wecom/callback" });
  const numberAgent = buildAgentBlock(1002, { webhookPath: "/wecom/number/callback" });
  const legacyAgent = buildAgentBlock(1003, { webhookPath: "/wecom/legacy/callback" });
  registerAccount("default", defaultAgent.webhookPath, defaultAgent.callbackAesKey);
  registerAccount("number", numberAgent.webhookPath, numberAgent.callbackAesKey);
  registerAccount("legacy", legacyAgent.webhookPath, legacyAgent.callbackAesKey);
  registerAccount("default", buildLegacyAgentWebhookPath("default"), defaultAgent.callbackAesKey);
  registerAccount("number", buildLegacyAgentWebhookPath("number"), numberAgent.callbackAesKey);
  registerAccount("legacy", buildLegacyAgentWebhookPath("legacy"), legacyAgent.callbackAesKey);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-agent-selfcheck-"));
  const configPath = path.join(tempDir, "openclaw.json");
  const config = {
    gateway: { port },
    channels: {
      wecom: {
        agent: defaultAgent,
        accounts: {
          number: {
            agent: numberAgent,
          },
        },
        legacy: legacyAgent,
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const result = await runAgentSelfcheck([
    "--config",
    configPath,
    "--all-accounts",
    "--json",
  ]);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report?.args?.allAccounts, true);
  assert.equal(report?.summary?.accountsTotal, 3);
  const accountIds = new Set((report?.accounts ?? []).map((item) => String(item?.accountId ?? "")));
  assert.equal(accountIds.has("default"), true);
  assert.equal(accountIds.has("number"), true);
  assert.equal(accountIds.has("legacy"), true);
  for (const accountReport of report.accounts) {
    const verifyCheck = accountReport?.checks?.find((item) => item?.name === "e2e.url.verify");
    const postCheck = accountReport?.checks?.find((item) => item?.name === "e2e.message.post");
    assert.equal(verifyCheck?.ok, true, accountReport?.accountId);
    assert.equal(postCheck?.ok, true, accountReport?.accountId);
  }
});

test("wecom-agent-selfcheck rejects --url with --all-accounts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wecom-agent-selfcheck-"));
  const configPath = path.join(tempDir, "openclaw.json");
  await writeFile(configPath, JSON.stringify({ channels: { wecom: {} } }, null, 2), "utf8");

  const result = await runAgentSelfcheck([
    "--config",
    configPath,
    "--all-accounts",
    "--url",
    "http://127.0.0.1:8885/wecom/callback",
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot be used with --all-accounts/i);
});
