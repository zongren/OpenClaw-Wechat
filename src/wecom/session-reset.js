import { access, readFile, rename, writeFile } from "node:fs/promises";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeToken(value) {
  return normalizeText(value).toLowerCase();
}

function resolveAgentIdFromSessionKey(sessionKey, fallback = "main") {
  const match = /^agent:([^:]+):/i.exec(normalizeText(sessionKey));
  const agentId = normalizeText(match?.[1]);
  return agentId || normalizeText(fallback) || "main";
}

function resolveStoreEntryKey(store, sessionKey) {
  if (!store || typeof store !== "object") return "";
  const directKey = normalizeText(sessionKey);
  if (directKey && Object.prototype.hasOwnProperty.call(store, directKey)) return directKey;
  const normalizedKey = normalizeToken(sessionKey);
  if (!normalizedKey) return "";
  return Object.keys(store).find((key) => normalizeToken(key) === normalizedKey) || "";
}

async function readJsonObject(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

async function persistJsonObject(filePath, payload) {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(filePath, serialized, "utf8");
}

async function archiveTranscriptFile(sessionFile, dateNow = Date.now) {
  const normalizedPath = normalizeText(sessionFile);
  if (!normalizedPath) return { archived: false, archivedPath: "" };
  try {
    await access(normalizedPath);
  } catch (err) {
    if (err?.code === "ENOENT") return { archived: false, archivedPath: "" };
    throw err;
  }
  const archivedPath = `${normalizedPath}.reset-${dateNow()}`;
  await rename(normalizedPath, archivedPath);
  return { archived: true, archivedPath };
}

export function createWecomSessionResetter({ dateNow = Date.now } = {}) {
  async function clearSessionStoreEntry({ storePath, sessionKey, logger } = {}) {
    const normalizedStorePath = normalizeText(storePath);
    const normalizedSessionKey = normalizeText(sessionKey);
    if (!normalizedStorePath || !normalizedSessionKey) {
      return { cleared: false, transcriptArchived: false, archivedTranscriptPath: "" };
    }

    const store = await readJsonObject(normalizedStorePath);
    const entryKey = resolveStoreEntryKey(store, normalizedSessionKey);
    if (!entryKey) {
      return { cleared: false, transcriptArchived: false, archivedTranscriptPath: "" };
    }

    const entry = store?.[entryKey] && typeof store[entryKey] === "object" ? store[entryKey] : {};
    delete store[entryKey];
    await persistJsonObject(normalizedStorePath, store);

    let archivedTranscriptPath = "";
    let transcriptArchived = false;
    try {
      const archived = await archiveTranscriptFile(entry?.sessionFile, dateNow);
      transcriptArchived = archived.archived === true;
      archivedTranscriptPath = archived.archivedPath || "";
    } catch (err) {
      logger?.warn?.(
        `wechat_work: failed to archive transcript during local reset session=${normalizedSessionKey}: ${String(err?.message || err)}`,
      );
    }

    return {
      cleared: true,
      transcriptArchived,
      archivedTranscriptPath,
    };
  }

  async function resetWecomConversationSession({
    api,
    runtime,
    cfg,
    baseSessionId,
    fromUser,
    chatId = "",
    isGroupChat = false,
    commandBody = "/reset",
    accountId = "default",
    groupChatPolicy = {},
    dynamicAgentPolicy = {},
    isAdminUser = false,
    resolveWecomAgentRoute,
    activeLateReplyWatchers,
  } = {}) {
    if (typeof resolveWecomAgentRoute !== "function") {
      throw new Error("resetWecomConversationSession: resolveWecomAgentRoute is required");
    }
    if (!runtime?.channel?.session?.resolveStorePath) {
      throw new Error("resetWecomConversationSession: runtime.channel.session.resolveStorePath is required");
    }

    const normalizedAccountId = normalizeToken(accountId) || "default";
    const route = resolveWecomAgentRoute({
      runtime,
      cfg,
      channel: "wechat_work",
      accountId: normalizedAccountId,
      sessionKey: baseSessionId,
      fromUser,
      chatId,
      isGroupChat,
      content: commandBody,
      mentionPatterns: groupChatPolicy?.mentionPatterns,
      dynamicConfig: dynamicAgentPolicy,
      isAdminUser,
      logger: api?.logger,
    });

    const sessionKey = normalizeText(route?.sessionKey) || normalizeText(baseSessionId);
    const routedAgentId =
      normalizeText(route?.agentId) || resolveAgentIdFromSessionKey(sessionKey, normalizeText(cfg?.agents?.default));
    const storePath = runtime.channel.session.resolveStorePath(cfg?.session?.store, {
      agentId: routedAgentId,
    });

    const result = await clearSessionStoreEntry({
      storePath,
      sessionKey,
      logger: api?.logger,
    });

    if (activeLateReplyWatchers?.delete) {
      activeLateReplyWatchers.delete(sessionKey);
    }

    api?.logger?.info?.(
      `wechat_work: local session reset account=${normalizedAccountId} agent=${routedAgentId || "main"} session=${sessionKey} cleared=${result.cleared ? "yes" : "no"}`,
    );

    return {
      ...result,
      accountId: normalizedAccountId,
      routedAgentId,
      route,
      sessionKey,
      storePath,
    };
  }

  return {
    clearSessionStoreEntry,
    resetWecomConversationSession,
  };
}
