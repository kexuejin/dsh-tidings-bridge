# 更新日志 (Changelog)

本仓库遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [Unreleased]

## [0.4.0] - 2026-10-25

### Changed

- **包与仓库名随产品更名**：npm 包 `dsh-tidings` → `dsh-tidings`，仓库 `dsh-tidings-bridge` →
  `dsh-tidings-bridge`，界面文案「捎话 (Tidings)」→「捎话 (Tidings)」。插件只耦合控制面
  （`127.0.0.1:8788` 回环 HTTP），不探测桌面端的路径/进程/数据目录，桌面端应用更名与
  目录迁移对插件零影响；旧包 `dsh-tidings` 以 deprecate 指向新名。

- **`user/message` 优先带结构化附件元数据（task-45，cap `att1`）**：`attachment` 是
  `POST /v1/agent/event` 的可选字段，键名与顺序照 core/protocol 的 CodecAgent
  （attachmentId / mediaType / width / height / bytes / name，除前两个外可选）。
  本端从 DSH 的 content 块抽这六个键（真机实测：`{type:'image',attachment:{…}}`），
  并且：
  - **白名单**：只放这六个键，DSH 块里多出来的键（如 `path`/`secret`）**不进请求体**
    —— 协议是严格白名单，多一个键整帧拒（半张卡片比占位更糟）；
  - **越界先自检**：id ≤128 / mediaType ≤64 / name ≤128 / 宽高 ≤32768 / bytes ≤512 MiB，
    任一越界就**丢掉 attachment**、只发占位（少一张卡片，好过整条事件消失）；
  - **占位文本始终留在 body 里**：它是回退。对端没声明 `att1`（或宿主还没把
    attachment 接上线上）时，手机看到的就是那句「🖼 图片: name (920×412, 30 KB)」。

  新增第十条门禁 `scripts/check-attachment-passthrough.mjs`（含 `--self-test`：把源码改成
  「不发 attachment」与「整体展开原始对象」两种坏形态，断言判据真的报错），接进 `npm run check`。

### Fixed

- **`user/message` 只带图片时整条事件不转发**（真机反馈「DSH 发的图片消息 tidings 这边看不到」）。
  `extractUserPrompt` 原来只拼 `type === 'text'` 的内容块 ⇒ 只有图片的消息得到空串 ⇒
  `pendingFor` 里 `body === undefined` 直接 `return undefined` ⇒ **事件根本不入队、不发送**；
  手机端不是「图没渲染」，是「这条消息不存在」。现在图片/附件块转成一行占位文本
  （`🖼 图片: image.png (920×412, 30 KB)` / `📎 附件: …`，读 `attachment` 的 name/width/height/bytes），
  `titleFrom` 在只有图片时也退回该占位（否则会话在手机上退回 `session-…`）。

  **为什么只能改在本仓**：附件信息只存在于 DSH 的会话事件里（`user/message` 的 content 块），
  而 tidings 侧的协议帧（`AGENT_EVENT`）只有 summary/body/ref 三个文本字段、没有附件通道 ——
  控制面拿不到任何「这里有一张图」的事实。要真正传图（缩略图/附件卡片）得先扩协议，
  在那之前**文本占位是当前正确的形态**：它把「整条消失」变成「看得见是什么、多大」。

### Added

- 第八条回归门禁 `scripts/check-image-blocks.mjs`（接进 `npm run check`）：四条判据钉住
  「非 text 块必须转成占位、占位必须真读元数据、image/file/attachment 三类要接受、
  titleFrom 要退回占位」，并带 `--self-test`（把源码改回「只拼 text」的旧形态，断言判据真的报错）
  —— 量具必须能证明自己不是空转。

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
