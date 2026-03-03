function normalizeContentType(contentType) {
  return String(contentType ?? "")
    .trim()
    .toLowerCase()
    .split(";")[0]
    .trim();
}

export function buildMediaFetchErrorMessage({ url, status, statusText, contentType, bodyPreview } = {}) {
  const parts = ["download media failed"];
  const code = Number(status);
  if (Number.isFinite(code) && code > 0) {
    parts.push(String(code));
  }
  const statusDetail = String(statusText ?? "").trim();
  if (statusDetail) parts.push(statusDetail);
  const normalizedType = normalizeContentType(contentType);
  if (normalizedType) parts.push(`content-type=${normalizedType}`);
  const target = String(url ?? "").trim();
  if (target) parts.push(`url=${target}`);
  const preview = String(bodyPreview ?? "").trim();
  if (preview) parts.push(`body=${preview.slice(0, 200)}`);
  return parts.join(" | ");
}
