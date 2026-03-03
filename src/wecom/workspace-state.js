import { tmpdir } from "node:os";
import { join } from "node:path";

export function resolveOpenClawStateDir(cfg, { processEnv = process.env, tmpdirFn = tmpdir, joinFn = join } = {}) {
  const configured = String(cfg?.state?.dir ?? "").trim();
  if (configured) return configured;
  if (processEnv.OPENCLAW_STATE_DIR && String(processEnv.OPENCLAW_STATE_DIR).trim()) {
    return String(processEnv.OPENCLAW_STATE_DIR).trim();
  }
  const home = String(processEnv.HOME ?? "").trim();
  return home ? joinFn(home, ".openclaw", "state") : joinFn(tmpdirFn(), "openclaw-state");
}

export function resolveAgentWorkspaceDir(agentId, cfg, options = {}) {
  const normalizedAgentId = String(agentId ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-");
  const stateDir = resolveOpenClawStateDir(cfg, options);
  const joinFn = options?.joinFn ?? join;
  return joinFn(stateDir, `workspace-${normalizedAgentId || "main"}`);
}
