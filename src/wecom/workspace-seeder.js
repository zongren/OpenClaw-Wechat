import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveAgentWorkspaceDir } from "./workspace-state.js";

export function createDynamicWorkspaceSeeder({
  bootstrapTemplateFiles,
  seededAgentWorkspaces,
  resolveAgentWorkspaceDirFn = resolveAgentWorkspaceDir,
  readdirImpl = readdir,
  statImpl = stat,
  copyFileImpl = copyFile,
  mkdirImpl = mkdir,
  joinFn = join,
} = {}) {
  if (!(bootstrapTemplateFiles instanceof Set)) {
    throw new Error("createDynamicWorkspaceSeeder: bootstrapTemplateFiles Set is required");
  }
  if (!(seededAgentWorkspaces instanceof Set)) {
    throw new Error("createDynamicWorkspaceSeeder: seededAgentWorkspaces Set is required");
  }

  async function seedDynamicAgentWorkspace({ api, agentId, workspaceTemplate }) {
    const templateDir = String(workspaceTemplate ?? "").trim();
    const normalizedAgentId = String(agentId ?? "").trim().toLowerCase();
    if (!templateDir || !normalizedAgentId) return;

    const cacheKey = `${normalizedAgentId}::${templateDir}`;
    if (seededAgentWorkspaces.has(cacheKey)) return;

    let entries = [];
    try {
      entries = await readdirImpl(templateDir, { withFileTypes: true });
    } catch (err) {
      api?.logger?.warn?.(`wechat_work: workspaceTemplate unavailable (${templateDir}): ${String(err?.message || err)}`);
      return;
    }

    const workspaceDir = resolveAgentWorkspaceDirFn(normalizedAgentId, api?.config);
    await mkdirImpl(workspaceDir, { recursive: true });

    let copiedCount = 0;
    for (const entry of entries) {
      if (!entry?.isFile?.()) continue;
      const fileName = String(entry.name ?? "").trim();
      if (!bootstrapTemplateFiles.has(fileName)) continue;
      const sourcePath = joinFn(templateDir, fileName);
      const destPath = joinFn(workspaceDir, fileName);
      try {
        await statImpl(destPath);
        continue;
      } catch {
        // destination missing
      }
      await copyFileImpl(sourcePath, destPath);
      copiedCount += 1;
      api?.logger?.info?.(`wechat_work: seeded workspace file agent=${normalizedAgentId} file=${fileName}`);
    }

    seededAgentWorkspaces.add(cacheKey);
    if (copiedCount > 0) {
      api?.logger?.info?.(
        `wechat_work: workspace template seeded agent=${normalizedAgentId} files=${copiedCount} dir=${workspaceDir}`,
      );
    }
  }

  return {
    seedDynamicAgentWorkspace,
  };
}
