const WEBHOOK_SEND_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send";

function resolveTimeout(timeoutMs, fallback = 15000) {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function extractWebhookKey(rawUrl) {
  const value = String(rawUrl ?? "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return String(parsed.searchParams.get("key") ?? "").trim();
  } catch {
    return "";
  }
}

export function resolveWebhookBotSendUrl({ url, key } = {}) {
  const explicitUrl = String(url ?? "").trim();
  if (explicitUrl) return explicitUrl;
  const webhookKey = String(key ?? "").trim();
  if (!webhookKey) return "";
  return `${WEBHOOK_SEND_URL}?key=${encodeURIComponent(webhookKey)}`;
}

export async function postWebhookJson({
  url,
  body,
  timeoutMs = 15000,
  dispatcher,
  fetchImpl = fetch,
} = {}) {
  const requestUrl = String(url ?? "").trim();
  if (!requestUrl) throw new Error("webhook url is required");
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(resolveTimeout(timeoutMs)),
  };
  if (dispatcher) {
    options.dispatcher = dispatcher;
  }
  const response = await fetchImpl(requestUrl, options);
  const responseText = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(responseText || "{}");
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new Error(`webhook request failed: ${response.status} ${response.statusText}`.trim());
  }
  const errcode = Number(parsed?.errcode ?? NaN);
  if (!Number.isFinite(errcode) || errcode !== 0) {
    throw new Error(`webhook rejected: errcode=${parsed?.errcode ?? "unknown"} errmsg=${parsed?.errmsg ?? ""}`.trim());
  }
  return parsed;
}

export function buildWebhookUploadContext({ url, key } = {}) {
  const sendUrl = resolveWebhookBotSendUrl({ url, key });
  if (!sendUrl) throw new Error("missing webhook bot url/key");
  const webhookKey = extractWebhookKey(sendUrl);
  if (!webhookKey) throw new Error("invalid webhook bot url: missing key");
  return {
    sendUrl,
    webhookKey,
  };
}

export function resolveWebhookTimeout(timeoutMs, fallback = 15000) {
  return resolveTimeout(timeoutMs, fallback);
}
