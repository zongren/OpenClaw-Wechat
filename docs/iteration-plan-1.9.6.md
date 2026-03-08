# Iteration Plan v1.9.6（docs/ops patch）

## 目标
在不引入行为风险的前提下，完成一版“低风险高收益”补丁发版：
- 把近期真实踩坑（可信 IP）沉淀到极速上手 + FAQ + 排障表
- 收敛当前阶段差距，明确下一迭代工程重点
- 以可快速回滚的 docs-only 方式发布，提升部署成功率

## 本次范围（In Scope）
1. README 中文：
   - 5 分钟极速上手增加 Trusted IP 注意项
   - 故障排查增加“能收不回 + 可信 IP”定位
   - FAQ 增加可信 IP 问题
2. README 英文：
   - Quick Start 增加 Trusted IP 注意项
   - FAQ 增加 Trusted IP 问题
3. gap 文档更新：
   - 更新 `docs/compare-sunnoy-gap.md` 为当前状态快照

## 非范围（Out of Scope）
- 不修改运行时逻辑
- 不修改 API 行为
- 不做 schema 变更

## 验收标准
- `npm test` 全绿
- `README.md` / `README.en.md` 可检索到 trusted IP 指引
- `CHANGELOG.md` 有明确 1.9.6 记录
- GitHub Release 成功发布

## 下一迭代（v1.10.0）建议主题
1. 模块化拆分 `src/index.js`（按 inbound/routing/delivery/media/policy 分层）
2. 统一诊断报告导出（selfcheck + 回调矩阵 + 脱敏配置摘要）
3. 提供反代部署模板（Nginx/Caddy/CF Tunnel）与对应回归脚本
