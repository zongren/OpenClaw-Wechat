#!/usr/bin/env node

import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { spawnSync } from "node:child_process";

const DEFAULT_LONG_CONNECTION_URL = "wss://openws.work.weixin.qq.com";
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    url: "",
    proxyUrl: "",
    botId: "",
    secret: "",
    timeoutMs: 10000,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = String(argv[index] ?? "");
    if (!current.startsWith("--")) continue;
    const next = argv[index + 1];
    if (current === "--config" && next) {
      options.configPath = String(next);
      index += 1;
      continue;
    }
    if (current === "--url" && next) {
      options.url = String(next);
      index += 1;
      continue;
    }
    if (current === "--proxy-url" && next) {
      options.proxyUrl = String(next);
      index += 1;
      continue;
    }
    if (current === "--bot-id" && next) {
      options.botId = String(next);
      index += 1;
      continue;
    }
    if (current === "--secret" && next) {
      options.secret = String(next);
      index += 1;
      continue;
    }
    if (current === "--timeout-ms" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.timeoutMs = parsed;
      }
      index += 1;
      continue;
    }
    if (current === "--json") {
      options.json = true;
    }
  }
  return options;
}

async function readConfig(configPath) {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolveProbeConfig(config, cliOptions) {
  const channelConfig = config?.channels?.wecom ?? {};
  const envVars = config?.env?.vars ?? {};
  const botConfig = channelConfig?.bot && typeof channelConfig.bot === "object" ? channelConfig.bot : {};
  const longConnection =
    botConfig?.longConnection && typeof botConfig.longConnection === "object" ? botConfig.longConnection : {};
  const proxyUrl = String(
    cliOptions.proxyUrl ||
      botConfig?.outboundProxy ||
      botConfig?.proxyUrl ||
      botConfig?.proxy ||
      envVars?.WECOM_BOT_PROXY ||
      envVars?.WECOM_PROXY ||
      process.env.WECOM_BOT_PROXY ||
      process.env.WECOM_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      "",
  ).trim();
  const url = String(cliOptions.url || longConnection?.url || DEFAULT_LONG_CONNECTION_URL).trim() || DEFAULT_LONG_CONNECTION_URL;
  return {
    url,
    proxyUrl,
    botId: String(cliOptions.botId || longConnection?.botId || "").trim(),
    secret: String(cliOptions.secret || longConnection?.secret || "").trim(),
  };
}

function summarizeHeaders(headerBlock = "") {
  const lines = String(headerBlock ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(0, 12);
}

function buildUpgradeRequest(url) {
  const parsed = new URL(url);
  const pathWithQuery = `${parsed.pathname || "/"}${parsed.search || ""}`;
  const hostHeader = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || (parsed.protocol === "wss:" ? 443 : 80),
    path: pathWithQuery,
    secure: parsed.protocol === "wss:",
    requestText: [
      `GET ${pathWithQuery} HTTP/1.1`,
      `Host: ${hostHeader}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Origin: https://${parsed.hostname}`,
      "User-Agent: OpenClaw-Wechat-Probe/1.0",
      "",
      "",
    ].join("\r\n"),
  };
}

function finishProbe(resolve, result) {
  resolve({
    ok: false,
    ...result,
  });
}

async function rawUpgradeDirect(url, timeoutMs) {
  const request = buildUpgradeRequest(url);
  return new Promise((resolve) => {
    let settled = false;
    const socket = request.secure
      ? tls.connect({
          host: request.host,
          port: request.port,
          servername: request.host,
          ALPNProtocols: ["http/1.1"],
        })
      : net.connect(request.port, request.host);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      finishProbe(resolve, { mode: "raw-direct", reason: "timeout" });
    }, timeoutMs);
    let received = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(request.requestText);
    });
    socket.on("secureConnect", () => {
      socket.write(request.requestText);
    });
    socket.on("data", (chunk) => {
      if (settled) return;
      received += chunk;
      if (!received.includes("\r\n\r\n")) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      const [headerBlock, body = ""] = received.split("\r\n\r\n");
      const statusLine = String(headerBlock.split(/\r?\n/)[0] ?? "").trim();
      resolve({
        ok: statusLine.includes("101"),
        mode: "raw-direct",
        statusLine,
        headers: summarizeHeaders(headerBlock),
        bodyPrefix: body.slice(0, 400),
      });
    });
    socket.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finishProbe(resolve, { mode: "raw-direct", reason: String(error?.message || error) });
    });
  });
}

async function rawUpgradeViaHttpProxy(url, proxyUrl, timeoutMs) {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== "http:") {
    return {
      ok: false,
      mode: "raw-proxy",
      reason: `unsupported proxy protocol: ${proxy.protocol}`,
    };
  }
  const request = buildUpgradeRequest(url);
  return new Promise((resolve) => {
    let settled = false;
    const proxySocket = net.connect(Number(proxy.port) || 80, proxy.hostname);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proxySocket.destroy();
      finishProbe(resolve, { mode: "raw-proxy", reason: "timeout" });
    }, timeoutMs);
    let buffer = "";
    proxySocket.setEncoding("utf8");
    proxySocket.on("connect", () => {
      const auth =
        proxy.username || proxy.password
          ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
          : "";
      proxySocket.write(
        `CONNECT ${request.host}:${request.port} HTTP/1.1\r\nHost: ${request.host}:${request.port}\r\n${auth}\r\n`,
      );
    });
    proxySocket.on("data", (chunk) => {
      if (settled) return;
      buffer += chunk;
      if (!buffer.includes("\r\n\r\n")) return;
      const [headerBlock] = buffer.split("\r\n\r\n");
      const statusLine = String(headerBlock.split(/\r?\n/)[0] ?? "").trim();
      if (!statusLine.includes("200")) {
        settled = true;
        clearTimeout(timer);
        proxySocket.end();
        resolve({
          ok: false,
          mode: "raw-proxy",
          statusLine,
          headers: summarizeHeaders(headerBlock),
          bodyPrefix: buffer.slice(buffer.indexOf("\r\n\r\n") + 4, buffer.indexOf("\r\n\r\n") + 404),
        });
        return;
      }
      proxySocket.removeAllListeners("data");
      const tunnel = tls.connect({
        socket: proxySocket,
        servername: request.host,
        ALPNProtocols: ["http/1.1"],
      });
      let received = "";
      tunnel.setEncoding("utf8");
      tunnel.on("secureConnect", () => {
        tunnel.write(request.requestText);
      });
      tunnel.on("data", (data) => {
        if (settled) return;
        received += data;
        if (!received.includes("\r\n\r\n")) return;
        settled = true;
        clearTimeout(timer);
        tunnel.end();
        const [upgradeHeaders, body = ""] = received.split("\r\n\r\n");
        const upgradeStatus = String(upgradeHeaders.split(/\r?\n/)[0] ?? "").trim();
        resolve({
          ok: upgradeStatus.includes("101"),
          mode: "raw-proxy",
          statusLine: upgradeStatus,
          headers: summarizeHeaders(upgradeHeaders),
          bodyPrefix: body.slice(0, 400),
        });
      });
      tunnel.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finishProbe(resolve, { mode: "raw-proxy", reason: String(error?.message || error) });
      });
    });
    proxySocket.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finishProbe(resolve, { mode: "raw-proxy", reason: String(error?.message || error) });
    });
  });
}

function buildWebSocketChildCode(timeoutMs) {
  return `
import WebSocket from "ws";
const url = process.argv[1];
const timeoutMs = Number(process.argv[2]) || 10000;
const botId = String(process.argv[3] || "");
const secret = String(process.argv[4] || "");
let openSeen = false;
let errorText = "";
let authenticated = false;
let pingAcked = false;
const subscribeReqId = \`aibot_subscribe_\${Date.now()}\`;
const pingReqId = \`ping_\${Date.now()}\`;
const ws = new WebSocket(url);
const done = (payload) => {
  console.log(JSON.stringify(payload));
  process.exit(0);
};
ws.on("open", () => {
  openSeen = true;
  if (!botId || !secret) {
    done({ ok: true, mode: "websocket", event: "open", authenticated: false, pingAcked: false });
    return;
  }
  ws.send(JSON.stringify({
    cmd: "aibot_subscribe",
    headers: { req_id: subscribeReqId },
    body: { bot_id: botId, secret },
  }));
});
ws.on("message", (data) => {
  try {
    const payload = JSON.parse(data.toString());
    const reqId = String(payload?.headers?.req_id || "");
    if (reqId === subscribeReqId) {
      if (Number(payload?.errcode ?? -1) !== 0) {
        done({
          ok: false,
          mode: "websocket",
          event: "auth-rejected",
          openSeen,
          authenticated: false,
          pingAcked: false,
          errcode: Number(payload?.errcode ?? -1),
          errmsg: String(payload?.errmsg ?? ""),
        });
        return;
      }
      authenticated = true;
      ws.send(JSON.stringify({
        cmd: "ping",
        headers: { req_id: pingReqId },
      }));
      return;
    }
    if (reqId === pingReqId) {
      if (Number(payload?.errcode ?? -1) === 0) {
        pingAcked = true;
        done({
          ok: true,
          mode: "websocket",
          event: "authenticated",
          openSeen,
          authenticated,
          pingAcked,
        });
        return;
      }
      done({
        ok: false,
        mode: "websocket",
        event: "ping-rejected",
        openSeen,
        authenticated,
        pingAcked: false,
        errcode: Number(payload?.errcode ?? -1),
        errmsg: String(payload?.errmsg ?? ""),
      });
      return;
    }
  } catch (error) {
    errorText = String(error?.stack || error?.message || error || "parse error");
  }
});
ws.on("error", (event) => {
  const err = event?.error ?? event;
  errorText = String(err?.stack || err?.message || err || "error");
});
ws.on("close", (code, reason) => {
  done({
    ok: false,
    mode: "websocket",
    event: "close",
    openSeen,
    authenticated,
    pingAcked,
    closeCode: Number(code ?? 0),
    closeReason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason ?? ""),
    error: errorText,
  });
});
setTimeout(() => {
  done({
    ok: false,
    mode: "websocket",
    event: "timeout",
    openSeen,
    authenticated,
    pingAcked,
    error: errorText,
  });
}, timeoutMs);
`;
}

function runWebSocketProbe(url, timeoutMs, proxyUrl = "") {
  const env = {
    ...process.env,
    NODE_USE_ENV_PROXY: proxyUrl ? "1" : "0",
  };
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "WECOM_PROXY",
    "WECOM_BOT_PROXY",
  ]) {
    delete env[key];
  }
  if (proxyUrl) {
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.ALL_PROXY = proxyUrl;
    env.WECOM_PROXY = proxyUrl;
  }
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      buildWebSocketChildCode(timeoutMs),
      url,
      String(timeoutMs),
      String(process.env.WECOM_LONGCONN_PROBE_BOT_ID || ""),
      String(process.env.WECOM_LONGCONN_PROBE_SECRET || ""),
    ],
    {
      env,
      encoding: "utf8",
      timeout: timeoutMs + 2000,
    },
  );
  if (child.error) {
    return {
      ok: false,
      mode: proxyUrl ? "websocket-proxy" : "websocket-direct",
      reason: String(child.error?.message || child.error),
    };
  }
  const stdout = String(child.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
  if (!stdout) {
    return {
      ok: false,
      mode: proxyUrl ? "websocket-proxy" : "websocket-direct",
      reason: String(child.stderr ?? "").trim() || `exit ${child.status ?? -1}`,
    };
  }
  try {
    const parsed = JSON.parse(stdout);
    return {
      ...parsed,
      mode: proxyUrl ? "websocket-proxy" : "websocket-direct",
    };
  } catch {
    return {
      ok: false,
      mode: proxyUrl ? "websocket-proxy" : "websocket-direct",
      reason: stdout,
    };
  }
}

function buildDiagnosis(results) {
  const rawDirect404 = String(results?.rawDirect?.statusLine ?? "").includes("404");
  const rawProxy404 = String(results?.rawProxy?.statusLine ?? "").includes("404");
  const wsDirect1006 = Number(results?.websocketDirect?.closeCode ?? 0) === 1006;
  const wsProxy1006 = Number(results?.websocketProxy?.closeCode ?? 0) === 1006;
  const authOk = results?.websocketDirect?.authenticated === true || results?.websocketProxy?.authenticated === true;
  const pingOk = results?.websocketDirect?.pingAcked === true || results?.websocketProxy?.pingAcked === true;
  if (authOk && pingOk) {
    return {
      code: "ok",
      summary: "长连接已完成握手、鉴权和心跳确认，可以用于真实 Bot 收发链路测试。",
      likelyRootCause: "无阻塞问题。",
      suggestions: ["直接在企业微信里给机器人发消息，观察网关日志中的 inbound 与 reply。"],
    };
  }
  if (rawDirect404 && (!results.rawProxy || rawProxy404 || results.rawProxy.reason)) {
    return {
      code: "endpoint-unavailable",
      summary:
        "官方文档地址在握手阶段直接返回 404，失败发生在 aibot_subscribe 之前，不是 BotID/Secret 错误。",
      likelyRootCause:
        "长连接入口当前对这台机器/当前租户并未真正开放，或官方文档地址与实际可用入口仍不一致。",
      suggestions: [
        "先保留 webhook Bot 作为生产链路，不要切长连接为唯一入口。",
        "在企业微信后台再次确认机器人确实切到长连接模式，且当前 BotID/Secret 是长连接专用凭证。",
        "如果后台已确认无误，向企业微信侧确认当前租户是否在长连接灰度/白名单范围内。",
      ],
    };
  }
  if (results.rawDirect?.ok && results.rawProxy && !results.rawProxy.ok) {
    return {
      code: "proxy-blocked",
      summary: "直连握手可用，但代理链路握手失败。",
      likelyRootCause: "当前代理不支持或拦截了 WebSocket Upgrade。",
      suggestions: ["为长连接禁用 bot 代理，或更换支持 WebSocket CONNECT 的正向代理。"],
    };
  }
  if (!results.rawDirect?.ok && results.rawProxy?.ok) {
    return {
      code: "direct-network-blocked",
      summary: "直连握手失败，但通过代理可以建立握手。",
      likelyRootCause: "本机到企业微信长连接入口的直连网络被限制。",
      suggestions: ["保留代理，检查本机出网策略、防火墙和 DNS。"],
    };
  }
  if (wsDirect1006 || wsProxy1006) {
    return {
      code: "websocket-handshake-failed",
      summary: "WebSocket 客户端在 open 事件之前就以 1006 关闭。",
      likelyRootCause: "HTTP Upgrade 没有拿到 101，或服务端在握手后立即中止连接。",
      suggestions: ["结合 raw-direct/raw-proxy 的状态码继续排查。"],
    };
  }
  return {
    code: "unknown",
    summary: "探针没有发现明确单点根因，需要结合平台侧配置继续排查。",
    likelyRootCause: "可能是平台配置或协议细节问题。",
    suggestions: ["保留本次探针输出，与企业微信平台侧支持一起核对。"],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await readConfig(options.configPath);
  const resolved = resolveProbeConfig(config, options);
  process.env.WECOM_LONGCONN_PROBE_BOT_ID = resolved.botId;
  process.env.WECOM_LONGCONN_PROBE_SECRET = resolved.secret;
  const results = {
    configPath: options.configPath,
    url: resolved.url,
    proxyUrl: resolved.proxyUrl || "",
    botIdConfigured: Boolean(resolved.botId),
    secretConfigured: Boolean(resolved.secret),
    rawDirect: await rawUpgradeDirect(resolved.url, options.timeoutMs),
    rawProxy: resolved.proxyUrl ? await rawUpgradeViaHttpProxy(resolved.url, resolved.proxyUrl, options.timeoutMs) : null,
    websocketDirect: runWebSocketProbe(resolved.url, options.timeoutMs, ""),
    websocketProxy: resolved.proxyUrl ? runWebSocketProbe(resolved.url, options.timeoutMs, resolved.proxyUrl) : null,
  };
  results.diagnosis = buildDiagnosis(results);
  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  console.log(`WeCom Bot long connection probe`);
  console.log(`Config: ${results.configPath}`);
  console.log(`URL: ${results.url}`);
  console.log(`Proxy: ${results.proxyUrl || "direct"}`);
  console.log("");
  for (const key of ["rawDirect", "rawProxy", "websocketDirect", "websocketProxy"]) {
    const item = results[key];
    if (!item) continue;
    console.log(`[${key}] ${item.ok ? "OK" : "FAIL"}`);
    if (item.statusLine) console.log(`  status: ${item.statusLine}`);
    if (item.reason) console.log(`  reason: ${item.reason}`);
    if (item.closeCode) console.log(`  close: ${item.closeCode} ${item.closeReason || ""}`.trimEnd());
    if (item.error) console.log(`  error: ${item.error}`);
    if (Array.isArray(item.headers) && item.headers.length > 0) {
      console.log(`  headers: ${item.headers.join(" | ")}`);
    }
  }
  console.log("");
  console.log(`Diagnosis: ${results.diagnosis.code}`);
  console.log(`Summary: ${results.diagnosis.summary}`);
  console.log(`Likely root cause: ${results.diagnosis.likelyRootCause}`);
  for (const suggestion of results.diagnosis.suggestions) {
    console.log(`- ${suggestion}`);
  }
}

await main();
