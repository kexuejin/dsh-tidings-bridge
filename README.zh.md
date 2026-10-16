# dsh-tidings

[English](README.md) | [中文](README.zh.md)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：把 DSH 会话桥接到本机的**捎话 (Tidings)** 节点 —— 即捎话桌面端常驻的 agentNode，局域网消息协议的持有者。

插件**只**说 agentNode 的回环 HTTP 控制面（默认 `http://127.0.0.1:8788`），从不直接碰线协议：发现、握手、离线补发队列全在 agentNode 里。本包做两件事 —— 把控制面投影进 DSH，再把 DSH 自己的会话/工作区状态推回去。

装完之后你得到：

- **九个 agent 工具** —— 会话里的 agent 能读节点状态、列邻居、收发消息，并把会话与工作区宣告给手机（PPE-1）。
- **一张设置卡片** —— 2026-10-14 起插件不再拥有侧栏面板，只剩 DSH 设置导航里的一张卡片：连接状态、自动宣告开关、控制面地址、访问令牌。配置一次，之后静默工作。

## 前提

插件是活的 agentNode 的客户端。两种就绪方式：

- **捎话桌面端**（推荐）—— 它由托盘原生固定监听 `127.0.0.1:8788`，没有需要人看护的进程。到捎话项目仓库获取。
- **无头 agentNode** —— 从捎话源码构建 `agentNode` 模块，以 `--http-port 8788` 运行；该监听只绑回环。

默认不需要令牌（回环被信任）。若 agentNode 以 `--token` 或 `TIDINGS_AGENT_TOKEN` 启动，请在设置卡片里录入同一个令牌；它存在 DSH 凭据库里，页面不会回显。

## 安装

作为组合包安装（安装时现场构建，见下方说明）：

```sh
dsh plugin --profile web add github:kexuejin/dsh-tidings
```

pnpm 默认拒绝执行 git 依赖的构建脚本，所以第一次 `add` 会以 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 失败。把 pnpm 打印的确切包键复制进 profile 的 `pnpm-workspace.yaml`，再执行一次 `add`：

```yaml
allowBuilds:
  dsh-tidings@git+https://github.com/kexuejin/dsh-tidings.git#<commit-sha>: true
```

请把这项授权理解为**允许该包的代码在安装时于你的机器上执行**，且不在 agent 的任何沙箱之内。建议锁定 commit（`#<sha>`），让后续推送无法悄悄改变实际运行的内容。

不想授权构建的话，就安装预构建形态 —— npm 发布物或 `pnpm pack` 的 tarball：

```sh
dsh plugin --profile web add ./dsh-tidings-0.1.0.tgz
```

开发时链接本地 checkout：

```sh
dsh plugin --profile web add link:/path/to/dsh-tidings
```

## agent 工具

| 工具 | 作用 |
| --- | --- |
| `tidings_status` | 本机节点状态：nodeId、昵称、平台、端口、邻居数与在线数。只读，只走回环。 |
| `tidings_list_peers` | 邻居列表：昵称、地址、平台、在线与否、最后活跃。 |
| `tidings_read_inbox` | 按游标增量读消息（`since` / `limit`）。 |
| `tidings_send_message` | 发一条文本；`to` 可以是昵称、IP 或 nodeId。 |
| `tidings_agent_session` | 宣告或更新 Agent 会话状态（PPE-1 §6.1）。 |
| `tidings_agent_event` | 向会话投递单调游标的结构化事件（PPE-1 §6.2）。 |
| `tidings_agent_workspace` | 宣告本机一个工作区（PPE-1 增补 D3）。 |
| `tidings_agent_grants` | 读取或修改哪些对端可见本机 agent 数据（PPE-1 增补 D7）。 |
| `tidings_announce_status` | 自动宣告器诊断：开关状态、已宣告工作区数、当前受众。只读。 |

两个使用前的关键语义：

- **`queued` 不等于已读。** `sent` 表示对方 ACK 了；`queued` 只表示对方离线、消息在补发队列里等。
- **裸 IP 要先握手。** `to` 写地址而非已知邻居时，agentNode 先发 `entry` 握手、最多等 3 秒；握不上返回 `peer-unreachable`，不会静默入队。

## 设置卡片

注册在 DSH 的 `settings.section` 槽位（id `tidings`，排序靠前）。卡片内容：

- **连接状态** —— `已连接 · <nick> · N 个邻居在线`，或检查中 / 未检测到 / 需要令牌。未连接时同时给出**原因与出路**（获取桌面端的链接），不只是一行报错。
- **高级（默认收起）** —— 自动宣告开关、控制面地址。
- **刷新 / 关闭**，以及一行保存回执。

令牌录入走凭据库；卡片只报「有没有配」。

## 配置

配置键走 DSH 插件配置（patch 层或 profile）；卡片可写的两项落 `$DSH_HOME/tidings/config-v1.json`（原子写，`0600`）。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8788` | agentNode 控制面地址。 |
| `tokenCredentialRef` | `TIDINGS_AGENT_TOKEN` | 凭据引用；没有凭据服务时回落到 `process.env`。 |
| `timeoutMs` | `8000` | 下限 1000。 |
| `defaultPort` | `17878` | `to` 是裸地址时使用。 |
| `inboxLimit` | `30` | 1–200。 |
| `autoAnnounce` | `true` | 关掉 = 纯手动模式：不注册监听、不发任何帧。 |
| `announceTargets` | `[]` | 宣告受众白名单（nodeId / IP / 昵称）。留空 = 控制面当前报出的**全部在线邻居**。 |

**隐私说明。** 默认受众下，宣告中的主机会把会话标题与工作区路径推给每个在线邻居；一台误配或陌生的设备上线时同样收得到。要收敛暴露面就填 `announceTargets`，或关掉 `autoAnnounce`。

## 仓库结构

```text
src/
  index.ts                      host 半：插件元信息、Config schema、九个工具
  tidings.ts                      agentNode 控制面 HTTP 客户端 + 令牌解析
  announce.ts                   DSH 会话/工作区的自动宣告
  session-pages.ts              会话分页入口
  session-page-responder.ts     应答手机的历史会话分页请求（PPE-1 D8）
  workspace-registry.ts         本宿主稳定的工作区与 agent 身份
  model.ts                      共享线表面：RPC 频道、endpoint、所有跨界视图
  rpc.ts                        回环 RPC 通道的 host 半（13 个 endpoint）
  config-store.ts               非机密设置的持久化
  client/
    index.ts                    browser 半：注册设置卡片与词典
    TidingsSettingsSection.tsx    卡片本体
    TidingsSettingsSection.module.css
    locales.ts                  zh / en 文案（漏一个翻译是编译错误）
    settings-slots.d.ts         本插件占用的那一席槽位的本地声明
  css-modules.d.ts / host-services.d.ts   环境声明
scripts/check-*.mjs             七条门禁（见「开发」）
check-real.mjs                  对真实 agentNode 的往返验证
docs/                           设计决策与面板原型稿（含探针脚本）
tsdown.config.ts                两套构建：host ESM（lib/）+ browser CJS loader（client/）
```

## 开发

```sh
pnpm install
pnpm run build      # lib/index.js（host ESM）+ client/client.js（browser CJS）
pnpm run typecheck  # tsconfig.host.json 与 tsconfig.client.json
pnpm run check      # typecheck + 七条门禁 + build —— CI 跑的就是这条
```

每条门禁都源于一次真实故障，头部注释里写清了是哪一次：

| 门禁 | 钉住的东西 |
| --- | --- |
| `check:inject` | `inject` 只能写宿主一定提供的基线服务。硬依赖写错会让 cordis **静默拒绝整个插件，日志里连一行都没有**。 |
| `check:announce` | 宣告记账必须问**结果**而不是意图；状态快照必须会在窗口内重申。 |
| `check:title` | 读标题必须按服务的**真实返回形状**取值；恒为 false 的守卫会让手机端满屏 session id。 |
| `check:order` | 会话顺序必须来自 DSH 自己的活动序，不是创建序。 |
| `check:activity` | 手机端排序用的活动时刻必须来自真实的用户动作。 |
| `check:visibility` | 手机上能看到的会话必须与 DSH 自己显示的口径一致（子代理会话不推）。 |
| `check:css` | CSS Module 类名两侧必须都存在 —— 拼错必须当场判红，而不是默默掉样式。 |

```sh
pnpm run check:real   # 先 build，再对真实 agentNode 打 health/peers/inbox/send
```

`check:real` 故意不进 `check`：它需要一个活着的 agentNode（用 `TIDINGS_BASE_URL` 覆盖地址）。它用的是插件生产代码里的同一个 `createTidingsClient`，因此证明的是真实代码路径在真实控制面上跑得通，而不是假壳自洽。

设计沿革在 `docs/`：2026-10-14 的面板精简决策，以及 `docs/prototype/` —— 当年用来论证信息架构的可交互原型稿，配 Chrome headless 截图脚本、几何探针与 21 张参考图。

## 许可

MIT，见 [LICENSE](LICENSE)。
