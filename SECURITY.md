# Security Policy

## 威胁模型（本插件的范围）

dsh-tidings 是**桥**，不是协议端点。它的信任边界：

1. **回环控制面** —— 插件只与 `127.0.0.1:8788`（默认）上的 agentNode 通信，不监听任何端口，不直连局域网。线协议、握手、证书与补发队列的安全属性归捎话桌面端 / agentNode。
2. **令牌** —— 访问令牌存 DSH 宿主凭据库（`tokenCredentialRef`，默认 `TIDINGS_AGENT_TOKEN`），页面与日志不回显、不落盘到设置文件。设置文件 `$DSH_HOME/tidings/config-v1.json` 只存非机密项，原子写且 `0600`。
3. **宣告即外发** —— 自动宣告（默认开）会把会话标题与工作区路径推给控制面报出的在线邻居。**这是本插件最大的暴露面**：一台陌生设备上线也会收到。收敛方式：`announceTargets` 白名单，或 `autoAnnounce: false`。
4. **不跟随重定向** —— 控制面请求遇到 3xx 一律判错，防止回环地址被引导到别处。

## 不在本插件范围内

- 捎话线协议与远场 IPv6 直连的安全问题 → 请到捎话桌面端 / agentNode 的仓库报告。
- DSH 宿主自身的安全问题 → 见 DeepSeek Harness 的安全政策。

## 支持的版本

| 版本 | 支持 |
| --- | --- |
| `main` 最新提交 | ✅ |
| 历史 tag | ❌（安全修复只打最新） |

## 报告漏洞

请**不要**开公开 issue。用 GitHub 私有安全通告（Security → Report a vulnerability）联系维护者。我们会在 5 个工作日内回复初步评估；修复发布前后会同步受影响版本与缓解措施（例如临时 `autoAnnounce: false`）。
