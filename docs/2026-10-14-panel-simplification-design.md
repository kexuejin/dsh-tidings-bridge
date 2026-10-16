# dsh-tidings 极简重构设计（2026-10-14）

> **状态**：已定稿待实施（2026-10-14 用户裁决）  
> **实施者**：Subagent / 实施代理  
> **关联决策**：
> 1. 采用**方案 A（桌面端原生一体化承载）**，放弃独立命令行 agentNode 进程；
> 2. **彻底去面板化**：移除 DSH 侧边栏独立一级大面板，降级为 **DSH 设置（Settings）里的极简集成配置卡片**，与 `dsh-im` 等生态插件标准对齐。

---

## 0 核心裁决与架构背景

### 0.1 为什么放弃独立进程与侧边栏大面板？

1. **生命周期自然闭环（方案 A）**：
   - 捎话桌面端（Compose App）**自带系统托盘（Tray）、支持开机自启、关闭窗口只是隐藏后台**，它本身就是机器上最天然、最稳定的常驻守护者。
   - 原设计的独立 `agentNode` 命令行进程无看护者，开机无人拉起，挂了无人重启，退出留孤儿进程。现统一由**桌面端托盘原生固定监听 `127.0.0.1:8788` 并广播 `ag1`（Agent 能力）**，彻底终结进程生命周期痛点。

2. **DSH 插件本质是静默桥接（Bridge / Exporter）**：
   - 用户使用 DSH 是为了开发与调度 Agent，没有任何人会在 DSH 侧边栏常开一个 IM 面板。
   - 原插件试图做一个完整的 Web IM 控制台（包含手填 IP 发消息、单会话流、8 个独立视图、2000+ 行 React 代码），造成了严重的体验臃肿与代码负债。
   - 插件的核心使命只有两件事：
     - 监听 DSH 内部的会话/工作区事件并推给 `127.0.0.1:8788`；
     - 响应手机端的分页拉取请求（D8）。
   - **它的正确归宿是 DSH 设置（Settings）页里的一个集成项，零干扰，配置一次终身静默工作。**

---

## 1 系统架构全景（方案 A）

```
┌────────────────────────────────────────────────────────┐
│  用户电脑（Mac / Windows / Linux）                      │
│                                                        │
│   DSH 宿主进程 (Node.js)          捎话 桌面端 (Compose JVM)│
│   ┌────────────────────┐ HTTP 8788┌──────────────────┐ │
│   │ dsh-tidings 插件     │ <──────> │ DesktopExtension │ │
│   │ (Settings 极简集成) │(localhost) 托盘常驻 (Tray) │ │
│   └────────────────────┘          │ 开机自启 / 后台守护 │ │
│                                   └────────┬─────────┘ │
└────────────────────────────────────────────┼───────────┘
                                             │ LAN (UDP/TCP)
                                             ▼
                                    ┌────────────────┐
                                    │  捎话 手机端    │
                                    │  (识别这台电脑) │
                                    └────────────────┘
```

| 角色 | 寄宿位置 | 职责 |
|---|---|---|
| **dsh-tidings 插件** | DSH 宿主进程内 | 监听 DSH 会话与工作区，静默推送给桌面端；在 DSH 设置中提供开关与探活状态。 |
| **捎话 桌面端** | 独立 GUI/托盘进程 | 固定监听回环 `127.0.0.1:8788` 控制面，承载局域网 P2P 通信，广播 `ag1, aws1, agr1, agp1`。 |
| **捎话 手机端** | 移动设备 | 浏览工作区、历史会话切换、审批授权与指令交互。 |

---

## 2 实施目标与改造细节

### 2.1 彻底清理客户端 UI（去大面板化）

1. **移除侧边栏注册**：
   - 在 `src/client/index.ts` 中移除 `ctx.slots.inject('sidebar.panellist', ...)` 注册。
   - 释放 DSH 侧边栏一级入口空间。
2. **删除大面板代码**：
   - 彻底删除 `src/client/TidingsPanel.tsx` 及其附属样式（2000+ 行代码全部清理）。
   - 清除全部 8 个冗余视图（`composeView`, `threadView`, `grantsView`, `settingsView`, `credentialView`, `pairingView`, `agentSessionsView`）。
3. **注册设置页面扩展（Settings Contribution）**：
   - 使用 DSH 官方规范注册设置卡片（或直接通过 Host 端的 `Config` Schema 声明）。

---

### 2.2 设置页（Settings）交互规格

在 DSH **「设置」->「捎话 (Tidings)」** 中呈现的极简卡片：

```
┌─ 捎话 (Tidings) 局域网桥接 ─────────────────────────────────────┐
│ 将 DSH 的 AI 工作区与会话实时同步到局域网手机端。                 │
│                                                            │
│ 连接状态：🟢 捎话 桌面端已连接 (127.0.0.1:8788)                 │
│          （若未连接显示：🔴 未检测到桌面端，请启动捎话桌面端）      │
│                                                            │
│ [x] 自动宣告工作区与活动会话（默认开启）                           │
│                                                            │
│ 授权策略（D7）                                              │
│ [ 自动放行 (auto)  ▼ ]                                     │
│ 选项：自动放行 (auto) / 需设备授权 (byDevice) / 每次申请 (request)│
│                                                            │
│ 高级选项（折叠）                                             │
│ · 控制面地址：http://127.0.0.1:8788                          │
│ · 目标设备限制：(留空广播至在线局域网设备)                       │
└────────────────────────────────────────────────────────────┘
```

---

### 2.3 插件 Host 半程（保持轻量与高内聚）

保持当前刚验证通过的核心桥接链路，**不动协议，不加新帧**：
1. **工作区与活动会话宣告（`announce.ts`）**：
   - 保持开机延时 1s 宣告已知工作区；
   - 保持 `session/created` 和 `session/event` 实时推流。
2. **历史会话分页应答（`session-page-responder.ts`）**：
   - 保持轮询 `GET /v1/agent/session-pages`；
   - 保持向手机端带 `wsId/wsPath/wsTitle/agentId` 回推历史会话帧。
3. **探活与状态回报（RPC 端点）**：
   - 保留极简的 `health` RPC 端点供设置页读取：
     - 请求 `http://127.0.0.1:8788/healthz`；
     - 返回 `{ ok: true, boundPort, nodeId, peerCount }` 或 `{ ok: false, error }`。

---

## 3 执行实施清单（勾选式）

实施 Subagent 需按以下顺序执行：

### Step 1: 桌面端支持固定端口 8788（`teahouse-mobile` 仓库）
- [ ] 在 `desktopApp/src/main/kotlin/app/tidings/desktop/DesktopExtension.kt` 中：
  - 将 `httpPort` 默认值改为 `ControlPlane.DEFAULT_HTTP_PORT`（8788）；
  - 捕获绑定异常，若 8788 冲突优雅记录，不拖垮桌面 UI。
- [ ] 在 `composeApp/src/commonMain/kotlin/app/tidings/app/TidingsSettings.kt` 中：
  - 确保桌面端 capabilities 包含 `MsgTypes.CAP_AGENT`（`ag1`），使手机端识别这台电脑为伴生 Agent 节点。

### Step 2: 插件端去面板与设置收敛（`dsh-tidings` 仓库）
- [ ] 清理 `src/client/TidingsPanel.tsx`，移除 8 个视图实现与无用状态；
- [ ] 在 `src/client/index.ts` 中移除 `sidebar.panellist` 侧栏入口；
- [ ] 确保 `src/index.ts` 的 `Config` Schema 包含：
  - `baseUrl` (默认 `http://127.0.0.1:8788`)；
  - `autoAnnounce` (默认 `true`)；
  - `announceTargets` (默认 `[]`)。
- [ ] 提供轻量设置展示组件或纯 Schema 驱动卡片。

### Step 3: 构建与验收
- [ ] 在 `dsh-tidings` 仓库执行 `npm run check`（`typecheck` + `build`），确保 0 错误；
- [ ] 在 `teahouse-mobile` 仓库执行 `./gradlew check`，确保单测与门禁全绿；
- [ ] 验证：DSH 启动后无侧边栏红点，设置页显示绿色已连接；手机端打开能看见这台电脑并看到其 DSH 工作区。
