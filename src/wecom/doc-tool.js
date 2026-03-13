import { createWecomDocClient } from "./doc-client.js";
import { wecomDocToolSchema } from "./doc-schema.js";

function ensureFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createWecomDocToolRegistrar: ${name} is required`);
  }
}

function readString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || "";
}

function normalizeOptionalAccountId(normalizeAccountIdFn, value) {
  const trimmed = readString(value);
  if (!trimmed) return "";
  return normalizeAccountIdFn(trimmed);
}

function readChannelConfig(api) {
  return api?.config?.channels?.wecom ?? {};
}

function readConfiguredDefaultAccountId(api, normalizeAccountIdFn) {
  return normalizeOptionalAccountId(normalizeAccountIdFn, readChannelConfig(api)?.defaultAccount);
}

function readChannelDocEnabled(api) {
  const value = readChannelConfig(api)?.tools?.doc;
  if (typeof value === "boolean") return value;
  return true;
}

function readChannelDocAutoGrantRequesterCollaborator(api) {
  const value = readChannelConfig(api)?.tools?.docAutoGrantRequesterCollaborator;
  if (typeof value === "boolean") return value;
  return true;
}

function isDocEnabledForAccount(api, account) {
  if (typeof account?.tools?.doc === "boolean") return account.tools.doc;
  return readChannelDocEnabled(api);
}

function isDocAutoGrantRequesterCollaboratorEnabled(api, account) {
  if (typeof account?.tools?.docAutoGrantRequesterCollaborator === "boolean") {
    return account.tools.docAutoGrantRequesterCollaborator;
  }
  return readChannelDocAutoGrantRequesterCollaborator(api);
}

function hasDocCredentials(account) {
  return Boolean(
    readString(account?.corpId) &&
      readString(account?.corpSecret) &&
      Number.isFinite(Number(account?.agentId)),
  );
}

function listEligibleDocAccounts(api, listEnabledWecomAccounts) {
  return listEnabledWecomAccounts(api).filter(
    (account) => hasDocCredentials(account) && isDocEnabledForAccount(api, account),
  );
}

function buildToolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function mapDocTypeLabel(docType) {
  if (docType === 5) return "智能表格";
  return docType === 4 ? "表格" : "文档";
}

function summarizeDocInfo(info = {}) {
  const docName = readString(info.doc_name) || "未命名文档";
  const docType = mapDocTypeLabel(Number(info.doc_type));
  return `${docType}“${docName}”信息已获取`;
}

function summarizeDocAuth(result = {}) {
  return `权限信息已获取：通知成员 ${result.docMembers?.length ?? 0}，协作者 ${result.coAuthList?.length ?? 0}`;
}

function readBooleanFlag(value) {
  return typeof value === "boolean" ? value : null;
}

function formatDocMemberRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const userid = readString(value.userid ?? value.userId);
  if (userid) return `userid:${userid}`;
  const partyid = readString(value.partyid);
  if (partyid) return `partyid:${partyid}`;
  const tagid = readString(value.tagid);
  if (tagid) return `tagid:${tagid}`;
  return "";
}

function mapDocMemberList(values) {
  return Array.isArray(values)
    ? values.map((item) => formatDocMemberRef(item)).filter(Boolean)
    : [];
}

function describeFlagState(value, enabledLabel, disabledLabel, unknownLabel = "未知") {
  if (value === true) return enabledLabel;
  if (value === false) return disabledLabel;
  return unknownLabel;
}

function buildDocAuthDiagnosis(result = {}, requesterSenderId = "") {
  const accessRule = result.accessRule && typeof result.accessRule === "object" ? result.accessRule : {};
  const viewers = mapDocMemberList(result.docMembers);
  const collaborators = mapDocMemberList(result.coAuthList);
  const requester = readString(requesterSenderId);
  const requesterViewerRef = requester ? `userid:${requester}` : "";
  const requesterIsViewer = requesterViewerRef ? viewers.includes(requesterViewerRef) : false;
  const requesterIsCollaborator = requesterViewerRef ? collaborators.includes(requesterViewerRef) : false;
  const internalAccessEnabled = readBooleanFlag(accessRule.enable_corp_internal);
  const externalAccessEnabled = readBooleanFlag(accessRule.enable_corp_external);
  const externalShareAllowed = typeof accessRule.ban_share_external === "boolean"
    ? !accessRule.ban_share_external
    : null;
  const likelyAnonymousLinkFailure = internalAccessEnabled === true && externalAccessEnabled === false;
  const findings = [
    `企业内访问：${describeFlagState(internalAccessEnabled, "开启", "关闭")}`,
    `企业外访问：${describeFlagState(externalAccessEnabled, "开启", "关闭")}`,
    `外部分享：${describeFlagState(externalShareAllowed, "允许", "禁止")}`,
    `查看成员：${viewers.length}`,
    `协作者：${collaborators.length}`,
  ];
  const recommendations = [];
  if (likelyAnonymousLinkFailure) {
    recommendations.push("当前更像是仅企业内可访问；匿名浏览器或未登录企业微信环境通常会显示“文档不存在”。");
  }
  if (requester) {
    if (requesterIsCollaborator) {
      recommendations.push(`当前请求人 ${requester} 已在协作者列表中。`);
    } else if (requesterIsViewer) {
      recommendations.push(`当前请求人 ${requester} 已在查看成员列表中，但还不是协作者。`);
    } else {
      recommendations.push(`当前请求人 ${requester} 不在查看成员或协作者列表中。`);
    }
  }
  return {
    internalAccessEnabled,
    externalAccessEnabled,
    externalShareAllowed,
    viewerCount: viewers.length,
    collaboratorCount: collaborators.length,
    viewers,
    collaborators,
    requesterSenderId: requester || undefined,
    requesterRole: requesterIsCollaborator ? "collaborator" : requesterIsViewer ? "viewer" : requester ? "none" : "unknown",
    likelyAnonymousLinkFailure,
    findings,
    recommendations,
  };
}

function summarizeDocAuthDiagnosis(diagnosis = {}) {
  const parts = Array.isArray(diagnosis.findings) ? diagnosis.findings : [];
  return parts.length > 0 ? `文档权限诊断：${parts.join("，")}` : "文档权限诊断已完成";
}

function buildDocIdUsageHint(docId) {
  const normalizedDocId = readString(docId);
  if (!normalizedDocId) return "";
  return `后续权限、分享和诊断操作请使用真实 docId：${normalizedDocId}；不要直接使用分享链接路径中的片段。`;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractEmbeddedJson(html, variableName) {
  const source = String(html ?? "");
  if (!source) return null;
  const marker = `window.${variableName}=`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const valueStart = start + marker.length;
  const end = source.indexOf(";</script>", valueStart);
  if (end < 0) return null;
  return safeParseJson(source.slice(valueStart, end));
}

function buildShareLinkDiagnosis({ shareUrl, finalUrl, status, contentType, basicClientVars }) {
  const parsedUrl = new URL(finalUrl || shareUrl);
  const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);
  const pathResourceType = readString(pathSegments[0]);
  const pathResourceId = readString(pathSegments[1]);
  const shareCode = readString(parsedUrl.searchParams.get("scode"));
  const userInfo = basicClientVars?.userInfo && typeof basicClientVars.userInfo === "object"
    ? basicClientVars.userInfo
    : {};
  const docInfo = basicClientVars?.docInfo && typeof basicClientVars.docInfo === "object"
    ? basicClientVars.docInfo
    : {};
  const padInfo = docInfo?.padInfo && typeof docInfo.padInfo === "object"
    ? docInfo.padInfo
    : {};
  const ownerInfo = docInfo?.ownerInfo && typeof docInfo.ownerInfo === "object"
    ? docInfo.ownerInfo
    : {};
  const shareInfo = docInfo?.shareInfo && typeof docInfo.shareInfo === "object"
    ? docInfo.shareInfo
    : {};
  const aclInfo = docInfo?.aclInfo && typeof docInfo.aclInfo === "object"
    ? docInfo.aclInfo
    : {};
  const userType = readString(userInfo.userType);
  const padType = readString(padInfo.padType);
  const padId = readString(padInfo.padId);
  const padTitle = readString(padInfo.padTitle);
  const isGuest = userType === "guest" || Number(userInfo.loginType) === 0;
  const isBlankPage = padType === "blankpage";
  const likelyUnavailableToGuest = isGuest && isBlankPage && !padTitle;
  const findings = [
    `HTTP ${String(status || "")}`.trim(),
    `内容类型：${readString(contentType) || "未知"}`,
    `访问身份：${userType || "未知"}`,
    `页面类型：${padType || "未知"}`,
    `路径资源：${pathResourceType || "未知"} / ${pathResourceId || "未知"}`,
  ];
  const recommendations = [];
  if (likelyUnavailableToGuest) {
    recommendations.push("当前链接对 guest/未登录企业微信环境返回 blankpage，外部访问会表现为打不开或像“文档不存在”。");
  }
  if (shareCode) {
    recommendations.push(`当前链接带有分享码 scode=${shareCode}。如分享码过期或未生效，外部访问会失败。`);
  }
  if (pathResourceId && padId && pathResourceId !== padId) {
    recommendations.push(`链接路径中的资源标识与页面 padId 不一致：path=${pathResourceId}，padId=${padId}。`);
  }
  if (pathResourceId && padId && pathResourceId === padId) {
    recommendations.push("链接路径资源标识与页面 padId 一致，但这仍不等同于 Wedoc API 可用的真实 docId。");
  }
  return {
    shareUrl,
    finalUrl,
    httpStatus: status,
    contentType: readString(contentType) || undefined,
    pathResourceType: pathResourceType || undefined,
    pathResourceId: pathResourceId || undefined,
    shareCode: shareCode || undefined,
    userType: userType || undefined,
    isGuest,
    padId: padId || undefined,
    padType: padType || undefined,
    padTitle: padTitle || undefined,
    ownerId: readString(ownerInfo.ownerId) || undefined,
    hasShareInfo: Object.keys(shareInfo).length > 0,
    hasAclInfo: Object.keys(aclInfo).length > 0,
    likelyUnavailableToGuest,
    findings,
    recommendations,
  };
}

async function inspectWecomShareLink({ shareUrl, fetchImpl }) {
  const normalizedUrl = readString(shareUrl);
  if (!normalizedUrl) throw new Error("shareUrl required");
  let parsed;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    throw new Error("shareUrl must be a valid URL");
  }
  const response = await fetchImpl(parsed.toString(), {
    headers: {
      "user-agent": "OpenClaw-Wechat/1.0",
      accept: "text/html,application/xhtml+xml",
    },
  });
  const contentType = response.headers?.get?.("content-type") || "";
  const html = await response.text();
  const basicClientVars = extractEmbeddedJson(html, "basicClientVars");
  const diagnosis = buildShareLinkDiagnosis({
    shareUrl: normalizedUrl,
    finalUrl: response.url || parsed.toString(),
    status: response.status,
    contentType,
    basicClientVars,
  });
  return {
    raw: {
      httpStatus: response.status,
      finalUrl: response.url || parsed.toString(),
      contentType,
      basicClientVars,
    },
    diagnosis,
  };
}

function summarizeShareLinkDiagnosis(diagnosis = {}) {
  const parts = Array.isArray(diagnosis.findings) ? diagnosis.findings : [];
  return parts.length > 0 ? `分享链接校验：${parts.join("，")}` : "分享链接校验已完成";
}

function summarizeSheetProperties(result = {}) {
  return `表格属性已获取：工作表 ${result.properties?.length ?? 0}`;
}

function summarizeDocAccess(result = {}) {
  const parts = [];
  if (result.addedViewerCount) parts.push(`新增查看成员 ${result.addedViewerCount}`);
  if (result.addedCollaboratorCount) parts.push(`新增协作者 ${result.addedCollaboratorCount}`);
  if (result.removedViewerCount) parts.push(`移除查看成员 ${result.removedViewerCount}`);
  if (result.removedCollaboratorCount) parts.push(`移除协作者 ${result.removedCollaboratorCount}`);
  return parts.length > 0 ? `文档权限已更新：${parts.join("，")}` : "文档权限已更新";
}

function summarizeFormInfo(result = {}) {
  const title = readString(result.formInfo?.form_title) || "未命名收集表";
  return `收集表“${title}”信息已获取`;
}

function summarizeFormAnswer(result = {}) {
  return `收集表答案已获取：字段 ${result.answerList?.length ?? 0}`;
}

function summarizeFormStatistic(result = {}) {
  return `收集表统计已获取：请求 ${result.items?.length ?? 0}，成功 ${result.successCount ?? 0}`;
}

function readMemberUserId(value) {
  if (typeof value === "string" || typeof value === "number") {
    return readString(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return readString(value.userid ?? value.userId);
}

function hasMemberUserId(values, requesterSenderId) {
  const normalizedRequesterSenderId = readString(requesterSenderId);
  if (!normalizedRequesterSenderId) return false;
  return Array.isArray(values) && values.some((item) => readMemberUserId(item) === normalizedRequesterSenderId);
}

function resolveCreateCollaborators({
  api,
  account,
  toolContext,
  params,
}) {
  const explicitCollaborators = Array.isArray(params?.collaborators) ? [...params.collaborators] : [];
  const requesterSenderId = readString(toolContext?.requesterSenderId);
  if (!requesterSenderId) return explicitCollaborators;
  if (!isDocAutoGrantRequesterCollaboratorEnabled(api, account)) return explicitCollaborators;
  if (hasMemberUserId(explicitCollaborators, requesterSenderId)) return explicitCollaborators;
  if (hasMemberUserId(params?.viewers, requesterSenderId)) return explicitCollaborators;
  explicitCollaborators.push(requesterSenderId);
  return explicitCollaborators;
}

function resolveToolAccount({
  api,
  toolContext,
  params,
  listEnabledWecomAccounts,
  normalizeAccountIdFn,
}) {
  const eligibleAccounts = listEligibleDocAccounts(api, listEnabledWecomAccounts);
  if (eligibleAccounts.length === 0) {
    throw new Error("WeCom Doc tool unavailable: no eligible account with doc access is enabled");
  }

  const explicitAccountId = normalizeOptionalAccountId(normalizeAccountIdFn, params?.accountId);
  if (explicitAccountId) {
    const matched = eligibleAccounts.find(
      (account) => normalizeAccountIdFn(account.accountId) === explicitAccountId,
    );
    if (!matched) {
      throw new Error(`WeCom Doc account not found or doc tool disabled: ${explicitAccountId}`);
    }
    return matched;
  }

  const agentAccountId = normalizeOptionalAccountId(normalizeAccountIdFn, toolContext?.agentAccountId);
  if (agentAccountId) {
    const matched = eligibleAccounts.find(
      (account) => normalizeAccountIdFn(account.accountId) === agentAccountId,
    );
    if (matched) return matched;
  }

  const configuredDefaultAccountId = readConfiguredDefaultAccountId(api, normalizeAccountIdFn);
  if (configuredDefaultAccountId) {
    const matched = eligibleAccounts.find(
      (account) => normalizeAccountIdFn(account.accountId) === configuredDefaultAccountId,
    );
    if (matched) return matched;
  }

  return eligibleAccounts[0];
}

export function createWecomDocToolRegistrar({
  listEnabledWecomAccounts,
  normalizeAccountId: normalizeAccountIdFn,
  fetchWithRetry,
  getWecomAccessToken,
  fetchImpl = fetch,
} = {}) {
  ensureFunction("listEnabledWecomAccounts", listEnabledWecomAccounts);
  ensureFunction("normalizeAccountId", normalizeAccountIdFn);
  ensureFunction("fetchWithRetry", fetchWithRetry);
  ensureFunction("getWecomAccessToken", getWecomAccessToken);
  ensureFunction("fetchImpl", fetchImpl);

  const docClient = createWecomDocClient({
    fetchWithRetry,
    getWecomAccessToken,
  });

  return function registerWecomDocTools(api) {
    if (typeof api?.registerTool !== "function") return;
    if (!readChannelDocEnabled(api)) {
      api.logger?.info?.("wecom_doc: disabled by channels.wechat_work.tools.doc=false");
      return;
    }

    const eligibleAccounts = listEligibleDocAccounts(api, listEnabledWecomAccounts);
    if (eligibleAccounts.length === 0) {
      api.logger?.info?.("wecom_doc: no eligible account found; tool not registered");
      return;
    }

    api.registerTool((toolContext = {}) => ({
      name: "wecom_doc",
      label: "WeCom Doc",
      description:
        "企业微信文档工具。支持文档创建、查看/协作者权限配置、收集表管理与表格属性查询。",
      parameters: wecomDocToolSchema,
      async execute(_toolCallId, params) {
        try {
          const account = resolveToolAccount({
            api,
            toolContext,
            params,
            listEnabledWecomAccounts,
            normalizeAccountIdFn,
          });
          const accountContext = {
            ...account,
            logger: api.logger,
          };

          switch (params?.action) {
            case "create": {
              const collaborators = resolveCreateCollaborators({
                api,
                account,
                toolContext,
                params,
              });
              const result = await docClient.createDoc({
                account: accountContext,
                docName: params.docName,
                docType: params.docType,
                spaceId: params.spaceId,
                fatherId: params.fatherId,
                adminUsers: params.adminUsers,
              });
              let accessResult = null;
              if ((Array.isArray(params.viewers) && params.viewers.length > 0) ||
                  collaborators.length > 0) {
                try {
                  accessResult = await docClient.grantDocAccess({
                    account: accountContext,
                    docId: result.docId,
                    viewers: params.viewers,
                    collaborators,
                  });
                } catch (err) {
                  return buildToolResult({
                    ok: false,
                    partial: true,
                    action: "create",
                    accountId: account.accountId,
                    resourceType: result.docTypeLabel,
                    canonicalDocId: result.docId,
                    docId: result.docId,
                    title: readString(params.docName),
                    url: result.url || undefined,
                    summary: `已创建${mapDocTypeLabel(result.docType)}“${readString(params.docName)}”（docId: ${result.docId}），但权限授予失败`,
                    usageHint: buildDocIdUsageHint(result.docId) || undefined,
                    error: err instanceof Error ? err.message : String(err),
                    raw: {
                      create: result.raw,
                    },
                  });
                }
              }
              return buildToolResult({
                ok: true,
                action: "create",
                accountId: account.accountId,
                resourceType: result.docTypeLabel,
                canonicalDocId: result.docId,
                docId: result.docId,
                title: readString(params.docName),
                url: result.url || undefined,
                summary: accessResult
                  ? `已创建${mapDocTypeLabel(result.docType)}“${readString(params.docName)}”（docId: ${result.docId}）；${summarizeDocAccess(accessResult)}`
                  : `已创建${mapDocTypeLabel(result.docType)}“${readString(params.docName)}”（docId: ${result.docId}）`,
                usageHint: buildDocIdUsageHint(result.docId) || undefined,
                raw: accessResult
                  ? {
                      create: result.raw,
                      access: accessResult.raw,
                    }
                  : result.raw,
              });
            }
            case "rename": {
              const result = await docClient.renameDoc({
                account: accountContext,
                docId: params.docId,
                newName: params.newName,
              });
              return buildToolResult({
                ok: true,
                action: "rename",
                accountId: account.accountId,
                docId: result.docId,
                title: result.newName,
                summary: `文档已重命名为“${result.newName}”`,
                raw: result.raw,
              });
            }
            case "get_info": {
              const result = await docClient.getDocBaseInfo({
                account: accountContext,
                docId: params.docId,
              });
              return buildToolResult({
                ok: true,
                action: "get_info",
                accountId: account.accountId,
                docId: params.docId,
                title: readString(result.info?.doc_name) || undefined,
                resourceType:
                  Number(result.info?.doc_type) === 5
                    ? "smart_table"
                    : Number(result.info?.doc_type) === 4
                      ? "spreadsheet"
                      : "doc",
                summary: summarizeDocInfo(result.info),
                raw: result.raw,
              });
            }
            case "share": {
              const result = await docClient.shareDoc({
                account: accountContext,
                docId: params.docId,
              });
              return buildToolResult({
                ok: true,
                action: "share",
                accountId: account.accountId,
                canonicalDocId: params.docId,
                docId: params.docId,
                url: result.shareUrl || undefined,
                summary: result.shareUrl ? `文档分享链接已获取（docId: ${params.docId}）` : `文档分享接口调用成功（docId: ${params.docId}）`,
                usageHint: buildDocIdUsageHint(params.docId) || undefined,
                raw: result.raw,
              });
            }
            case "get_auth": {
              const result = await docClient.getDocAuth({
                account: accountContext,
                docId: params.docId,
              });
              const diagnosis = buildDocAuthDiagnosis(result, toolContext?.requesterSenderId);
              return buildToolResult({
                ok: true,
                action: "get_auth",
                accountId: account.accountId,
                canonicalDocId: params.docId,
                docId: params.docId,
                summary: summarizeDocAuth(result),
                diagnosis,
                raw: result.raw,
              });
            }
            case "diagnose_auth": {
              const result = await docClient.getDocAuth({
                account: accountContext,
                docId: params.docId,
              });
              const diagnosis = buildDocAuthDiagnosis(result, toolContext?.requesterSenderId);
              return buildToolResult({
                ok: true,
                action: "diagnose_auth",
                accountId: account.accountId,
                canonicalDocId: params.docId,
                docId: params.docId,
                summary: summarizeDocAuthDiagnosis(diagnosis),
                diagnosis,
                raw: result.raw,
              });
            }
            case "validate_share_link": {
              const result = await inspectWecomShareLink({
                shareUrl: params.shareUrl,
                fetchImpl,
              });
              return buildToolResult({
                ok: true,
                action: "validate_share_link",
                accountId: account.accountId,
                url: result.diagnosis.finalUrl || params.shareUrl,
                summary: summarizeShareLinkDiagnosis(result.diagnosis),
                diagnosis: result.diagnosis,
                raw: result.raw,
              });
            }
            case "delete": {
              const result = await docClient.deleteDoc({
                account: accountContext,
                docId: params.docId,
                formId: params.formId,
              });
              return buildToolResult({
                ok: true,
                action: "delete",
                accountId: account.accountId,
                docId: result.docId || undefined,
                formId: result.formId || undefined,
                summary: result.formId ? "收集表已删除" : "文档已删除",
                raw: result.raw,
              });
            }
            case "set_join_rule": {
              const result = await docClient.setDocJoinRule({
                account: accountContext,
                docId: params.docId,
                request: params.request,
              });
              return buildToolResult({
                ok: true,
                action: "set_join_rule",
                accountId: account.accountId,
                docId: result.docId,
                summary: "文档查看规则已更新",
                raw: result.raw,
              });
            }
            case "set_member_auth": {
              const result = await docClient.setDocMemberAuth({
                account: accountContext,
                docId: params.docId,
                request: params.request,
              });
              return buildToolResult({
                ok: true,
                action: "set_member_auth",
                accountId: account.accountId,
                docId: result.docId,
                summary: "文档通知范围及成员权限已更新",
                raw: result.raw,
              });
            }
            case "grant_access": {
              const result = await docClient.grantDocAccess({
                account: accountContext,
                docId: params.docId,
                viewers: params.viewers,
                collaborators: params.collaborators,
                removeViewers: params.removeViewers,
                removeCollaborators: params.removeCollaborators,
              });
              return buildToolResult({
                ok: true,
                action: "grant_access",
                accountId: account.accountId,
                docId: result.docId,
                summary: summarizeDocAccess(result),
                raw: result.raw,
              });
            }
            case "add_collaborators": {
              const result = await docClient.addDocCollaborators({
                account: accountContext,
                docId: params.docId,
                collaborators: params.collaborators,
              });
              return buildToolResult({
                ok: true,
                action: "add_collaborators",
                accountId: account.accountId,
                docId: result.docId,
                summary: `协作者已添加：${result.addedCollaboratorCount ?? 0}`,
                raw: result.raw,
              });
            }
            case "set_safety_setting": {
              const result = await docClient.setDocSafetySetting({
                account: accountContext,
                docId: params.docId,
                request: params.request,
              });
              return buildToolResult({
                ok: true,
                action: "set_safety_setting",
                accountId: account.accountId,
                docId: result.docId,
                summary: "文档安全设置已更新",
                raw: result.raw,
              });
            }
            case "create_collect": {
              const result = await docClient.createCollect({
                account: accountContext,
                formInfo: params.formInfo,
                spaceId: params.spaceId,
                fatherId: params.fatherId,
              });
              const title = readString(result.title);
              return buildToolResult({
                ok: true,
                action: "create_collect",
                accountId: account.accountId,
                formId: result.formId,
                title: title || undefined,
                summary: title ? `已创建收集表“${title}”` : "收集表已创建",
                raw: result.raw,
              });
            }
            case "modify_collect": {
              const result = await docClient.modifyCollect({
                account: accountContext,
                oper: params.oper,
                formId: params.formId,
                formInfo: params.formInfo,
              });
              const title = readString(result.title);
              return buildToolResult({
                ok: true,
                action: "modify_collect",
                accountId: account.accountId,
                formId: result.formId,
                title: title || undefined,
                summary: title
                  ? `收集表已更新（${result.oper}）：“${title}”`
                  : `收集表已更新（${result.oper}）`,
                raw: result.raw,
              });
            }
            case "get_form_info": {
              const result = await docClient.getFormInfo({
                account: accountContext,
                formId: params.formId,
              });
              return buildToolResult({
                ok: true,
                action: "get_form_info",
                accountId: account.accountId,
                formId: params.formId,
                title: readString(result.formInfo?.form_title) || undefined,
                summary: summarizeFormInfo(result),
                raw: result.raw,
              });
            }
            case "get_form_answer": {
              const result = await docClient.getFormAnswer({
                account: accountContext,
                repeatedId: params.repeatedId,
                answerIds: params.answerIds,
              });
              return buildToolResult({
                ok: true,
                action: "get_form_answer",
                accountId: account.accountId,
                repeatedId: params.repeatedId,
                summary: summarizeFormAnswer(result),
                raw: result.raw,
              });
            }
            case "get_form_statistic": {
              const result = await docClient.getFormStatistic({
                account: accountContext,
                requests: params.requests,
              });
              return buildToolResult({
                ok: true,
                action: "get_form_statistic",
                accountId: account.accountId,
                summary: summarizeFormStatistic(result),
                raw: result.raw,
              });
            }
            case "get_sheet_properties": {
              const result = await docClient.getSheetProperties({
                account: accountContext,
                docId: params.docId,
              });
              return buildToolResult({
                ok: true,
                action: "get_sheet_properties",
                accountId: account.accountId,
                docId: params.docId,
                summary: summarizeSheetProperties(result),
                raw: result.raw,
              });
            }
            default:
              throw new Error(`Unknown wecom_doc action: ${String(params?.action || "")}`);
          }
        } catch (err) {
          return buildToolResult({
            ok: false,
            action: String(params?.action || ""),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    }));
    api.logger?.info?.(`wecom_doc: registered (accounts=${eligibleAccounts.length})`);
  };
}
