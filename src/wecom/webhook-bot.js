import crypto from "node:crypto";
import {
  buildWebhookUploadContext,
  postWebhookJson,
  resolveWebhookBotSendUrl,
  resolveWebhookTimeout,
} from "./webhook-bot-http.js";

const WEBHOOK_UPLOAD_URL = "https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media";

export { resolveWebhookBotSendUrl };

export async function webhookSendText({
  url,
  key,
  content,
  mentionedList,
  mentionedMobileList,
  timeoutMs = 15000,
  dispatcher,
  fetchImpl = fetch,
} = {}) {
  const sendUrl = resolveWebhookBotSendUrl({ url, key });
  if (!sendUrl) throw new Error("missing webhook bot url/key");
  const body = {
    msgtype: "text",
    text: {
      content: String(content ?? ""),
      ...(Array.isArray(mentionedList) && mentionedList.length > 0 ? { mentioned_list: mentionedList } : {}),
      ...(Array.isArray(mentionedMobileList) && mentionedMobileList.length > 0
        ? { mentioned_mobile_list: mentionedMobileList }
        : {}),
    },
  };
  return postWebhookJson({
    url: sendUrl,
    body,
    timeoutMs,
    dispatcher,
    fetchImpl,
  });
}

export async function webhookSendMarkdown({
  url,
  key,
  content,
  timeoutMs = 15000,
  dispatcher,
  fetchImpl = fetch,
} = {}) {
  const sendUrl = resolveWebhookBotSendUrl({ url, key });
  if (!sendUrl) throw new Error("missing webhook bot url/key");
  const body = {
    msgtype: "markdown",
    markdown: {
      content: String(content ?? ""),
    },
  };
  return postWebhookJson({
    url: sendUrl,
    body,
    timeoutMs,
    dispatcher,
    fetchImpl,
  });
}

export async function webhookSendImage({
  url,
  key,
  base64,
  md5,
  timeoutMs = 15000,
  dispatcher,
  fetchImpl = fetch,
} = {}) {
  const sendUrl = resolveWebhookBotSendUrl({ url, key });
  if (!sendUrl) throw new Error("missing webhook bot url/key");
  const body = {
    msgtype: "image",
    image: {
      base64: String(base64 ?? ""),
      md5: String(md5 ?? ""),
    },
  };
  return postWebhookJson({
    url: sendUrl,
    body,
    timeoutMs,
    dispatcher,
    fetchImpl,
  });
}

export async function webhookUploadFile({
  url,
  key,
  buffer,
  filename = "file.bin",
  timeoutMs = 15000,
  dispatcher,
  fetchImpl = fetch,
} = {}) {
  const { webhookKey } = buildWebhookUploadContext({ url, key });
  const fileBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? "");
  const boundary = `----OpenClawWebhookBoundary${crypto.randomBytes(12).toString("hex")}`;
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media"; filename="${filename}"; filelength=${fileBuffer.length}\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const multipartBody = Buffer.concat([header, fileBuffer, footer]);
  const uploadUrl = `${WEBHOOK_UPLOAD_URL}?key=${encodeURIComponent(webhookKey)}&type=file`;
  const options = {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(multipartBody.length),
    },
    body: multipartBody,
    signal: AbortSignal.timeout(resolveWebhookTimeout(timeoutMs)),
  };
  if (dispatcher) {
    options.dispatcher = dispatcher;
  }
  const response = await fetchImpl(uploadUrl, options);
  const responseText = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(responseText || "{}");
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new Error(`webhook upload failed: ${response.status} ${response.statusText}`.trim());
  }
  if (!parsed?.media_id) {
    throw new Error(`webhook upload rejected: errcode=${parsed?.errcode ?? "unknown"} errmsg=${parsed?.errmsg ?? ""}`);
  }
  return String(parsed.media_id);
}

export async function webhookSendFile({
  url,
  key,
  mediaId,
  timeoutMs = 15000,
  dispatcher,
  fetchImpl = fetch,
} = {}) {
  const sendUrl = resolveWebhookBotSendUrl({ url, key });
  if (!sendUrl) throw new Error("missing webhook bot url/key");
  const body = {
    msgtype: "file",
    file: {
      media_id: String(mediaId ?? ""),
    },
  };
  return postWebhookJson({
    url: sendUrl,
    body,
    timeoutMs,
    dispatcher,
    fetchImpl,
  });
}

export async function webhookSendFileBuffer({
  url,
  key,
  buffer,
  filename = "file.bin",
  timeoutMs = 15000,
  dispatcher,
  fetchImpl = fetch,
} = {}) {
  const mediaId = await webhookUploadFile({
    url,
    key,
    buffer,
    filename,
    timeoutMs,
    dispatcher,
    fetchImpl,
  });
  return webhookSendFile({
    url,
    key,
    mediaId,
    timeoutMs,
    dispatcher,
    fetchImpl,
  });
}
