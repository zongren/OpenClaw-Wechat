export function normalizeToken(value) {
  return String(value ?? "").trim();
}

export function normalizeLowerToken(value) {
  return normalizeToken(value).toLowerCase();
}

export function dedupeUrlList(urls) {
  const dedupe = new Set();
  const out = [];
  for (const rawUrl of urls) {
    const url = normalizeToken(rawUrl);
    if (!url || dedupe.has(url)) continue;
    dedupe.add(url);
    out.push(url);
  }
  return out;
}

export function collectWecomBotImageUrls(imageLike) {
  return dedupeUrlList([
    imageLike?.url,
    imageLike?.pic_url,
    imageLike?.picUrl,
    imageLike?.image_url,
    imageLike?.imageUrl,
  ]);
}

export function normalizeWecomBotOutboundMediaUrls(payload = {}) {
  return dedupeUrlList([
    payload?.mediaUrl,
    ...(Array.isArray(payload?.mediaUrls) ? payload.mediaUrls : []),
  ]);
}

export function normalizeQuotePayload(quotePayload) {
  if (!quotePayload || typeof quotePayload !== "object") return null;
  const msgType = normalizeLowerToken(quotePayload.msgtype);
  if (!msgType) return null;
  let content = "";
  if (msgType === "text") {
    content = normalizeToken(quotePayload?.text?.content);
  } else if (msgType === "image") {
    content = normalizeToken(quotePayload?.image?.url) || "[图片]";
  } else if (msgType === "file") {
    content = normalizeToken(quotePayload?.file?.name || quotePayload?.file?.filename || quotePayload?.file?.url);
  } else if (msgType === "link") {
    content = normalizeToken(quotePayload?.link?.title || quotePayload?.link?.url);
  }
  if (!content) return null;
  return {
    msgType,
    content,
  };
}
