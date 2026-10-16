# 更新日志 (Changelog)

本仓库遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [0.1.0] - 2026-10-16

首次以开源形态发布。

### Added

- host 半：agentNode 回环控制面客户端（`tidings.ts`）、九个 agent 工具、会话/工作区自动宣告（PPE-1 §6.1/§6.2 与增补 D3/D7/D8）。
- browser 半：DSH 设置页一张集成卡片（连接状态、自动宣告开关、控制面地址），zh/en 双词典。
- 七条回归门禁（`scripts/check-*.mjs`，每条钉一次真实故障）+ 真实控制面往返验证（`check-real.mjs`）。
- 设计沿革：2026-10-14 面板精简设计文档与原型稿（含截图与几何探针）。
- 开源就绪：MIT LICENSE、双语 README、CONTRIBUTING / SECURITY / CHANGELOG、GitHub CI（跑 `pnpm run check`）、`prepare` 脚本支持 `dsh plugin add github:...`。

### Changed

- `devDependencies` 从本机 `link:../deepseek-harness/...` 切换为 npm 已发布版本，仓库可独立 `pnpm install`。
- 构建产物（`lib/`、`client/`）不再入库，由安装时 `prepare` 现场生成。
