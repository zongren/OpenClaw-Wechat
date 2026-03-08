const DEFAULT_ACCOUNT_ID = "default";
const CHANNEL_CONNECTED_TTL_MS = 10 * 60 * 1000;

const accountInboundState = new Map();
const accountConnectionState = new Map();

function readString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || "";
}

function normalizeAccountId(accountId) {
  return readString(accountId).toLowerCase() || DEFAULT_ACCOUNT_ID;
}

function normalizeInboundTimestamp(value) {
  if (value == null || value === "") return Date.now();
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return Date.now();
  if (raw < 1e12) return Math.floor(raw * 1000);
  return Math.floor(raw);
}

function formatIso(ms) {
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function toConnectedFlag(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return false;
  return Date.now() - ms <= CHANNEL_CONNECTED_TTL_MS;
}

function buildMergedConnectionState(accountId, latestInboundMs = 0) {
  const connection = accountConnectionState.get(normalizeAccountId(accountId));
  const inboundConnected = toConnectedFlag(latestInboundMs);
  if (!connection) {
    return {
      connected: inboundConnected,
      transport: null,
      connectedAt: null,
      connectedAtMs: null,
    };
  }
  return {
    connected: connection.connected === true || inboundConnected,
    transport: connection.transport || null,
    connectedAt: connection.connectedAt ?? null,
    connectedAtMs: Number(connection.connectedAtMs) || null,
  };
}

export function markWecomInboundActivity({ accountId, timestamp } = {}) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const inboundAtMs = normalizeInboundTimestamp(timestamp);
  const existing = accountInboundState.get(normalizedAccountId);
  if (existing && Number(existing.lastInboundAtMs) > inboundAtMs) {
    return existing;
  }
  const next = {
    accountId: normalizedAccountId,
    lastInboundAtMs: inboundAtMs,
    lastInboundAt: formatIso(inboundAtMs),
  };
  accountInboundState.set(normalizedAccountId, next);
  return next;
}

export function getWecomInboundActivity(accountId) {
  const entry = accountInboundState.get(normalizeAccountId(accountId));
  if (!entry) {
    const connectionState = buildMergedConnectionState(accountId, 0);
    if (!connectionState.connected && !connectionState.transport) return null;
    return {
      accountId: normalizeAccountId(accountId),
      lastInboundAtMs: null,
      lastInboundAt: null,
      ...connectionState,
    };
  }
  const latestMs = Number(entry.lastInboundAtMs ?? 0);
  return {
    ...entry,
    ...buildMergedConnectionState(accountId, latestMs),
  };
}

export function getWecomChannelInboundActivity(accountIds = []) {
  const normalizedIds = Array.isArray(accountIds)
    ? accountIds.map((item) => normalizeAccountId(item))
    : [];
  const targetEntries =
    normalizedIds.length > 0
      ? normalizedIds.map((id) => accountInboundState.get(id)).filter(Boolean)
      : Array.from(accountInboundState.values());
  if (targetEntries.length === 0) {
    return {
      connected: false,
      lastInboundAt: null,
      lastInboundAtMs: null,
    };
  }

  let latest = targetEntries[0];
  for (const entry of targetEntries) {
    if ((entry?.lastInboundAtMs ?? 0) > (latest?.lastInboundAtMs ?? 0)) {
      latest = entry;
    }
  }

  const latestMs = Number(latest?.lastInboundAtMs ?? 0);
  const connectionEntries =
    normalizedIds.length > 0
      ? normalizedIds.map((id) => accountConnectionState.get(id)).filter(Boolean)
      : Array.from(accountConnectionState.values());
  const anyConnected = connectionEntries.some((entry) => entry?.connected === true);
  return {
    connected: anyConnected || toConnectedFlag(latestMs),
    lastInboundAt: latest?.lastInboundAt ?? null,
    lastInboundAtMs: Number.isFinite(latestMs) ? latestMs : null,
  };
}

export function setWecomConnectionState({ accountId, connected, transport = "" } = {}) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const nextConnected = connected === true;
  const existing = accountConnectionState.get(normalizedAccountId);
  const connectedAtMs = nextConnected
    ? Number(existing?.connectedAtMs) > 0
      ? Number(existing.connectedAtMs)
      : Date.now()
    : null;
  const next = {
    accountId: normalizedAccountId,
    connected: nextConnected,
    transport: String(transport ?? "").trim() || existing?.transport || null,
    connectedAtMs,
    connectedAt: connectedAtMs ? formatIso(connectedAtMs) : null,
  };
  accountConnectionState.set(normalizedAccountId, next);
  return next;
}

export function __resetWecomInboundActivityForTests() {
  accountInboundState.clear();
  accountConnectionState.clear();
}
