#!/usr/bin/env node

import { spawn } from "node:child_process";

function pickFirstEnv(...names) {
  for (const name of names) {
    const value = String(process.env[name] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function joinBaseUrl(baseUrl, path) {
  const safeBase = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  const safePath = String(path ?? "").trim();
  if (!safeBase || !safePath) return "";
  return `${safeBase}${safePath.startsWith("/") ? safePath : `/${safePath}`}`;
}

function parseArgs(argv) {
  const out = {
    scenario: "full-smoke",
    botUrl:
      pickFirstEnv("WECOM_E2E_BOT_URL") ||
      joinBaseUrl(pickFirstEnv("WECOM_E2E_BASE_URL"), pickFirstEnv("WECOM_E2E_BOT_PATH")) ||
      joinBaseUrl(pickFirstEnv("E2E_WECOM_BASE_URL"), pickFirstEnv("E2E_WECOM_WEBHOOK_PATH") || "/wecom/bot/callback"),
    agentUrl:
      pickFirstEnv("WECOM_E2E_AGENT_URL") ||
      joinBaseUrl(pickFirstEnv("WECOM_E2E_BASE_URL"), pickFirstEnv("WECOM_E2E_AGENT_PATH")) ||
      joinBaseUrl(pickFirstEnv("E2E_WECOM_BASE_URL"), pickFirstEnv("E2E_WECOM_AGENT_WEBHOOK_PATH") || "/wecom/callback"),
    configPath: pickFirstEnv("WECOM_E2E_CONFIG", "OPENCLAW_CONFIG_PATH"),
    account: "default",
    fromUser: pickFirstEnv("WECOM_E2E_FROM_USER", "E2E_WECOM_TEST_USER"),
    timeoutMs: Number(pickFirstEnv("WECOM_E2E_TIMEOUT_MS", "E2E_WECOM_STREAM_TIMEOUT_MS")) || 12000,
    pollCount: Number(pickFirstEnv("WECOM_E2E_POLL_COUNT")) || 15,
    pollIntervalMs: Number(pickFirstEnv("WECOM_E2E_POLL_INTERVAL_MS", "E2E_WECOM_POLL_INTERVAL_MS")) || 800,
    prepareBrowser: false,
    collectPdf: false,
    browserPrepareMode: pickFirstEnv("E2E_BROWSER_PREPARE_MODE"),
    browserRequireReady: pickFirstEnv("E2E_BROWSER_REQUIRE_READY") === "1",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--scenario" && next) {
      out.scenario = String(next).trim().toLowerCase();
      i += 1;
    } else if (arg === "--bot-url" && next) {
      out.botUrl = next;
      i += 1;
    } else if (arg === "--agent-url" && next) {
      out.agentUrl = next;
      i += 1;
    } else if (arg === "--config" && next) {
      out.configPath = next;
      i += 1;
    } else if (arg === "--account" && next) {
      out.account = next;
      i += 1;
    } else if (arg === "--from-user" && next) {
      out.fromUser = next;
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.timeoutMs = Math.floor(n);
      i += 1;
    } else if (arg === "--poll-count" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.pollCount = Math.floor(n);
      i += 1;
    } else if (arg === "--poll-interval-ms" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) out.pollIntervalMs = Math.floor(n);
      i += 1;
    } else if (arg === "--prepare-browser") {
      out.prepareBrowser = true;
    } else if (arg === "--collect-pdf") {
      out.collectPdf = true;
    } else if (arg === "--browser-prepare-mode" && next) {
      out.browserPrepareMode = String(next).trim().toLowerCase();
      i += 1;
    } else if (arg === "--browser-require-ready") {
      out.browserRequireReady = true;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const scenario = out.scenario;
  const valid = new Set(["bot-smoke", "agent-smoke", "full-smoke", "bot-queue"]);
  if (!valid.has(scenario)) {
    throw new Error(`Invalid --scenario, expected one of: ${Array.from(valid).join(" | ")}`);
  }
  if (out.browserPrepareMode && !["check", "install", "off"].includes(out.browserPrepareMode)) {
    throw new Error("Invalid --browser-prepare-mode, expected one of: check | install | off");
  }
  if ((scenario === "bot-smoke" || scenario === "full-smoke" || scenario === "bot-queue") && !String(out.botUrl).trim()) {
    throw new Error("Missing required argument: --bot-url <https://.../wecom/bot/callback>");
  }
  if ((scenario === "agent-smoke" || scenario === "full-smoke") && !String(out.agentUrl).trim()) {
    throw new Error("Missing required argument: --agent-url <https://.../wecom/callback>");
  }

  return out;
}

function printHelp() {
  console.log(`OpenClaw-Wechat scenario E2E

Usage:
  npm run wecom:e2e:scenario -- --scenario <bot-smoke|agent-smoke|full-smoke|bot-queue> [options]

Scenarios:
  bot-smoke    Run remote bot E2E once
  agent-smoke  Run remote agent E2E once
  full-smoke   Run remote all-in-one E2E (agent + bot + account selfcheck)
  bot-queue    Run bot E2E twice with same sender to validate queue/stream recovery

Options:
  --bot-url <url>          Bot callback URL (required for bot/full/bot-queue)
  --agent-url <url>        Agent callback URL (required for agent/full)
  --config <path>          Optional OpenClaw config path
  --account <id>           Agent account id (default: default)
  --from-user <userid>     Fixed sender id for scenario checks
  --timeout-ms <ms>        HTTP timeout (default: 12000)
  --poll-count <n>         Bot stream-refresh polls (default: 15)
  --poll-interval-ms <ms>  Bot poll interval (default: 800)
  --prepare-browser        Run remote browser sandbox prepare before E2E
  --collect-pdf            Collect browser-generated PDFs after E2E
  --browser-prepare-mode   check | install | off
  --browser-require-ready  Fail when browser sandbox is not ready
  -h, --help               Show help

Env shortcuts:
  WECOM_E2E_BOT_URL / WECOM_E2E_AGENT_URL / WECOM_E2E_BASE_URL + *_PATH
  WECOM_E2E_TIMEOUT_MS / WECOM_E2E_POLL_* / WECOM_E2E_FROM_USER
  Legacy: E2E_WECOM_BASE_URL / E2E_WECOM_WEBHOOK_PATH / E2E_WECOM_*
`);
}

async function runNodeScript(script, args = []) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

function buildRemoteE2eArgs({ mode, options, content }) {
  const args = [
    "--mode",
    mode,
    "--timeout-ms",
    String(options.timeoutMs),
    "--poll-count",
    String(options.pollCount),
    "--poll-interval-ms",
    String(options.pollIntervalMs),
    "--content",
    content,
    "--account",
    options.account,
  ];
  if (options.botUrl) args.push("--bot-url", options.botUrl);
  if (options.agentUrl) args.push("--agent-url", options.agentUrl);
  if (options.configPath) args.push("--config", options.configPath);
  if (options.fromUser) args.push("--from-user", options.fromUser);
  if (options.prepareBrowser) args.push("--prepare-browser");
  if (options.collectPdf) args.push("--collect-pdf");
  if (options.browserPrepareMode) args.push("--browser-prepare-mode", options.browserPrepareMode);
  if (options.browserRequireReady) args.push("--browser-require-ready");
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const steps = [];

  if (args.scenario === "bot-smoke") {
    steps.push({
      label: "Bot smoke E2E",
      script: "./scripts/wecom-remote-e2e.mjs",
      args: buildRemoteE2eArgs({ mode: "bot", options: args, content: "/status" }),
    });
  } else if (args.scenario === "agent-smoke") {
    steps.push({
      label: "Agent smoke E2E",
      script: "./scripts/wecom-remote-e2e.mjs",
      args: buildRemoteE2eArgs({ mode: "agent", options: args, content: "/status" }),
    });
  } else if (args.scenario === "full-smoke") {
    steps.push({
      label: "Full smoke E2E (agent+bot)",
      script: "./scripts/wecom-remote-e2e.mjs",
      args: buildRemoteE2eArgs({ mode: "all", options: args, content: "/status" }),
    });
  } else if (args.scenario === "bot-queue") {
    const queueUser = args.fromUser || `e2e-queue-${Date.now().toString(36).slice(-6)}`;
    const queueOptions = { ...args, fromUser: queueUser };
    steps.push({
      label: "Bot queue scenario: first message",
      script: "./scripts/wecom-remote-e2e.mjs",
      args: buildRemoteE2eArgs({ mode: "bot", options: queueOptions, content: "第一条队列消息 /status" }),
    });
    steps.push({
      label: "Bot queue scenario: second message",
      script: "./scripts/wecom-remote-e2e.mjs",
      args: buildRemoteE2eArgs({ mode: "bot", options: queueOptions, content: "第二条队列消息 /status" }),
    });
  }

  let index = 0;
  const total = steps.length;
  for (const step of steps) {
    index += 1;
    console.log(`[${index}/${total}] ${step.label}`);
    // eslint-disable-next-line no-await-in-loop
    await runNodeScript(step.script, step.args);
  }
  console.log(`Scenario completed: ${args.scenario}`);
}

main().catch((err) => {
  console.error(`Scenario E2E failed: ${String(err?.message || err)}`);
  process.exit(1);
});
