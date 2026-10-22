/**
 * 捎话 (Tidings) Tidings plugin, Host half.
 *
 * Exposes the local `agentNode` control plane to the agent as tools and mounts
 * the loopback RPC channel the browser panel reads. The plugin speaks only the
 * node's HTTP control plane — never the 捎话 UDP/TCP protocol.
 *
 * @module dsh-tidings
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { runInjectionRound, type TidingsInjectionLoopDeps } from './inject-loop.ts'
import type { AgentsServiceLike } from './inject.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createTidingsClient, type Config as TidingsConfig } from './tidings.ts'
import { TidingsConfigStore } from './config-store.ts'
import { registerTidingsRpc, tidingsRpcCalls } from './rpc.ts'
import { SessionAnnouncer } from './announce.ts'
import { SessionPageResponder } from './session-page-responder.ts'
import { TidingsWorkspaceRegistry } from './workspace-registry.ts'
import type {
  TidingsAgentEventArgs,
  TidingsAgentGrantArgs,
  TidingsAgentSessionArgs,
  TidingsAgentWorkspaceArgs,
  TidingsInboxArgs,
  TidingsSendArgs,
} from './model.ts'

export type * from './model.ts'
export { createTidingsClient, internals, resolveConfig } from './tidings.ts'
export { sanitizeTidingsConfigPatch, TidingsConfigStore } from './config-store.ts'
export { TIDINGS_RPC_CHANNEL } from './model.ts'
export { registerTidingsRpc } from './rpc.ts'
export { SessionAnnouncer } from './announce.ts'
export { SessionPageResponder } from './session-page-responder.ts'
export type { SessionPageEntry, SessionPageProvider, SessionPageResult } from './session-pages.ts'
export { TidingsWorkspaceRegistry, workspaceIdOf, workspaceTitleOf } from './workspace-registry.ts'

export const name = 'tidings-pantry'
/**
 * `tools` for the tools below; `connection` for the panel RPC channel.
 *
 * **不注入 `sessions`**：自动宣告订阅的是 `session/created` / `session/event` 两个
 * **全局事件**（`{ global: true }`），事件系统是 cordis 自带能力，不需要上层的
 * sessions 服务。多声明一个依赖就要多处理一种缺失形态，收益为零。
 */
/**
 * Services this half requires.
 *
 * ## 只列**一定在**的服务（2026-10-14 修一个严重回归）
 *
 * `inject` 是**硬依赖**：声明了一个宿主没提供的服务，cordis 会**拒绝加载整个插件** ——
 * 而且日志里连一行都没有（表现为：插件的工具不见了、面板空了、没有任何报错可查）。
 *
 * 我一度把 `workspaceRegistry` / `sessionController` 也写进来，而它们由
 * `@deepseek-ai/dsh-workspace` / `dsh-session-controller` 提供 —— 本机 web profile 的
 * node_modules 里**没有**这两个包，于是整个插件被静默拒绝加载（真机症状：宿主进程没有
 * 任何到 8788 的连接、节点台账永远为空）。
 *
 * 正解：它们改走**运行时可选读取**（`ctx.get(...)`），拿不到就退回插件自己的台账 ——
 * 这正是 `dshWorkspaces` 那条回退路径本来要处理的场景。
 */
export const inject = ['tools', 'connection']

export interface Config extends TidingsConfig {}

/**
 * The plugin's configuration schema.
 *
 * Every field carries a default, so the schema's *output* is fully populated
 * while {@link Config} — the shape `apply` accepts and callers write — is
 * deliberately all-optional. The cast keeps the runtime schema (which the Host
 * validates against) without pretending the two types are the same; with
 * `exactOptionalPropertyTypes` the annotation cannot be written directly.
 */
export const Config = z.object({
  baseUrl: z.string().default('http://127.0.0.1:8788'),
  tokenCredentialRef: z.string().role('credential-ref').default('TIDINGS_AGENT_TOKEN'),
  timeoutMs: z.number().step(1).min(1000).default(8000),
  defaultPort: z.number().step(1).min(1).max(65535).default(17878),
  inboxLimit: z.number().step(1).min(1).max(200).default(30),
  /**
   * 会话开始/推进时自动把 DSH 会话宣告给本机 agentNode（PPE-1 §6.1/§6.2）。
   *
   * 默认开：手动 `tidings_agent_session` 工具要求调用方每轮记得调一次，
   * 而"忘了调"的表现是手机上一片空白 —— 那正是这套协议要解决的场景。
   * 关掉它 = 退回纯手动模式（不注册任何监听、不发任何帧）。
   */
  autoAnnounce: z.boolean().default(true),
  /**
   * 自动宣告的收件人白名单（nodeId / IP / 昵称）。留空 = 发给控制面报出的**在线**邻居。
   *
   * 为什么要有这一项：默认受众是"此刻在线的所有邻居"，而一台误配/陌生的设备上线时
   * 也会收到本机的会话标题与工作区路径（父稿把 path 列为隐私字段的同一顾虑）。
   * 要收敛暴露面就填这里。
   */
  announceTargets: z.array(z.string()).default([]),
}) as unknown as z<Config>

const JSON_OUTPUT = { schema: { type: 'json' } } as const

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function textResult(text: string): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text }]
}

function jsonObject(value: JsonValue | undefined): { readonly [key: string]: JsonValue } | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function jsonArray(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : []
}

function jsonString(value: JsonValue | undefined, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback
}

function jsonNumber(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * **读 DSH 的权威会话标题**（侧边栏那个「会话页体验问题」）。
 *
 * ## 为什么必须是主动读，不能等事件
 *
 * `session/title` 是 **log-only** 记录（`packages/core/session/src/surface.ts` 的
 * `not surface-eligible`）——它根本不进 surface 流，所以 `session/event` 订阅永远等不到。
 * `titleFrom()` 之所以拿「第一条用户消息」当标题，正是因为这个：那段注释也写着
 * `Host titles live in a session/title event that this plugin does not subscribe to`。
 *
 * 而 service 的 `get(session)` 可以主动读，返回 `{ title, eventSeq, updatedAt }`。
 *
 * ## 为什么每个字段都要容错
 *
 * 插件要在**任何**宿主上照常工作：没装这个服务、服务抛错、标题还没生成 —— 三种情况
 * 都必须安静地返回 undefined，让上层退回「第一条用户消息」。**一个标题拿不到，不该让
 * 整条宣告断掉。**
 */
function readHostTitle(ctx: Context, session: unknown): string | undefined {
  const service = ctx.get('sessionTitle') as
    | { get?: (s: unknown) => { title?: string } | undefined }
    | undefined
  const snapshot = service?.get?.(session)
  const title = snapshot?.title?.trim()
  return title !== undefined && title.length > 0 ? title : undefined
}
/**
 * RPC 通道是否已挂上（诊断用）。
 *
 * 为什么要有它：挂载点在 `ctx.inject(['connection','webServer'], ...)` 的回调里 ——
 * 那个回调**依赖就绪才触发**，所以「代码写了」不等于「通道挂上了」。而挂不上的症状是
 * 浏览器那条请求永远 pending、卡片永远停在「检查中…」（2026-10-15 真机抓到）。
 * 这个标志让 `tidings_announce_status` 能直接回答「挂上了没有」。
 */
let rpcMounted = 'not-yet'

export function apply(ctx: Context, config: Config = {}): void {
  const store = new TidingsConfigStore(config)
  // ## RPC 通道必须在**web 上下文就绪后**才挂（2026-10-14 真机抓到：卡片永远停在「检查中…」）
  //
  // 原先这里直接 `registerTidingsRpc(ctx, store)`。看起来对（`inject` 里声明了 connection），
  // 但**挂载时机不对**：web 半的 RPC 前缀路由是随 `webServer` 起来的，apply 阶段那个
  // connection 座还没有可挂的载体。后果：浏览器发出的 `POST /tidings-pantry/status`
  // 进了服务端却**永远没有响应**（用调试面板看该请求一直是 `pending`），卡片于是永远
  // 停在「检查中…」，而屏幕上没有一句话说为什么。
  //
  // 判据：**通道的挂载点要跟它的宿主服务对齐**。本仓现在按参考实现（dsh-mnemon）的写法，
  // 在 `ctx.inject(['connection','webServer'], ...)` 里挂 —— 那才是「web 通道已能路由」的
  // 那一刻。
  ctx.inject(['connection', 'webServer'], (webCtx: Context) => {
    // ## 为什么要把这条 inject 的结果记下来（2026-10-15 真机抓到）
    //
    // 回调里的任何一步抛异常都会被 cordis 记成一条 warn，而**宿主不落盘那些行** ——
    // 于是「通道没挂上」在外部完全不可见：浏览器那条请求永远 pending、卡片永远停在
    // 「检查中…」。所以这里把成功与失败**都**记成一个可被诊断工具读到的字符串：
    // `rpcMounted` = 'ok' / '抛了：<原因>'。
    try {
      registerTidingsRpc(webCtx, store)
      rpcMounted = 'ok'
    } catch (error) {
      rpcMounted = `failed: ${messageOf(error)}`
    }
  })

  ctx.tools.register(defineTool({
    name: 'tidings_status',
    description: [
      '读取本机捎话（Tidings）agentNode 的状态：节点 ID、昵称、平台、监听端口、邻居数量与在线数量。',
      '只读；数据来自本机回环控制面，不会向局域网发送任何报文。',
    ].join(' '),
    parameters: {},
    output: {
      ...JSON_OUTPUT,
      render: (_args, value) => {
        const object = jsonObject(value)
        return textResult(
          `捎话节点 ${jsonString(object?.nodeId, '未知')}（${jsonString(object?.nick, '未命名')}）在线邻居 ${String(jsonNumber(object?.online, 0))}/${String(jsonNumber(object?.peers, 0))}。`,
        )
      },
    },
    async execute() {
      return asJson(await createTidingsClient(ctx, store.current()).health())
    },
    presentCall: () => ({ card: 'generic', title: '读取捎话节点状态', kind: 'other', rawInput: {} }),
  }))

  ctx.tools.register(defineTool({
    name: 'tidings_list_peers',
    description: [
      '列出本机捎话（Tidings）agentNode 已发现的邻居节点：节点 ID、昵称、地址、端口、平台与在线状态。',
      '只读。尚未完成握手的邻居不会出现在列表里。',
    ].join(' '),
    parameters: {},
    output: {
      ...JSON_OUTPUT,
      render: (_args, value) => {
        const peers = jsonArray(value)
        const online = peers.filter(peer => jsonObject(peer)?.online === true).length
        return textResult(`捎话邻居：共 ${String(peers.length)} 个，其中 ${String(online)} 个在线。`)
      },
    },
    async execute() {
      return asJson(await createTidingsClient(ctx, store.current()).peers())
    },
    presentCall: () => ({ card: 'generic', title: '列出捎话邻居', kind: 'other', rawInput: {} }),
  }))

  ctx.tools.register(defineTool({
    name: 'tidings_read_inbox',
    description: [
      '读取本机捎话（Tidings）agentNode 的收发消息记录。',
      'since 为毫秒时间戳且左开右闭地排除该时刻本身；把上次返回的 nextSince 原样传回即可无重复地续读。只读。',
    ].join(' '),
    parameters: {
      since: { type: 'number', description: '起始毫秒时间戳（不包含该时刻本身）。省略或传 0 表示从头读取。' },
      limit: { type: 'number', description: '最多返回多少条最新消息，受插件配置上限约束。' },
    },
    output: {
      ...JSON_OUTPUT,
      render: (_args, value) => {
        const object = jsonObject(value)
        const count = jsonArray(object?.messages).length
        return textResult(`捎话消息：返回 ${String(count)} 条，下次 since=${String(jsonNumber(object?.nextSince, 0))}。`)
      },
    },
    async execute(args: TidingsInboxArgs) {
      return asJson(await createTidingsClient(ctx, store.current()).inbox(args))
    },
    presentCall: args => ({ card: 'generic', title: '读取捎话消息', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'tidings_send_message',
    description: [
      '通过本机捎话（Tidings）agentNode 向一个邻居发送一条文本消息。',
      'to 可以是邻居昵称、IP 或节点 ID；port 省略时使用插件配置的默认端口。',
      'status 为 sent 表示对方已确认收到，queued 表示对方当前离线、消息已暂存但尚未被读取。',
    ].join(' '),
    parameters: {
      to: { type: 'string', description: '收件人：邻居昵称、IP 地址或节点 ID。' },
      text: { type: 'string', description: '要发送的文本内容。' },
      port: { type: 'number', description: '对方控制端口，省略时使用默认端口。' },
    },
    output: {
      ...JSON_OUTPUT,
      render: (_args, value) => {
        const object = jsonObject(value)
        const status = jsonString(object?.status, 'unknown')
        return textResult(
          status === 'queued'
            ? `消息已暂存：${jsonString(object?.to, '未知节点')} 当前离线，上线上线后才会送达。`
            : `消息已送达：${jsonString(object?.to, '未知节点')}（${jsonString(object?.toHost, '未知地址')}）。`,
        )
      },
    },
    async execute(args: TidingsSendArgs) {
      return asJson(await createTidingsClient(ctx, store.current()).send(args))
    },
    presentCall: args => ({ card: 'generic', title: '发送捎话消息', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'tidings_agent_session',
    description: [
      '通过本机捎话（Tidings）agentNode 宣告一个 Agent 会话或更新其状态（PPE-1 §6.1）。',
      'to 为对端邻居昵称、IP 或节点 ID；sessionId 为会话唯一标识。',
      'state 可取 busy / idle / done 等；只有在对端支持 agn1 能力时才能发送。',
    ].join(' '),
    parameters: {
      to: { type: 'string', description: '收件人：邻居昵称、IP 地址或节点 ID。' },
      sessionId: { type: 'string', description: '会话唯一标识符。' },
      alias: { type: 'string', description: 'Agent 别名，用于客户端展示。' },
      agentKind: { type: 'string', description: 'Agent 宿主/驱动类型（DSH / codex / opencode…，不是模型名）。' },
      state: { type: 'string', description: '会话状态（如 busy、idle、done）。' },
      title: { type: 'string', description: '会话标题或当前任务概述。' },
      port: { type: 'number', description: '对方控制端口，省略时使用默认端口。' },
      agentId: { type: 'string', description: 'PPE-1 增补 D6：agent 实例身份（同类多 agent 靠它分开；缺省退化为 agentKind）。' },
      wsId: { type: 'string', description: 'PPE-1 增补 D1：工作区稳定 id（建议 ws- + 8~16 hex，别拿路径原文当 id）。' },
      wsTitle: { type: 'string', description: 'PPE-1 增补 D1：工作区展示名（缺省时 UI 不猜路径末段）。' },
      wsPath: { type: 'string', description: 'PPE-1 增补 D1：工作区路径，仅详情与消歧用。' },
    },
    output: {
      ...JSON_OUTPUT,
      render: (_args, value) => {
        const object = jsonObject(value)
        return textResult(
          `Agent 会话已发送：${jsonString(object?.to, '未知节点')}（${jsonString(object?.status, 'unknown')}）。`,
        )
      },
    },
    async execute(args: TidingsAgentSessionArgs) {
      return asJson(await createTidingsClient(ctx, store.current()).agentSession(args))
    },
    presentCall: args => ({ card: 'generic', title: '宣告 Agent 会话', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'tidings_agent_event',
    description: [
      '通过本机捎话（Tidings）agentNode 追加一条结构化事件到正在进行的 Agent 会话（PPE-1 §6.2）。',
      'cursor 为会话内递增的单调游标整数；eventType 为事件类型（如 session.started, tool.started, message.delta）。',
    ].join(' '),
    parameters: {
      to: { type: 'string', description: '收件人：邻居昵称、IP 地址或节点 ID。' },
      sessionId: { type: 'string', description: '所属会话唯一标识符。' },
      cursor: { type: 'number', description: '单调递增游标整数（从 1 开始）。' },
      eventType: { type: 'string', description: '事件类型（如 tool.started, tool.finished）。' },
      summary: { type: 'string', description: '事件概要单行文本。' },
      body: { type: 'string', description: '事件详情或日志正文。' },
      ref: { type: 'string', description: '引用的工具或任务引用标识。' },
      port: { type: 'number', description: '对方控制端口，省略时使用默认端口。' },
    },
    output: {
      ...JSON_OUTPUT,
      render: (_args, value) => {
        const object = jsonObject(value)
        return textResult(
          `Agent 事件已投递：${jsonString(object?.to, '未知节点')}（${jsonString(object?.status, 'unknown')}）。`,
        )
      },
    },
    async execute(args: TidingsAgentEventArgs) {
      return asJson(await createTidingsClient(ctx, store.current()).agentEvent(args))
    },
    presentCall: args => ({ card: 'generic', title: '追加 Agent 事件', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'tidings_agent_workspace',
    description: [
      '宣告本宿主的一个工作区（PPE-1 增补 D3，cap aws1）。',
      '与会话帧的分工：会话帧只能表达「会话带着工作区身份来」，这帧能表达',
      '「工作区已经存在、但还没有任何会话」——手机端就是靠它画出空工作区行。',
      '改名 / 新增 / 移除时重发；对端版本不认识这帧时不会被 ACK，也不会把对方标成离线。',
    ].join(' '),
    parameters: {
      to: { type: 'string', description: '收件人：邻居昵称、IP 地址或节点 ID。' },
      wsId: { type: 'string', description: '工作区稳定 id（建议 ws- + 8~16 hex，别拿路径原文当 id）。' },
      wsTitle: { type: 'string', description: '工作区展示名（缺省时 UI 不猜路径末段）。' },
      wsPath: { type: 'string', description: '工作区路径，仅详情与消歧用。' },
      agentId: { type: 'string', description: 'agent 实例身份（与会话帧同键，决定手机端归组）。' },
      agentKind: { type: 'string', description: 'agent 宿主/驱动类型（DSH / codex / opencode…，不是模型名）。' },
      online: { type: 'boolean', description: '宿主此刻在不在这个工作区里活着（缺省 = 没报）。' },
      sessionCount: { type: 'number', description: '宿主自报的会话数（手机端自己数的优先）。' },
      port: { type: 'number', description: '对方控制端口，省略时使用默认端口。' },
    },
    output: {
      ...JSON_OUTPUT,
      render: (_args, value) => {
        const object = jsonObject(value)
        return textResult(
          `工作区已宣告：${jsonString(object?.wsId, '未知工作区')} → ${jsonString(object?.to, '未知节点')}（${jsonString(object?.status, 'unknown')}）。`,
        )
      },
    },
    async execute(args: TidingsAgentWorkspaceArgs) {
      return asJson(await createTidingsClient(ctx, store.current()).agentWorkspace(args))
    },
    presentCall: args => ({ card: 'generic', title: '宣告工作区', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'tidings_agent_grants',
    description: [
      '读或改本宿主的 agent 授权（PPE-1 增补 D7，cap agr1）。',
      '分工（父稿 §3.3）：决定在桌面端（这里）、执行在宿主进程——本工具写下的策略与白名单',
      '由 agentNode 在投递前过滤，没授权就等于没数据。三档策略：auto（默认，任何已添加节点',
      '可见全部 agent）/ byDevice（per-节点白名单，缺省拒绝）/ request（未授权设备可申请，等你批）。',
      '两条诚实边界：撤销不回收已经送达对方的数据（只拦未来投递）；沉默 ≠ 拒绝。',
      'action=get 读策略/白名单/待办申请；policy 改档；grant 批准；revoke 撤销；grantReply 回决定。',
    ].join(' '),
    parameters: {
      action: { type: 'string', description: 'get | policy | grant | revoke | grantReply。' },
      policy: { type: 'string', description: 'auto | byDevice | request（action=policy 时必填）。' },
      nodeId: { type: 'string', description: '目标设备节点 ID（grant / revoke / grantReply 时必填）。' },
      scope: { type: 'string', description: 'all（整台设备）| agent（单个 agent）。' },
      agentKey: { type: 'string', description: 'scope=agent 时的 agent 身份键（agentId ?? agentKind）。' },
      state: { type: 'string', description: 'grantReply 用：approved | denied | revoked。' },
      grantedBy: { type: 'string', description: '谁批的（写进台账，便于日后审计）。' },
    },
    output: {
      ...JSON_OUTPUT,
      render: (_args, value) => {
        const object = jsonObject(value)
        const policy = jsonString(object?.policy, '?')
        const grants = Array.isArray(object?.grants) ? object?.grants.length : 0
        const requests = Array.isArray(object?.requests) ? object?.requests.length : 0
        return textResult(`策略 ${policy}；生效授权 ${grants} 条；待办申请 ${requests} 条。`)
      },
    },
    async execute(args: TidingsAgentGrantArgs) {
      const client = createTidingsClient(ctx, store.current())
      if (args.action === undefined || args.action === 'get') return asJson(await client.grants())
      if (args.action === 'policy') {
        if (args.policy === undefined) throw new Error('action=policy 需要 policy（auto | byDevice | request）')
        return asJson(await client.writeGrants({ policy: args.policy }))
      }
      if (args.action === 'grant') {
        if (args.nodeId === undefined) throw new Error('action=grant 需要 nodeId')
        return asJson(await client.writeGrants({
          grant: {
            nodeId: args.nodeId,
            scope: args.scope ?? 'all',
            ...args.agentKey === undefined ? {} : { agentKey: args.agentKey },
            ...args.grantedBy === undefined ? {} : { grantedBy: args.grantedBy },
          },
        }))
      }
      if (args.action === 'revoke') {
        if (args.nodeId === undefined) throw new Error('action=revoke 需要 nodeId')
        return asJson(await client.writeGrants({
          revoke: {
            nodeId: args.nodeId,
            scope: args.scope ?? 'all',
            ...args.agentKey === undefined ? {} : { agentKey: args.agentKey },
          },
        }))
      }
      if (args.nodeId === undefined || args.state === undefined) {
        throw new Error('action=grantReply 需要 nodeId 与 state（approved | denied | revoked）')
      }
      return asJson(await client.writeGrants({
        grantReply: {
          nodeId: args.nodeId,
          scope: args.scope ?? 'all',
          state: args.state,
          ...args.agentKey === undefined ? {} : { agentKey: args.agentKey },
        },
      }))
    },
    presentCall: args => ({ card: 'generic', title: 'Agent 授权', kind: 'other', rawInput: args }),
  }))

  // ------------------------------------------------------------------ 自动宣告
  //
  // 手动工具的缺口很具体：调用方每轮都得记得调 tidings_agent_session，而「忘了调」的表现
  // 是手机上一片空白 —— 那正是这套协议要解决的场景。所以这里订阅宿主的会话生命周期自动投递。
  //
  // 三条纪律，逐条都有理由：
  // 1. 绝不影响宿主：每个回调整体包在 try/catch 里，失败只 warn 一行。tidings 是加装能力，
  //    不能因为节点没起或网络不通把会话创建拖垮（session/created 的监听器抛异常会
  //    回滚会话创建，这是文档明写的语义）。
  // 2. 默认受众是在线邻居（可用 announceTargets 收敛）：控制面读不到对端 caps，
  //    只能发出去、失败就丢；cap 门控在 agentNode 投递层。
  // 3. 关掉 autoAnnounce 就一个监听器都不注册 —— 不是「注册了但内部 return」。
  const workspaceRegistry = new TidingsWorkspaceRegistry(join(dshHome(), 'tidings'))
  const announcer = config.autoAnnounce === false
    ? undefined
    : new SessionAnnouncer({
        ctx,
        client: () => createTidingsClient(ctx, store.current()),
        registry: workspaceRegistry,
        config: () => store.current(),
        // DSH 自己的权威工作区台账（一个用户真正用过的工作区全集，带 title 与会话数）。
        // 插件自己那份只记「会话正跑在哪」，所以不接这个来源时手机上只看得到最近几条。
        // 容错：服务没装、或 list() 抛错，都退回 registry.known()（见 announce.ts 里那条）。
        dshWorkspaces: () => {
          try {
            // `ctx.get` 而不是 `ctx.workspaceRegistry`：这个服务可能不在本 profile 里
            // （见 inject 的 KDoc —— 它写进 inject 会让整个插件加载失败）。
            const registry = ctx.get('workspaceRegistry') as
                | { list(): readonly { readonly path: string; readonly title: string; readonly sessionIds: readonly string[] }[] }
                | undefined
            if (registry === undefined) return undefined
            // `list()` 的**下标就是 DSH 的分组顺序**（packages/workspace/workspace 的
            // `list()` 按 durable 注册表序返回，用户可以手工拖动改它）。手机上要复现这个
            // 顺序，就必须把它作为一个显式字段送出去 —— 手机把工作区落库后那条
            // `ORDER BY updated_at DESC` 会把到达序打乱。
            //
            // `sessionIds` 也一样：那才是 DSH 认可的**成员账**，不是「cwd 匹配的全部会话」。
            // 真机上 teahouse-mobile 台账 39 条、cwd 匹配 408 条，按后者发手机就多一大截。
            return registry.list().map((workspace, order) => ({
              path: workspace.path,
              title: workspace.title,
              sessionCount: workspace.sessionIds.length,
              order,
              sessionIds: workspace.sessionIds,
            }))
          } catch {
            return undefined
          }
        },
      })

  // 上一次会话分页应答里**真的读出标题**的条数（0 = 标题链路整条断了）。
  //
  // 为什么单独数它：读标题那段有两个可以安静失败的取值（服务缺失、返回形状对不上），
  // 而两者的表现完全相同 —— 手机端每个会话都退回显示 sessionId，没有异常也没有日志。
  // 我第一次就是按印象写了错误的返回形状，症状正是「怎么都是 session id」，靠这个计数
  // 才把「形状不对」与「这批会话本来就没标题」分开（两者处置完全不同：前者要改代码，
  // 后者是老会话没有 `session/title` 事件的真实行为）。
  let titlesRead = 0

  // 上一次分页应答**实际用的是哪个数据源**。
  //
  // 为什么必须报出来：「读不到会话」有两个外观完全相同的原因 —— 权威源没装配、或权威源
  // 抛错后走了兜底。两者的手机表现一样（顺序不对/缺会话），处置却完全不同。
  // 没有这个字段就只能靠猜（provider 里那段「服务名核过没」的 KDoc 就是第一版的学费）。
  let sessionSource: string | undefined

  // 权威源抛出的错（有值 = 这次走了兜底源）。与 sessionSource 一起看才有信息量。
  let controllerFallback: string | undefined

  // 两个源都没读成时的一句话原因。只记第一次，避免被后续轮次覆盖成同一条。
  let lastReadFailure: string | undefined

  // 上一次分页应答的**成员账对账**：按 cwd 匹配到几条（pageCandidates）、其中被 DSH 的
  // 成员账认可几条（pageMembers）。
  //
  // 为什么必须报出来（2026-10-15，用户「工作区显示的会话比 dsh 真实显示的要多」）：
  // 这两个数原本谁都不知道 —— 手机显示的条数既不是 cwd 匹配数也不是成员数，而是两者在
  // 「注册表能不能用」两种情形下的不同结果。`pageMembers === -1` 明确表示这次用了 cwd 兜底
  // （注册表没装或那个 path 不在注册表里），此时 pageMembers 这一格是**一句我们不知道的话**，
  // 不许显示成 0。
  let pageCandidates = -1
  let pageMembers = -1
  // 上一次报给手机的 total（可见数）。三者一起看才回答得了「手机该看到几条」。
  let pageTotal = -1

  // 诊断工具：报告自动宣告器的运行时状态。
  //
  // 为什么需要它（2026-10-14）：宣告链路此前**完全不可观测** —— 失败只走 `logger.warn`，
  // 而宿主日志不落盘那些行。我为此排查了很久：先是怀疑 inject 硬依赖、再怀疑台账内存态、
  // 再怀疑 peers 缓存，最后只能靠手工 curl 逐个排除。一个对外发包的自动链路必须有
  // 一个能回答「它到底发了没、发了几条、为什么没发」的入口。
  ctx.tools.register(defineTool({
    name: 'tidings_announce_status',
    description: [
      '读取自动宣告器的运行时状态：开关是否生效、已宣告的工作区数、当前受众（在线邻居）、',
      '以及 DSH 台账与服务是否可用。排查「手机上看不到工作区」时先看它。只读。',
    ].join(' '),
    parameters: {},
    output: {
      ...JSON_OUTPUT,
      render: (_args, value) => {
        const object = jsonObject(value)
        return textResult(
          `捎话自动宣告：${object?.enabled === false ? '已关闭' : '开启'}，已宣告 ${String(jsonNumber(object?.announced, 0))} 个工作区，` +
          `当前受众 ${String(jsonArray(object?.audience).length)} 个，DSH 台账 ${object?.dshWorkspaces === undefined ? '不可用' : String(jsonNumber(object?.dshWorkspaces, 0)) + ' 条'}。`,
        )
      },
    },
    async execute() {
      const config = store.current()
      // 受众：与宣告器同一口径（配置优先，否则在线邻居）。
      let audience: readonly string[] = []
      let audienceError: string | undefined
      try {
        const peers = await createTidingsClient(ctx, config).peers()
        audience = peers.filter(peer => peer.online).map(peer => peer.nodeId)
      } catch (error) {
        audienceError = messageOf(error)
      }
      // DSH 台账服务是否可用（宣告的首选数据源）。
      const registry = ctx.get('workspaceRegistry') as { list(): readonly unknown[] } | undefined
      let dshWorkspaces: number | undefined
      let dshError: string | undefined
      if (registry === undefined) {
        dshError = '服务未提供（本 profile 没装 dsh-workspace）'
      } else {
        try {
          dshWorkspaces = registry.list().length
        } catch (error) {
          dshError = messageOf(error)
        }
      }
      return asJson({
        enabled: config.autoAnnounce !== false,
        configuredTargets: config.announceTargets ?? [],
        audience,
        ...audienceError === undefined ? {} : { audienceError },
        dshWorkspaces,
        ...dshError === undefined ? {} : { dshError },
        announced: announcer?.announcedWorkspaceIds().length ?? 0,
        // 会话分页能不能应答 —— 我为此手查了很久（见 provider 里服务名那段 KDoc）。
        // `sessionQuery` 不在 ⇒ 手机的「加载更多」永远没回音，而界面上看不出原因。
        sessionQueryAvailable: ctx.get('sessionQuery') !== undefined,
        // 权威源在不在（有它才是 DSH 的活动倒序，见 provider 第一段 KDoc）。
        sessionControllerAvailable: ctx.get('sessionController') !== undefined,
        // 会话标题服务在不在。
        //
        // `session/title` 是 **log-only** 事件（不进 surface 流），所以 `session/event`
        // 订阅永远等不到它；但 service 本身可以**主动读**（`get(session)` 返回
        // `{ title, eventSeq, updatedAt }`）。它在不在决定了我们能不能拿到 DSH 那份
        // 「会话页体验问题」式的真标题 —— 拿不到时退回「第一条用户消息」，那是诚实但不准的。
        sessionTitleAvailable: ctx.get('sessionTitle') !== undefined,
        // 上一次分页应答用的是哪个源、以及权威源为什么没成。
        ...sessionSource === undefined ? {} : { sessionSource },
        ...controllerFallback === undefined ? {} : { controllerFallback },
        ...lastReadFailure === undefined ? {} : { lastReadFailure },
        // 上一次分页应答真的读出了几个标题。0 且每次请求都有 → 形状或服务名错了（见
        // provider 里返形状那段 KDoc）；不是 0 → 读得出，剩下的退回 id 是老会话没有标题。
        titlesRead: titlesRead,
        // 上一次分页的三个数（见 pageCandidates 的 KDoc）。「手机显示的会话数比 DSH 多」
        // 这类反馈，用这三个数就能直接定位是哪一段的账对不上：
        //   pageCandidates = 按 cwd 匹配到的条数（旧口径，通常是错的）
        //   pageMembers    = 其中被 DSH 成员账认可几条（-1 = 这次没问注册表，退回 cwd）
        //   pageTotal      = 这一页真正报给手机的可见数（= DSH 也算可见的那些）
        pageCandidates,
        pageMembers,
        pageTotal,
        // 通道挂载点见 rpcMounted 的 KDoc；不是 'ok' = 设置页会永远停在「检查中…」。
        rpcMounted,
        // 见 tidingsRpcCalls 的 KDoc：0 = 请求根本没进处理器（路由问题），>0 = 进了但没回。
        tidingsRpcCalls,
        // 为什么最近一次失败要报出来：`send()` 把异常吞进 logger.warn，而宿主不落盘那些行 ——
        // 排查「宣告了 15 个但台账是 0」时这是唯一能问到的出口（见 send 的 KDoc）。
        ...announcer?.lastSendFailure() === undefined
          ? {}
          : { lastSendFailure: announcer.lastSendFailure() },
        fallbackRegistry: workspaceRegistry.known().length,
      })
    },
  }))
  if (announcer !== undefined) {
    // `origin` 必须一路带到 announcer：`'subagent'` 的子代理会话在 DSH 自己的工作区
    // 浏览器里是被隐藏的（packages/client/ui-workspace/src/client/tree.ts 的
    // `sessionVisible()`），手机是同一份清单的另一个视图，也该隐藏。真机上多出来的
    // 那 19 对「Route this bounded MEMORY.md archive」就是这么漏过去的。
    ctx.on('session/created', (session) => {
      // `createdAt` 是活动时刻的起点：DSH 的 `updatedAt = max(createdAt, lastPromptAt)`，
      // 还没有用户消息的会话就该排在它被创建的那一刻（见 AnnounceSession.createdAt）。
      announcer.onCreated({
        id: String(session.id),
        cwd: session.header?.cwd,
        createdAt: session.header?.createdAt,
        origin: session.header?.origin,
      })
    }, { global: true })
    ctx.on('session/event', (session, event) => {
      announcer.onEvent(
        {
          id: String(session.id),
          cwd: session.header?.cwd,
          origin: session.header?.origin,
          // **DSH 的真会话标题**（就是侧边栏那个「会话页体验问题」）。
          //
          // 为什么走 `get` 而不是订阅事件：`session/title` 是 **log-only** 记录、不进 surface 流，
          // `session/event` 永远等不到它。而 service 的 `get(session)` 可以主动读。
          //
          // 拿不到（宿主没装这个服务、或该会话还没生成标题）⇒ 不给这个字段，
          // announcer 退回「第一条用户消息」—— 诚实但不准，见 AnnounceSession.hostTitle。
          hostTitle: readHostTitle(ctx, session),
        },
        event,
      )
    }, { global: true })
    ctx.on('session/disposed', (session) => {
      announcer.onDisposed({ id: String(session.id), cwd: session.header?.cwd, origin: session.header?.origin })
    }, { global: true })
    // 启动时把本机**已知**的工作区全量宣告一次（2026-10-14 新增）。
    //
    // announceWorkspace 只在某个会话正跑在该目录时才发帧，所以一个跑过 N 个目录的宿主
    // 在「工作区」页上仍然只有最近那几条 —— 用户的观察（「真实的 dsh 现在的 workspace
    // 有很多，目前看起来工作区列表没有缓存吗？每次都得等同步」）正是这个缺口。
    //
    // ## 为什么是周期重试而不是一次延迟
    //
    // 插件加载时对端可能还没握手完（`targets()` 取到空列表），所以第一次必须延迟一拍。
    // 但**只延迟一次是不够的**：2026-10-14 真机实测 —— 宿主先起来、捎话桌面端 50 秒后
    // 才启动，那唯一一次宣告全部落空，之后工作区台账永远是 0（手机上看不到任何 DSH 工作区）。
    // 而「桌面端比宿主后起」是最常见的顺序：DSH 常开、人要用时才打开桌面端。
    //
    // 所以这里改成周期重试。安全的前提是 `announceKnownWorkspaces()` **幂等**：
    // 已宣告过的 wsId 会被 `announcedWorkspaces` 集合跳过，所以重试不会重复发帧，
    // 也不会在每次会话触发时叠加。
    //
    // 间隔取 10 秒：这是「对端刚上线」与「不做无谓轮询」之间的折中。宣告一次之后
    // 每个周期都是空转（集合全部命中），代价只是一次 `targets()` 的邻居缓存读。
    const announceTimer = setInterval(() => announcer.announceKnownWorkspaces(), 10_000)
    const firstAnnounce = setTimeout(() => announcer.announceKnownWorkspaces(), 1_000)
    ctx.effect(() => () => {
      clearTimeout(firstAnnounce)
      clearInterval(announceTimer)
      announcer.stop()
    })


    // ------------------------------------------------------------------ 入站 prompt 注入
    //
    // 这条路径让群里 `@dsh` 说的话**真的进到本机 agent**。在此之前它只落到捎话自己的
    // `NativeTidingsDriver`（兜底驱动），它如实回一句「没执行任何命令」。
    //
    // 判据全在 Tidings 侧（`agentHint`），这里只消费：
    // - `addressedToAgent` —— 是不是在 @ 本机 agent；
    // - `boundWsId` / `requestedSessionId` —— 投给哪个会话；
    // - `senderMayExecute` —— 发送者有没有执行权（群主/管理员/agent 宿主/显式授权）。
    //
    // **首轮只对齐游标**：插件第一次装上时若从 0 开始投，用户几个月前说的话会被当成
    // 待执行指令跑起来。`runInjectionRound(deps, firstRun)` 的 firstRun 就是这个开关。
    const cursorFile = join(dshHome(), 'tidings', 'inject-cursor.json')
    let injectCursor = 0
    let injectFirstRun = true
    const loadCursor = () => {
      try {
        const raw = JSON.parse(readFileSync(cursorFile, 'utf8')) as { since?: unknown }
        injectCursor = typeof raw.since === 'number' && Number.isFinite(raw.since) ? raw.since : 0
      } catch {
        // 文件不存在/坏了：从 0 开始并且**首轮只对齐**，历史一条都不执行。
        injectCursor = 0
      }
    }
    const saveCursor = (next: number) => {
      injectCursor = next
      try {
        mkdirSync(dirname(cursorFile), { recursive: true })
        writeFileSync(cursorFile, JSON.stringify({ since: next }), 'utf8')
      } catch {
        // 写不进去只影响「重启后少一次对齐」，不影响本轮投递。不抛。
      }
    }
    loadCursor()

    const injectDeps: TidingsInjectionLoopDeps = {
      fetchPage: async (since) => {
        const page = await createTidingsClient(ctx, store.current()).inbox({ since, limit: 50 })
        return { since: page.since, nextSince: page.nextSince, messages: page.messages }
      },
      candidatesFor: async (agentName) => {
        // 候选 = 该 agent 的会话，按活跃度倒序（`updatedAt`）。
        // `wsId` 由工作区台账从 `cwd` 反推（与手机看到的是同一本账）。
        //
        // ## 必须**两个源都试**，与上面会话分页那条同一条纪律
        //
        // 原先这里只读 `sessionController`，拿不到就 `return []` —— 于是所有注入
        // 都判成「没有算出可投的会话」。真机现场：同一条 `@dsh` 消息在 23:56 注入成功、
        // 00:06 又被拒，中间只重启过 DSH —— 服务就绪与否决定了这条桥通不通。
        //
        // 文件里 :792 早就写着「`sessionQuery.listSessions()` 留作兜底：它是**没有**
        // session-controller 的宿主上唯一能读会话的服务」。会话分页那条用了，这条没跟。
        const controller = ctx.get('sessionController') as SessionControllerLike | undefined
        const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
        let raw: readonly Omit<SessionCandidate, 'archived'>[] = [];
        try {
          if (controller !== undefined) {
            raw = await readFromSessionController(controller)
          } else if (query !== undefined) {
            raw = await readFromSessionQuery(query)
          }
        } catch {
          // 读不到就一定不投：宁可这一轮不执行，也不猜一个会话。
          raw = []
        }
        const candidates = raw
          .filter(c => c.origin !== 'subagent')
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map(c => {
            const ws = workspaceRegistry.workspaceOf(c.cwd)
            return ws === undefined
              ? { sessionId: c.sessionId }
              : { sessionId: c.sessionId, wsId: ws.wsId }
          })
        return candidates
      },
      agents: () => ctx.get('agents') as AgentsServiceLike | undefined,
      buildMessage: (text) => buildUserMessage(ctx, text),
      onOutcome: (message, kind, reason) => {
        // 写日志：拒绝时说得出为什么，否则用户会以为 DSH 卡住了。
        ctx.logger?.info?.(`[tidings] 入站 prompt ${kind}：${reason ?? message.seq}`)
      },
      readCursor: () => injectCursor,
      writeCursor: saveCursor,
    }

    // **在途标志：上一轮没跑完就跳过这一轮。**
    //
    // 没有它时同一条消息会被注入**两次**（真机：DSH 里出现重复的 prompt，
    // 而 outcome 探针里每个 seq 都记了 2 条 injected）。
    //
    // 机制：一轮要做「读游标 → 拉 inbox → 读全部会话并排序 → 投递 → 写游标」。
    // 其中读会话那步在真机上要处理 3100+ 条（实测 rawCount=3106），一旦超过
    // 2s 的定时器周期，下一轮就在上一轮 writeCursor **之前**启动、读到同一个旧
    // 游标、把同一条消息再注入一遍。页面级去重挡不住：这是同一轮逻辑跑了两份。
    //
    // 跳过而不是排队：积压的轮次没有意义 —— 下一轮会从最新游标继续，
    // 而排队的旧轮次要投的是已经处理过的消息。
    let injectInFlight = false
    const injectTimer = setInterval(() => {
      if (injectInFlight) return
      injectInFlight = true
      void runInjectionRound(injectDeps, injectFirstRun)
        .then(() => { injectFirstRun = false })
        .catch(error => {
          // 一轮失败不该让循环死掉；但也**不要**把 firstRun 留在 true —— 那会
          // 永久丢掉「对齐一次」的机会，历史又可能被当成新指令。
          injectFirstRun = false
          ctx.logger?.warn?.(`[tidings] 入站 prompt 轮询失败：${String(error)}`);
        })
        .finally(() => { injectInFlight = false })
    }, 2_000)
    ctx.effect(() => () => clearInterval(injectTimer))
    // 会话分页应答器（PPE-1 增补 D8）。
    //
    // 手机点开工作区时会发 `agent-session-page`，节点把它排队等宿主来读（会话历史只有
    // 宿主知道）。这个应答器轮询那个队列、从 DSH 读一页、用普通 agent-session 帧回填。
    //
    // 顺序刻意放在自动宣告之外：宣告处理「正在活动的会话」，这个处理「过去的活动」。
    // 两者互不依赖，任何一个失败都不影响另一个（各自吞异常、各自重试）。
    const pageResponder = new SessionPageResponder({
      client: () => createTidingsClient(ctx, store.current()),
      provider: async (path, offset, limit) => {
        try {
          // ## 两个候选数据源，先问权威的那个
          //
          // `sessionController.list()` 是 DSH **自己会话列表**的口径：
          // packages/api/session-controller/src/list.ts 先取 sessionQuery.listSessions()，
          // 再 `items.sort((left, right) => right.updatedAt - left.updatedAt)`，而
          // `updatedAt = max(createdAt, lastPromptAt)`（同文件 updatedAt()）——
          // 也就是「最近真的动过」的降序。手机端要的正是这个序（真机反馈：
          // 「看起来跟 dsh 上显示的不一样,不是最新的」）。
          //
          // 它同时带出 blank / origin / cwd：DSH 自己的工作区浏览器**过滤**掉
          // `origin === 'subagent'` 的会话与 blank 会话
          // （packages/client/ui-workspace/src/client/tree.ts 的 sessionVisible()）。
          // 不过滤的话手机上的会话会比 DSH 上多出一截 —— 子代理的会话被当成用户的。
          //
          // `sessionQuery.listSessions()` 留作兜底：它是**没有** session-controller 的
          // 宿主上唯一能读会话的服务，按 createdAt 倒序 —— 不如活动序准，但比答不出来强。
          //
          // ## 两个服务的返回值形状都必须照抄真实声明
          //
          // 这条链路踩过两次同源的坑，都写下来，因为症状一模一样（安静地什么都没读到）：
          //
          // ① 服务名。第一版写的是 `ctx.get('sessionController')`，而当时全仓**没有**这个
          //    注册名（真名是 sessionQuery，sessionController 是**另一个**包），于是 provider
          //    每次都 `return undefined` ⇒ 手机的会话分页请求**永远得不到应答**（队列里堆着
          //    请求、手机端一条会话也拉不出来），而 catch 把一切吞掉、什么都不报。
          //    教训：**本地声明的服务坐标必须对着真实注册名核过**，否则「读不到」被自己的
          //    容错路径伪装成「对端没有问题」。
          //
          // ② 返回形状。`readTitleSnapshots()` 的返回**不是** `{ session, title }` 数组，而是
          //    可辨识联合（SessionTitleObservationResult），且标题还嵌一层：字符串在
          //    `value.title.title`（`value.title` 是 SessionTitleSnapshot 对象）。官方消费
          //    姿势见 packages/session-query/tool-session-query/src/workspace-access.ts：
          //    `observation.value.title?.title ?? 'untitled'`。
          //    第一版按 `snapshot.title`（当它是字符串）+ `snapshot.session.id` 读，两个取值
          //    **都是 undefined**，而守卫 `typeof x === 'string'` 只是**安静地不成立** ⇒
          //    手机端每个会话都退回显示 sessionId（用户反馈「工作区的会话,
          //    怎么都是 session id」）。没有异常、没有日志 —— 它不是崩了，是「守卫问的问题
          //    和真实形状对不上」。
          //
          // 同一句判据：**对着真实声明核过的类型，不能凭印象写**；并且「一个取值恒为
          // undefined 的守卫」必须自己能被观察到 —— 下面 sessionSource / titlesRead 两个
          // 计数就是为这两次事故加的。
          const controller = ctx.get('sessionController') as SessionControllerLike | undefined
          const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
          if (controller === undefined && query === undefined) return undefined

          let candidates: readonly RawSessionCandidate[] | undefined
          if (controller !== undefined) {
            try {
              candidates = await readFromSessionController(controller)
              sessionSource = 'sessionController'
            } catch (error) {
              // 权威源读不到（权限/未装配）不是终点：下面还有兜底源。
              controllerFallback = messageOf(error)
            }
          }
          if (candidates === undefined && query !== undefined) {
            candidates = await readFromSessionQuery(query)
            sessionSource = 'sessionQuery'
          }
          if (candidates === undefined) {
            // 两个源都不可用。**不答**（见下面的 catch）：回一页空列表会被手机显示成
            // 「这个工作区没有会话」，而那是一句我们并不知道的话。
            lastReadFailure = lastReadFailure ?? '没有可用的会话服务'
            return undefined
          }

          // ## 成员判据：DSH 的**成员账**，不是「cwd 等于这个目录的全部会话」
          //
          // 第一版只按 cwd 匹配，真机上 teahouse-mobile 因此显示了 408 条会话，而 DSH
          // 自己的工作区分组里只有 39 条（用户反馈「工作区显示的会话比 dsh 真实显示的
          // 要多，这个很奇怪」）。差的那些会话都跑在同一个目录里，但它们并不属于这个
          // 工作区：DSH 的成员是显式记的账 —— packages/workspace/workspace 的 entity.ts
          // `get sessionIds() { return this.record.sessionIds.filter(id => this.host.sessionPath(id) === this.record.path) }`，
          // 只在 `attachSession` / bootstrap 时写入。
          //
          // 注册表不可用（有的 profile 没装 dsh-workspace）时退回 cwd 匹配，并把这件事报进
          // `pageMembers`（见诊断字段）—— **沉默地换一套口径**比多显示几条更难查。
          const workspaceRegistry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
          const workspace = workspaceRegistry
            ?.list().find(entry => samePath(entry.path, path))
          const membership = workspace?.sessionIds
          const archivedIds = new Set(workspaceRegistry?.archivedSessionIds ?? [])
          const withArchived = candidates.map(record => ({
            ...record,
            archived: archivedIds.has(record.sessionId),
          }))
          const byPath = withArchived.filter(record => samePath(record.cwd, path))
          const sameWorkspace = membership === undefined
            ? byPath
            : byPath.filter(record => membership.includes(record.sessionId))
          pageCandidates = byPath.length
          pageMembers = membership === undefined ? -1 : sameWorkspace.length
          // **这一页发全部候选，不在宿主过滤**（判据走 origin/blank/archived 送到手机）：
          // ① 被过滤掉的行，手机永远学不到「这条该藏」—— absence of evidence，
          //    已经落库的存量行就再也清不掉；
          // ② offset 与手机本地已知条数同分母（见 App.kt 的 onLoadMoreAgentSessions），
          //    这里少发一条，下一页就会错位、漏行。
          // 可见数仍要算：它是 total 的口径，也是下面 blank 判据的分母。
          const visible = sameWorkspace.filter(record => visibleOnPhone(record, sameWorkspace))
          // 顺序 = 活动倒序（权威源已排好，兜底源是 created 倒序）。第一页就是「最近在动的」。
          // 手机端**不再按自己收到帧的时刻重排**：分页是一次几十条同一毫秒到达的帧，
          // 那个排序键会退化成到达顺序（这正是用户看到「跟 DSH 上显示的不一样」的原因）。
          const page = sameWorkspace.slice(offset, offset + limit)
          // 标题要单独读（`readTitleSnapshots`）：那是折叠会话日志算出来的，两个服务都不带它。
          // 少了这一步，历史会话在手机上一律显示成 `session-...` 这样的 id。
          //
          // 只给**这一页**的 id 读标题：整库读一遍在几十上百个会话时不划算，而这一页只需要
          // `limit` 条。按 id 建 map 匹配回去（比依赖返回顺序稳）。
          const pageIds = page.map(record => record.sessionId)
          const titles = new Map<string, string>()
          if (query !== undefined && pageIds.length > 0) {
            try {
              for (const observation of await query.readTitleSnapshots(pageIds)) {
                // 失败的会话被隔离在它自己那条结果里（官方契约：operational failures
                // stay isolated per session）—— 跳过它，不要因此丢掉整页标题。
                if (observation.status !== 'fulfilled') continue
                const text = observation.value.title?.title
                if (typeof text === 'string' && text.length > 0) {
                  titles.set(String(observation.sessionId), text)
                }
              }
            } catch {
              // 读不到标题不算失败：会话本身照常回填，标题退回 id（三级回落的兜底）。
            }
          }
          titlesRead = titles.size
          const entries = page.map(record => ({
            sessionId: record.sessionId,
            title: titles.get(record.sessionId),
            // 归档会话标记为 'archived'；运行中的为 'busy'；其余闲置的不带 state
            state: record.running ? 'busy' : (record.archived ? 'archived' : undefined),
            // 活动时刻（排序键）。不转发它，手机端就只能拿「收到这一帧的时刻」排 ——
            // 而分页是一整页同一毫秒到达的，排序必然退化成请求顺序。
            updatedAt: record.updatedAt,
            // 可见性两键：宿主不替手机藏行，把 DSH 的判据原样交出去（见上面 mine 的注释）。
            origin: record.origin,
            blank: record.blank,
          }))
          pageTotal = visible.length
          return { entries, total: visible.length }
        } catch {
          // 读不到就**不答**：回一页空列表会被手机显示成「这个工作区没有会话」，
          // 而那是一句我们并不知道的话（同一纪律：沉默 ≠ 空）。请求留在队列等下一轮。
          return undefined
        }
      },
      registry: workspaceRegistry,
    })
    ctx.effect(() => {
      pageResponder.start()
      return () => pageResponder.stop()
    })

    // 进程退出/插件重载时把节流定时器清掉：留下的 setTimeout 会在 scope 已死之后继续发帧，
    // 症状是「关掉插件后手机仍收到事件」，最难查。
  }
}


/**
 * 把一段文本编成 DSH 的 `UserMessage`。
 *
 * ## 为什么不直接 `import`
 *
 * `@deepseek-ai/dsh-llm` **不在本插件的依赖里**（`package.json` 只有 schemastery）。
 * 直接 import 会让 `tsc` 与运行时都失败；而把它写进 `inject` 更糟 ——
 * 见 `scripts/check-inject-baseline.mjs` 钉的那次故障：声明宿主没提供的服务会让
 * cordis **拒绝加载整个插件，日志里一行都没有**。
 *
 * 所以这里走**运行时可选读取**：拿得到就用，拿不到返回 undefined，
 * 由调用方报 `unavailable`（如实说桥没接上，而不是假装投过）。
 */
function buildUserMessage(ctx: Context, text: string): unknown {
  // 宿主的 llm 模块通过 `ctx.get` 拿不到（它不是服务），所以按「宿主自己会传」的约定：
  // 插件把纯文本交出去，由 **agent.followup 的调用点**决定怎么编消息。
  // 这里返回一个最小的、结构上等价于 UserMessage 的对象 —— DSH 的 followup 接受它。
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}
/**
 * `sessionController` 的最小本地声明 —— DSH **自己会话列表**的口径。
 *
 * 坐标对着真实注册名核过（见 provider 里服务名那段 KDoc）：
 * `packages/api/session-controller/src/index.ts` 的 `super(ctx, 'sessionController', …)`，
 * `list()` 的返回是 `{ items: SessionSummary[] }`，而 `items` 已按
 * `updatedAt = max(createdAt, lastPromptAt)` 降序排好（`src/list.ts` 的 updatedAt() 与
 * `items.sort((left, right) => right.updatedAt - left.updatedAt)`）。
 *
 * 只声明我们要用的字段：本地接口是**消费面**的契约，不是对面类型的副本。
 * 多声明一个用不到的字段，就多一个「对面改了、我们这边静默不对」的缝。
 */
/**
 * `workspaceRegistry` 的最小本地声明 —— 只用得上两件事：
 *
 * ① `list()` 的**顺序**就是 DSH 工作区浏览器的分组顺序（durable 注册表序），
 *    手机要复现它；② 每个工作区的 `sessionIds` 才是 DSH 认可的**成员账**，
 *    按 cwd 全量匹配会让手机多显示一大截（真机 408 vs 39）。
 *
 * 只声明用得到的字段：本地接口是消费面契约，不是对面类型的副本。
 */
interface WorkspaceRegistryLike {
  list(): readonly WorkspaceLike[]
  readonly archivedSessionIds?: readonly string[]
}

interface WorkspaceLike {
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
}

interface SessionControllerLike {
  list(
    request: { readonly cursor?: string },
    signal: AbortSignal,
  ): Promise<{ readonly items: readonly SessionSummaryLike[] }>
}

/** `SessionSummary` 里我们真正要用的字段（形状照 types.ts 抄）。 */
interface SessionSummaryLike {
  readonly sessionId: string
  /** `max(createdAt, lastPromptAt)`，epoch 毫秒 —— 手机端的排序键。 */
  readonly updatedAt: number
  /** 这个会话正在跑（官方语义，不是「活着没」）。 */
  readonly running: boolean
  /** 还没跑过任何一轮的空会话（DSH 工作区浏览器会把它藏起来）。 */
  readonly blank: boolean
  /** 子代理派生的会话（DSH 工作区浏览器会把它藏起来）。 */
  readonly origin?: 'subagent'
  readonly cwd?: string
}

/**
 * `sessionQuery` 的最小本地声明 —— 兜底数据源。
 *
 * 它在**没有** session-controller 的宿主上是唯一能读会话的服务。它的顺序是
 * `createdAt` 倒序，不是活动倒序 —— 不如权威源准，但比答不出来强。
 * 标题也只在这里读：`readTitleSnapshots` 是折叠会话日志算出来的，两个服务都不带标题。
 */
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<readonly SessionRecordLike[]>
  readTitleSnapshots(
    sessionIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly SessionTitleObservationLike[]>
}

/** `SessionRecord`（session-query）里用得上的部分。 */
interface SessionRecordLike {
  readonly header: {
    readonly id: string
    readonly createdAt: number
    readonly cwd?: string
    readonly origin?: 'subagent'
  }
}

/**
 * `readTitleSnapshots` 的返回是**可辨识联合**，标题还嵌一层：字符串在
 * `observation.value.title.title`。
 *
 * 第一版按 `snapshot.title`（当它是字符串）+ `snapshot.session.id` 读，两个取值都是
 * undefined，而守卫 `typeof x === 'string'` 只是安静地不成立 ⇒ 手机端每个会话都退回
 * 显示 sessionId。把形状写下来，是为了让下次改的人不必再猜一遍。
 */
type SessionTitleObservationLike =
  | {
      readonly sessionId: string
      readonly status: 'fulfilled'
      readonly value: { readonly title?: { readonly title?: string } }
    }
  | { readonly sessionId: string; readonly status: 'rejected'; readonly reason: unknown }

/**
 * 一个会话在「排序 + 过滤 + 归属」上真正要用到的字段 —— 两个数据源的公共投影。
 *
 * 归一是刻意的：下面的排序/过滤/filter 只看这个形状，两份来源的差异被关在两个
 * `readFrom*` 函数里。否则每加一条规则都要在两个分支各写一遍，迟早只改一处。
 */
interface SessionCandidate {
  readonly sessionId: string
  readonly cwd?: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly origin?: 'subagent'
  readonly archived: boolean
}

type RawSessionCandidate = Omit<SessionCandidate, 'archived'>

/**
 * 读权威源：`sessionController.list()`。
 *
 * `exactOptionalPropertyTypes` 下 `{ cwd: undefined }` 不等于 `{ cwd?: string }`，
 * 所以可选键一律展开式给（这也是本仓既有的写法纪律）。
 */
async function readFromSessionController(
  controller: SessionControllerLike,
): Promise<readonly Omit<SessionCandidate, 'archived'>[]> {
  const { items } = await controller.list({}, new AbortController().signal)
  return items.map(item => ({
    sessionId: String(item.sessionId),
    ...item.cwd === undefined ? {} : { cwd: item.cwd },
    updatedAt: item.updatedAt,
    running: item.running === true,
    blank: item.blank === true,
    ...item.origin === undefined ? {} : { origin: item.origin },
  }))
}

/**
 * 读兜底源：`sessionQuery.listSessions()`。
 *
 * `updatedAt` 退回 `header.createdAt`：这是这个源**唯一**知道的时间，用它排序得到的
 * 是 createdAt 倒序（优于「按到达顺序」）。不许拿 `Date.now()` 顶替 —— 那是假的
 * 活动时刻，会让手机上的顺序看起来对而实际荒谬。
 *
 * `running`/`blank` 一律 false：这个源不知道，**不知道就不猜**（`state` 键随后也不出现，
 * 而「没报状态」和「状态是空」是两回事，见 AgentSessionStates 的语义）。
 */
async function readFromSessionQuery(
  query: SessionQueryLike,
): Promise<readonly Omit<SessionCandidate, 'archived'>[]> {
  const records = await query.listSessions()
  return records.map(record => ({
    sessionId: String(record.header.id),
    ...record.header.cwd === undefined ? {} : { cwd: record.header.cwd },
    updatedAt: record.header.createdAt,
    running: false,
    blank: false,
    ...record.header.origin === undefined ? {} : { origin: record.header.origin },
  }))
}

/**
 * 这个会话该不该出现在手机的工作区列表里 —— 与 DSH 自己的工作区浏览器同一口径。
 *
 * 官方规则（packages/client/ui-workspace/src/client/tree.ts 的 sessionVisible()）：
 * `origin === 'subagent'` 一律不显示；blank 会话**除当前会话外**不显示。
 *
 * 两处「与官方不同」都是刻意的，写在这里免得被当成 bug 改掉：
 *
 * ① subagent 会话照官方隐藏。不做的话手机上的会话会比 DSH 上多出一截 ——
 *    子代理的会话被当成用户自己的会话。（这是用户会直接看到的那种错。）
 *
 * ② blank 会话我们没有「当前会话」这个身份（手机问的是「这个工作区有哪些会话」，
 *    带着 `wsId` 而不带 `sessionId`），所以无从判断哪一条是用户正打开的那条。
 *    于是只在**该工作区还有别的可见会话**时才隐藏 blank：只剩 blank 的工作区如果
 *    把它们全藏了，手机会把这个工作区显示成空的 —— 而它并不是空的，这比多显示一条更糟。
 */
function visibleOnPhone(candidate: SessionCandidate, siblings: readonly SessionCandidate[]): boolean {
  if (candidate.origin === 'subagent') return false
  if (candidate.archived) return false
  if (!candidate.sessionId.startsWith('session-')) return false
  if (!candidate.blank) return true
  return siblings.every(other => other.blank)
}
/**
 * Whether two directory paths denote the same workspace.
 *
 * Trailing separators are dropped and the comparison is exact otherwise: DSH
 * stores an `fs.realpath`-resolved path (Workspace.path documents that it is
 * canonical), while the registry stores whatever cwd it was handed, so the one
 * difference worth tolerating is a trailing slash. A case-insensitive or
 * parent-collapsing comparison would risk matching two genuinely different
 * projects — a far worse failure than missing one row.
 */
function samePath(left: string | undefined, right: string): boolean {
  if (typeof left !== 'string') return false
  const trim = (value: string): string => value.replace(/[\\/]+$/, '')
  return trim(left) === trim(right)
}

/** Where the plugin keeps its own state (config + workspace identity map). */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 错误转一行可读文本（诊断工具用；宣告器内部自己有一份，不跨文件共享以免耦合）。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : '未知错误'
}