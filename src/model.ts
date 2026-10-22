/**
 * Shared wire surface of the 捎话 (Tidings) Tidings plugin: the loopback RPC
 * channel name, the endpoint list, and every view that crosses between the
 * Host half and the browser panel.
 *
 * Both compilation faces read this file, so nothing here may reach a Host-only
 * symbol — types and plain string constants only.
 *
 * @module dsh-tidings/model
 */

/**
 * Loopback RPC channel between the Tidings panel and the Host half. Connection
 * requires a leading slash and an unreserved name; `/api` is reserved.
 */
export const TIDINGS_RPC_CHANNEL = '/tidings-pantry'

/** Endpoints the panel may call on {@link TIDINGS_RPC_CHANNEL}. */
export type TidingsRpcEndpoint =
  | 'status'
  | 'config'
  | 'saveConfig'
  | 'saveCredential'
  | 'clearCredential'
  | 'peers'
  | 'inbox'
  | 'send'
  | 'pairingQr'
  | 'agentSessions'
  | 'agentWorkspaces'
  | 'grants'
  | 'writeGrants'

/**
 * Stable failure reasons the panel turns into localized copy. `bad-response`
 * means the control plane answered something that is not its documented JSON;
 * `internal` is any unexpected Host-side failure.
 */
export type TidingsErrorCode =
  | 'unreachable'
  | 'timeout'
  | 'unauthorized'
  | 'bad-request'
  | 'peer-unreachable'
  | 'peer-unsupported'
  | 'send-failed'
  | 'not-found'
  | 'bad-response'
  | 'internal'

/** Failure envelope of one panel call. */
export interface TidingsRpcError {
  readonly code: TidingsErrorCode
  readonly message: string
  readonly details: Readonly<Record<string, string>>
}

/** Result envelope of one panel call: exactly one of value or error. */
export type TidingsRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TidingsRpcError }

/** `GET /healthz` of the local agentNode control plane. */
export interface TidingsHealthView {
  readonly ok: boolean
  readonly nodeId: string
  readonly nick: string
  readonly platform: string
  readonly udpPort: number
  readonly httpPort: number
  readonly peers: number
  readonly online: number
  readonly pending: number
  readonly uptimeMs: number
}

/** One row of `GET /v1/peers`. */
export interface TidingsPeerView {
  /** Remote node id, or the host authority when the peer never handshook. */
  readonly nodeId: string
  readonly nick: string
  readonly host: string
  readonly udpPort?: number
  readonly tcpPort?: number
  readonly platform: string
  readonly online: boolean
  readonly lastSeen: number
  readonly profileRev?: number
}

/** One entry of `GET /v1/inbox`, flattened out of the protocol envelope. */
export interface TidingsMessageView {
  readonly seq: number
  readonly peerId: string
  /** Nick resolved from the peer list when known, otherwise the raw peer id. */
  readonly peerLabel: string
  readonly direction: 'in' | 'out'
  readonly at: number
  /** Envelope payload kind, e.g. `text`. */
  readonly kind: string
  /** Text payload; empty when the payload is not text. */
  readonly text: string
  /**
   * 注入判定（Tidings 侧给出，见捎话仓的 `AgentInboxEnricher`）。
   *
   * 没有这个键 = 这条不是给 agent 的（或者对端版本还不提供）；
   * 有键 = 这条消息 @ 到了某个 agent，可按 `boundWsId` / `requestedSessionId` 找会话。
   *
   * **刻意不做成「布尔 + 一堆默认值」**：缺键与「有键但 addressedToAgent=false」
   * 是两种不同的事实，前者是「不知道」，后者是「知道且不是」。
   */
  readonly agentHint?: TidingsAgentHint
}

/** Tidings 给出的注入判定。字段含义与捎话仓 `AgentInboxHint` 一一对应。 */
export interface TidingsAgentHint {
  readonly addressedToAgent: boolean
  /** 该 agent 绑定的工作区；缺省 = 未绑定（一等状态，不是缺失）。 */
  readonly boundWsId?: string | undefined
  /** 用户在文本里显式指定的会话；缺省 = 走默认。 */
  readonly requestedSessionId?: string | undefined
  /** 判定所依据的 agent 名字，仅用于诊断。 */
  readonly agentName?: string | undefined
  /**
   * **发送者有没有执行权**（Tidings 侧 `AgentExecAuthorizer` 的结论）。
   *
   * 由宿主侧判定 —— 它持有权威授权表（`AgentGrantStore`）。桥接侧只消费：
   * 照自己的规则再判一次会让两边对「谁算管理员」的理解分叉。
   *
   * 缺省（没这个键）= 旧版 Tidings，无法判断 ⇒ **按 false 处理**（fail-closed）。
   */
  readonly senderMayExecute?: boolean | undefined
  /** 拒绝原因（`MemberOnly` / `NotAMember` 等），仅用于日志与回话。 */
  readonly denyReason?: string | undefined
  /**
   * **投给哪个会话** —— Tidings 侧已经算好（`AgentSessionPick`）。
   *
   * 桥接侧**直接用**，不再自己判。这样「@ 到哪个 agent → 哪个工作区 → 哪个会话」这套策略
   * 只有一份实现；接一个新 agent 时不需要重写它。缺省 = 没算出可投的会话，此时不投。
   */
  readonly targetSessionId?: string | undefined
  /**
   * **这条消息是不是 agent 自己说的**（发送者是 `agent:*` 身份）。
   *
   * 回声的判据是**发送者身份**，不是方向：本机用户 @ 自己的 agent 时 `direction` 是
   * `out`，但那不是回声 —— 它是用户第一次下指令。只看方向会把这条第一条就跳过。
   *
   * 缺省（没这个键）= 旧版 Tidings ⇒ 不按回声处理（宁可投一次，也不要静默丢掉用户指令）。
   */
  readonly senderIsAgent?: boolean | undefined
}

/** `GET /v1/inbox`, with `nextSince` safe to feed back as the next `since`. */
export interface TidingsInboxView {
  readonly since: number
  readonly nextSince: number
  readonly messages: readonly TidingsMessageView[]
}

/** `POST /v1/send`. `sent` means the peer ACKed; `queued` means staged, unread. */
export interface TidingsSendReceiptView {
  readonly status: 'sent' | 'queued'
  readonly to: string
  readonly toHost: string
  readonly note: string
}

/**
 * Non-secret connection settings, editable from the panel.
 *
 * Every member is explicitly `| undefined` because this patch is spread and
 * re-persisted under `exactOptionalPropertyTypes`: a field the user cleared has
 * to travel as an absent key, and a spread of an optional member widens it to
 * `T | undefined` at the call site.
 */
export interface TidingsConfigPatch {
  readonly baseUrl?: string | undefined
  readonly tokenCredentialRef?: string | undefined
  readonly timeoutMs?: number | undefined
  readonly defaultPort?: number | undefined
  readonly inboxLimit?: number | undefined
  /**
   * 会话/工作区的自动宣告（设计文档 §2.2 的设置卡片开关）。
   *
   * 2026-10-14 补：它一直在 `Config` 里（默认 true），但**从来没进过这个 patch**，
   * 于是设置页既读不到也写不了 —— 一个能配但改不了的配置项。
   */
  readonly autoAnnounce?: boolean | undefined
  /** 自动宣告的收件人白名单；空数组 = 广播给所有在线设备。 */
  readonly announceTargets?: readonly string[] | undefined
}

/** Where the settings were persisted and what they resolve to. */
export interface TidingsConfigView {
  readonly path: string
  readonly overrides: TidingsConfigPatch
  readonly effective: TidingsConfigPatch
}

/**
 * Whether the optional control-plane token is present. The value itself never
 * crosses this surface: the Host can only report presence, source, and
 * writability.
 */
export interface TidingsCredentialView {
  readonly credentialRef: string
  readonly configured: boolean
  readonly writable: boolean
  readonly source?: string | undefined
}

/** Result of storing or clearing the token. */
export interface TidingsCredentialSavedView {
  readonly credentialRef: string
  readonly configured: boolean
}

/** How the last control-plane probe ended. */
export type TidingsConnectionState = 'online' | 'unreachable' | 'unauthorized' | 'error'

/** Panel status: the probe outcome plus the settings it was made with. */
export interface TidingsStatusView {
  readonly state: TidingsConnectionState
  readonly health?: TidingsHealthView
  readonly config: TidingsConfigView
  readonly credential: TidingsCredentialView
  readonly errorCode?: TidingsErrorCode
  readonly errorMessage?: string
}

/** Arguments of the `saveConfig` endpoint. */
export interface TidingsSaveConfigArgs {
  readonly config: TidingsConfigPatch
}

/** Arguments of the `saveCredential` and `clearCredential` endpoints. */
export interface TidingsSaveCredentialArgs {
  readonly credentialRef: string
  readonly value: string
}

/** Arguments of the `clearCredential` endpoint. */
export interface TidingsClearCredentialArgs {
  readonly credentialRef: string
}

/** Arguments of the `inbox` endpoint. */
export interface TidingsInboxArgs {
  readonly since?: number
  readonly limit?: number
}

/** Arguments of the `send` endpoint. */
export interface TidingsSendArgs {
  readonly to: string
  readonly text: string
  readonly port?: number
}

/** Arguments of `POST /v1/agent/session` (PPE-1 §6.1 + 增补 D1/D6 的四个可选键). */
export interface TidingsAgentSessionArgs {
  readonly to: string
  readonly sessionId: string
  readonly port?: number
  readonly alias?: string
  readonly agentKind?: string
  readonly state?: string
  readonly title?: string
  readonly startedAt?: number
  /** D6：agent 实例身份（同类多 agent 靠它分开；缺省退化为 agentKind）。 */
  readonly agentId?: string
  /** D1：工作区稳定 id（建议 `ws-` + 8~16 hex，别拿路径原文）。 */
  readonly wsId?: string
  /** D1：工作区展示名。 */
  readonly wsTitle?: string
  /**
   * 这条会话是**谁建出来的**：`'subagent'` = DSH 的子代理会话。
   *
   * DSH 自己的工作区浏览器对子代理会话一律隐藏
   * （`packages/client/ui-workspace/src/client/tree.ts` 的 `sessionVisible()`），
   * 手机要显示同一份清单就得拿到同一个判据 —— 标题猜不出来（子代理会话的标题
   * 是它那段 prompt 的首行）。取值不封闭，缺省 = 对端没报，不猜。
   */
  readonly origin?: string
  /** 宿主侧这条会话是不是**空壳**（建出来之后从没跑过一轮对话）。三态，缺省不猜。 */
  readonly blank?: boolean
  /** D1：工作区路径（仅详情与消歧，不进卡片主位）。 */
  readonly wsPath?: string
  /**
   * 会话的**活动时刻**（宿主时钟，epoch 毫秒）= `max(createdAt, lastPromptAt)`。
   *
   * 与 DSH 自己的会话列表同一个口径（`sessionController.list()` 的排序键），
   * 手机端拿它按「最近在动」排序 —— 界面上那句「最新活动」才有真值。
   *
   * `startedAt` 不能顶替它：那个是「会话开始时间」，实时帧里填的还是帧发出那一刻；
   * 照协议对 `at` 键的既有纪律（`docs/PROTOCOL-AGENT-WORKSPACE.md` §2.2），
   * 这类时钟键**只用于排序，不用于显示时间**。
   */
  readonly updatedAt?: number
}

/** Arguments of `POST /v1/agent/event` (PPE-1 §6.2). */
/**
 * agent-event 的可选附件元数据（task-45，cap att1）。
 *
 * **只带元数据，字节不走这里**：图片/文件的字节仍走既有文件传输路径（file-msg /
 * file-ctl）。口径与 DSH 侧 user/message 的 content 块逐字一致：
 *   { type: 'image', attachment: { attachmentId, mediaType, width, height, bytes, name } }
 *
 * 键名与顺序由 core/protocol 的 CodecAgent 定：attachmentId / mediaType / width /
 * height / bytes / name（除前两个外都可选）。**多一个键整帧拒** ⇒ 这里只放这六个。
 */
export interface TidingsAgentAttachment {
  readonly attachmentId: string
  readonly mediaType: string
  readonly width?: number
  readonly height?: number
  readonly bytes?: number
  readonly name?: string
}

export interface TidingsAgentEventArgs {
  readonly to: string
  readonly sessionId: string
  readonly cursor: number
  readonly eventType: string
  readonly port?: number
  readonly summary?: string
  readonly body?: string
  readonly ref?: string
  /**
   * 附件元数据（可选）。**带不带由宿主决定**：控制面读不到对端 caps（见 index.ts 里
   * 同一句说明），所以「只有声明 att1 的对端才收到 attachment」这条闸门在宿主控制面
   * 一侧（它按 to 解析对端、知道对方 caps）。本端把事实如实报上去。
   */
  readonly attachment?: TidingsAgentAttachment
}

/**
 * Receipt of `POST /v1/agent/session`, `POST /v1/agent/event` and
 * `POST /v1/agent/workspace`（PPE-1 增补 §2.2/§4）。
 *
 * `agent-workspace` 的 `sent` / `queued` 与另两类同义（回执里 `note` 会再说明一次：
 * 这帧不在 RELIABLE 集合里，送达与否不改变台账已记的事实）。
 */
export interface TidingsAgentReceiptView {
  /**
   * `sent` = 对端已 ACK；`queued` = 已入离线补发队列（仅指令类帧）。
   *
   * `not-acked` 只有 `agent-workspace` 会回：它在 RELIABLE 里（要进对端 inbound），
   * 但走**可靠不入队**通道 —— 对端是不认识这帧的旧版本时既不入队也不把对方标离线
   * （状态快照晚到比不到更坏）。把这一档折成 `sent` 会报告一件没发生的事。
   */
  readonly status: 'sent' | 'queued' | 'not-acked'
  readonly to: string
  readonly type: 'agent-session' | 'agent-event' | 'agent-workspace'
  readonly note: string
}

/**
 * `GET /v1/pairing-qr`: the public-tidings pairing code, already encoded.
 *
 * `modules` is row-major: `dark(x, y) = modules[y * size + x]`. The Host half
 * feeds it in that order so the browser half never has to transpose.
 *
 * ⚠️ `payload` **carries the control-plane token**. It exists so a phone can be
 * paired with one scan instead of hand-copying a URL and a secret, and the
 * price is that this code *is* a credential: anything that photographs,
 * screenshots or forwards it hands out the token. Treat this view as secret —
 * never log it, never put it in a screenshot artifact.
 */
export interface TidingsPairingQrView {
  /** The encoded text. Contains `token` when the node requires one. */
  readonly payload: string
  readonly version: number
  readonly size: number
  readonly mask: number
  /** Row-major `size * size` dark-module flags. */
  readonly modules: readonly boolean[]
  readonly needsToken: boolean
}

/**
 * The control plane refused to encode because its payload would not fit.
 * `payload` is still returned so the panel can fall back to showing the raw
 * text: a truncated-but-scannable code would be worse than no code.
 */
export interface TidingsPairingQrTooLongView {
  readonly tooLong: true
  readonly payload: string
  readonly bytes: number
  readonly capacity: number
}

/** The control plane has no public URL configured, so no code can be made. */
export interface TidingsPairingQrMissingView {
  readonly configured: false
  readonly reason: string
}

/** What `pairingQr` answers with: a code, a too-long fallback, or a reason. */
export type TidingsPairingQrResult =
  | ({ readonly kind: 'code' } & TidingsPairingQrView)
  | ({ readonly kind: 'tooLong' } & TidingsPairingQrTooLongView)
  | ({ readonly kind: 'missing' } & TidingsPairingQrMissingView)

/**
 * One agent session (PPE-1 §6.1) as the local agentNode remembers it.
 *
 * This is the **node's** ledger, not the client's: it holds only sessions this
 * node announced or received since the node started. The desktop/mobile client
 * keeps the durable copy in its own database, so a session missing here is not
 * evidence it never existed — it may just predate the node's restart.
 */
export interface TidingsAgentSessionView {
  /** The peer the session belongs to. */
  readonly nodeId: string
  readonly sessionId: string
  readonly alias?: string | undefined
  readonly agentKind?: string | undefined
  readonly state?: string | undefined
  readonly title?: string | undefined
  readonly startedAt?: number | undefined
  /** PPE-1 增补 D1/D6 的四个可选键（对端没上报 = 键缺失）。 */
  readonly agentId?: string | undefined
  readonly wsId?: string | undefined
  readonly wsTitle?: string | undefined
  readonly wsPath?: string | undefined
  /** This node announced the session outbound. */
  readonly announcedOut: boolean
  /** This node received the announcement from the peer. */
  readonly announcedIn: boolean
  readonly updatedAt: number
  readonly eventCount: number
}

/** One agent event (PPE-1 §6.2); `cursor` is monotonic within its session only. */
export interface TidingsAgentEventView {
  readonly nodeId: string
  readonly sessionId: string
  readonly cursor: number
  readonly eventType: string
  readonly summary?: string | undefined
  readonly body?: string | undefined
  readonly ref?: string | undefined
  readonly at: number
}

/**
 * One pending `agent-session-page` request (PPE-1 增补 D8), as the node's
 * `GET /v1/agent/session-pages` reports it. The host answers it out of band by
 * sending ordinary `agent-session` frames — there is no reply frame.
 */
export interface TidingsSessionPageRequestView {
  readonly id: number
  readonly nodeId: string
  readonly wsId: string
  readonly offset: number
  readonly limit?: number | undefined
  readonly at: number
}

/** What that endpoint answers with. */
export interface TidingsSessionPagesView {
  readonly requests: readonly TidingsSessionPageRequestView[]
  readonly total: number
}

/** What `agentSessions` answers with: the ledger, plus events when one id was asked for. */
export interface TidingsAgentSessionsView {
  readonly sessions: readonly TidingsAgentSessionView[]
  /** Present only when the call named one `sessionId`. */
  readonly events?: readonly TidingsAgentEventView[] | undefined
  readonly total: number
}

/** Arguments of `POST /v1/agent/workspace` (PPE-1 增补 §2.2, D3). */
export interface TidingsAgentWorkspaceArgs {
  readonly to: string
  /** 增补 §2.2：必填；缺失时控制面直接 400。 */
  readonly wsId: string
  readonly port?: number
  readonly wsTitle?: string
  readonly wsPath?: string
  /**
   * D6 的 agent 实例身份；与会话帧的 `agentId` 同键同义。
   *
   * 它决定手机端的归组键（`agentId ?? agentKind`）。会话侧报了 agentId 而这里不报，
   * 同一个工作区会在手机上被拆成两行（单 agent 宿主就中招，2026-10-14 实测判红）。
   */
  readonly agentId?: string
  /** 该工作区**主要**类型（开放取值，不是模型名，§3.1）。 */
  readonly agentKind?: string
  /** 宿主自报的在线事实；控制面对非布尔字面量回 400（出站收紧）。 */
  readonly online?: boolean
  /** 宿主自报的会话数；手机端自己数的优先。 */
  readonly sessionCount?: number
  /** 宿主时钟；只用于排序，不用于显示时间（与 agent-event.at 同规矩）。 */
  readonly at?: number
  /**
   * DSH 注册表里的**持久顺序**（0 起）：位置即 DSH 工作区浏览器的分组顺序。
   *
   * 与 `at` 同一条纪律：只用于排序，不用于显示时间。为什么必须显式送 —— 手机端把工作区
   * 落库后 `ORDER BY updated_at DESC` 会把到达序打乱，而到达序恰好就是注册表序。
   * 只靠到达序，重启一次用户在 DSH 里手工拖过的顺序就丢了。
   */
  readonly order?: number
}

/**
 * One row of `GET /v1/agent/workspaces` (PPE-1 增补 §4 的「面板第三面」)。
 *
 * `agentKey` 是接收端算出的身份键 `agentId ?? agentKind`（增补 D6），台账里可能为
 * null；本视图把它折成「键缺失 = 未上报」的缺省语义，与原样印 `null` 等效且不再
 * 让面板自己处理空串。`online` / `sessionCount` 是宿主自报的可选事实：键缺失就是
 * 「对方没上报」，不是 false / 0 —— 与 `TidingsAgentSessionView` 的可选键同一纪律。
 */
export interface TidingsWorkspaceView {
  /** 台账归属的节点：出站 = 目标，入站 = `envelope.from`（增补 §1 末条）。 */
  readonly nodeId: string
  /** 归组键 = `agentId ?? agentKind`（派生物；null 时宿主没报身份）。 */
  readonly agentKey?: string | undefined
  /** D6 的 agent 实例身份原值。 */
  readonly agentId?: string | undefined
  readonly wsId: string
  readonly wsTitle?: string | undefined
  readonly wsPath?: string | undefined
  readonly agentKind?: string | undefined
  readonly online?: boolean | undefined
  readonly sessionCount?: number | undefined
  readonly updatedAt: number
}

/** Arguments of `GET /v1/agent/workspaces`. */
export interface TidingsAgentWorkspacesArgs {
  /** 收窄到一个节点；空串按「不过滤」处理（与 `agentSessions` 的参数纪律一致）。 */
  readonly nodeId?: string
}

/** What `agentWorkspaces` answers with: the workspace ledger. */
export interface TidingsAgentWorkspacesView {
  readonly workspaces: readonly TidingsWorkspaceView[]
  readonly total: number
}

/** 授权策略取值（PPE-1 增补 §3.3, D7：`AgentGrantPolicies`）。 */
export type TidingsGrantPolicy = 'auto' | 'byDevice' | 'request'

/** 授权粒度取值（增补 §3.3：`AgentGrantScopes`，all = 整台设备）。 */
export type TidingsGrantScope = 'all' | 'agent'

/** 回执状态取值（增补 §3.3：`AgentGrantStates`；撤销不回收历史）。 */
export type TidingsGrantState = 'approved' | 'denied' | 'revoked'

/** One row of the grant whitelist (`GET /v1/agent/grants`). */
export interface TidingsGrantView {
  readonly nodeId: string
  readonly scope: TidingsGrantScope
  /** scope=agent 时的身份键 `agentId ?? agentKind`；scope=all 时缺失。 */
  readonly agentKey?: string | undefined
  readonly grantedAt: number
  /** 谁批的（桌面端写入）；缺失 = 没记录。 */
  readonly grantedBy?: string | undefined
}

/** One pending grant request (`GET /v1/agent/grants`). */
export interface TidingsGrantRequestView {
  readonly nodeId: string
  /** 缺失 = 申请整台设备（增补 §3.3 的 `agentKey?`）。 */
  readonly agentKey?: string | undefined
  readonly reason?: string | undefined
  readonly at: number
}

/** What `grants` answers with: the policy, the whitelist, and the pending requests. */
export interface TidingsGrantsView {
  readonly policy: TidingsGrantPolicy
  readonly grants: readonly TidingsGrantView[]
  readonly requests: readonly TidingsGrantRequestView[]
}

/** One grant / revoke entry of a `PUT /v1/agent/grants` body (增补 §3.3). */
export interface TidingsGrantWriteEntry {
  readonly nodeId: string
  readonly scope: TidingsGrantScope
  readonly agentKey?: string
  /** 仅 `grant`：谁批的记录，落进 grants 行。 */
  readonly grantedBy?: string
}

/** 批准/拒绝一条申请：把决定**回给设备**（`agent-grant` 帧），对面四档状态才走得动。 */
export interface TidingsGrantReplyEntry {
  readonly nodeId: string
  readonly state: TidingsGrantState
  readonly scope: TidingsGrantScope
  readonly agentKey?: string
}

/** Arguments of the `writeGrants` endpoint (`PUT /v1/agent/grants`). */
export interface TidingsGrantsWriteArgs {
  readonly policy?: TidingsGrantPolicy
  readonly grant?: TidingsGrantWriteEntry
  readonly revoke?: TidingsGrantWriteEntry
  readonly grantReply?: TidingsGrantReplyEntry
}

/**
 * Arguments of the `tidings_agent_grants` tool.
 *
 * Deliberately **not** the same shape as {@link TidingsGrantsWriteArgs}: the tool
 * takes an `action` discriminator so one tool can read and write, while the
 * client method stays a pure PUT body. Keeping them apart means the tool cannot
 * silently send a body the control plane will reject (e.g. `grant` without
 * `nodeId`) — the tool validates the branch it picked before building a body.
 */
export interface TidingsAgentGrantArgs {
  readonly action?: 'get' | 'policy' | 'grant' | 'revoke' | 'grantReply'
  readonly policy?: TidingsGrantPolicy
  readonly nodeId?: string
  readonly scope?: TidingsGrantScope
  readonly agentKey?: string
  readonly state?: TidingsGrantState
  readonly grantedBy?: string
}

/** What `writeGrants` answers with: the policy now in force plus what happened. */
export interface TidingsGrantsWriteView {
  readonly ok: boolean
  readonly policy: TidingsGrantPolicy
  readonly notes: readonly string[]
}

/** Value type returned by each endpoint. */
export interface TidingsRpcResultMap {
  readonly status: TidingsStatusView
  readonly config: TidingsConfigView
  readonly saveConfig: TidingsConfigView
  readonly saveCredential: TidingsCredentialSavedView
  readonly clearCredential: TidingsCredentialSavedView
  readonly peers: readonly TidingsPeerView[]
  readonly inbox: TidingsInboxView
  readonly send: TidingsSendReceiptView
  readonly pairingQr: TidingsPairingQrResult
  readonly agentSessions: TidingsAgentSessionsView
  readonly agentWorkspaces: TidingsAgentWorkspacesView
  readonly grants: TidingsGrantsView
  readonly writeGrants: TidingsGrantsWriteView
}
