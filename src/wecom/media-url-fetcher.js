import { readFile } from "node:fs/promises";
import { guessContentTypeByPath, resolveLocalMediaPath } from "./media-url-content.js";

export function createWecomMediaFetcher({ fetchWithRetry, buildMediaFetchErrorMessage, pluginVersion = "" } = {}) {
  if (typeof fetchWithRetry !== "function") {
    throw new Error("createWecomMediaFetcher: fetchWithRetry is required");
  }
  if (typeof buildMediaFetchErrorMessage !== "function") {
    throw new Error("createWecomMediaFetcher: buildMediaFetchErrorMessage is required");
  }

  async function fetchMediaFromUrl(url, { proxyUrl, logger, forceProxy = false, maxBytes = 10 * 1024 * 1024 } = {}) {
    const localPath = resolveLocalMediaPath(url);
    if (localPath) {
      const buffer = await readFile(localPath);
      if (buffer.length > maxBytes) {
        throw new Error(`Media too large (${buffer.length} bytes > ${maxBytes} bytes)`);
      }
      const contentType = guessContentTypeByPath(localPath);
      logger?.info?.(`wechat_work: loaded local media ${localPath} (${buffer.length} bytes)`);
      return {
        buffer,
        contentType,
        contentDisposition: "",
        finalUrl: localPath,
        status: 200,
        statusText: "OK",
        source: "local",
      };
    }

    const res = await fetchWithRetry(
      url,
      {
        headers: {
          "User-Agent": `OpenClaw-Wechat/${pluginVersion}`,
          Accept: "*/*",
        },
        forceProxy,
      },
      3,
      1000,
      { proxyUrl, logger },
    );
    if (!res.ok) {
      const contentType = res.headers.get("content-type") || "";
      let bodyPreview = "";
      if (/application\/json|^text\/|xml|javascript/i.test(contentType)) {
        bodyPreview = String(await res.text().catch(() => ""))
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
      }
      throw new Error(
        buildMediaFetchErrorMessage({
          url: res.url || url,
          status: res.status,
          statusText: res.statusText,
          contentType,
          bodyPreview,
        }),
      );
    }
    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 0 && contentLength > maxBytes) {
      throw new Error(`Media too large (${contentLength} bytes > ${maxBytes} bytes)`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`Media too large (${buffer.length} bytes > ${maxBytes} bytes)`);
    }
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    return {
      buffer,
      contentType,
      contentDisposition: res.headers.get("content-disposition") || "",
      finalUrl: res.url || url,
      status: res.status,
      statusText: res.statusText || "",
      source: "remote",
    };
  }

  return {
    fetchMediaFromUrl,
  };
}
