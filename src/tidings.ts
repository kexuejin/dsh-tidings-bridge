/**
 * HTTP client for the local Tidings (`agentNode`) control plane.
 *
 * The plugin never speaks the 捎话 UDP/TCP protocol: every operation here is
 * one JSON request to the node's loopback HTTP surface. Requests carry the
 * optional bearer token resolved through the DSH credentials provider, refuse
 * redirects, and never emit a token back across the RPC boundary.
 *
 * @module dsh-tidings/tidings
 */

import { request as requestHttp } from 'node:http'
import { request as requestHttps } from 'node:https'
import type { IncomingHttpHeaders, RequestOptions } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  TidingsAgentEventArgs,
  TidingsAgentEventView,
  TidingsAgentReceiptView,
  TidingsAgentSessionArgs,
  TidingsAgentSessionsView,
  TidingsAgentSessionView,
  TidingsAgentWorkspacesArgs,
  TidingsAgentWorkspaceArgs,
  TidingsAgentWorkspacesView,
  TidingsCredentialSavedView,
  TidingsCredentialView,
  TidingsErrorCode,
  TidingsGrantPolicy,
  TidingsGrantReplyEntry,
  TidingsGrantsView,
  TidingsGrantsWriteArgs,
  TidingsGrantsWriteView,
  TidingsGrantView,
  TidingsGrantRequestView,
  TidingsGrantScope,
  TidingsGrantState,
  TidingsGrantWriteEntry,
  TidingsHealthView,
  TidingsInboxArgs,
  TidingsInboxView,
  TidingsMessageView,
  TidingsPairingQrResult,
  TidingsPeerView,
  TidingsSendArgs,
  TidingsSendReceiptView,
  TidingsWorkspaceView,
  TidingsSessionPageRequestView,
  TidingsSessionPagesView,
} from './model.ts'

/**
 * Configuration as it arrives from the Cordis row or the runtime store.
 *
 * Each member is explicitly `| undefined` because the store composes a row
 * default with the saved overrides by spreading, and under
 * `exactOptionalPropertyTypes` a spread of an optional member is
 * `T | undefined` rather than `T`.
 */
export interface Config {
  readonly baseUrl?: string | undefined
  readonly tokenCredentialRef?: string | undefined
  readonly timeoutMs?: number | undefined
  readonly defaultPort?: number | undefined
  readonly inboxLimit?: number | undefined
  /**
   * Announce this host's DSH sessions and events to the agentNode automatically
   * (PPE-1 增补 D1/D3/D6). Off means no listener is registered at all.
   */
  readonly autoAnnounce?: boolean | undefined
  /**
   * Recipients for automatic announcements, by neighbour nick / IP / nodeId.
   * Empty or absent means every **online** peer the control plane reports.
   */
  readonly announceTargets?: readonly string[] | undefined
}

/** Configuration with every default filled in and every range checked. */
export interface ResolvedConfig {
  readonly baseUrl: string
  readonly tokenCredentialRef: CredentialRef
  readonly timeoutMs: number
  readonly defaultPort: number
  readonly inboxLimit: number
  readonly autoAnnounce: boolean
  readonly announceTargets: readonly string[]
}

interface TidingsRequestOptions {
  readonly method?: string
  readonly path: string
  readonly query?: Readonly<Record<string, string | number | undefined>>
  readonly body?: unknown
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8788'
const DEFAULT_CREDENTIAL_REF = 'TIDINGS_AGENT_TOKEN'
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_PORT = 17878
const DEFAULT_INBOX_LIMIT = 30

/** Control-plane `error` values the panel renders as localized copy. */
const KNOWN_ERROR_CODES = [
  'bad-request',
  'peer-unreachable',
  'peer-unsupported',
  'send-failed',
  'unauthorized',
  'not-found',
] as const

type KnownErrorCode = (typeof KNOWN_ERROR_CODES)[number]

/** A control-plane call failed; `code` selects the panel's copy. */
export class TidingsRequestError extends Error {
  constructor(
    readonly code: TidingsErrorCode,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message)
    this.name = 'TidingsRequestError'
  }
}

/**
 * Fill in defaults and reject out-of-range settings.
 * @param config - raw configuration from the row merged with the runtime store.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const defaultPort = config.defaultPort ?? DEFAULT_PORT
  const inboxLimit = config.inboxLimit ?? DEFAULT_INBOX_LIMIT
  if (timeoutMs < 1000) throw new Error('捎话 timeoutMs 不能小于 1000')
  if (defaultPort < 1 || defaultPort > 65535) throw new Error('捎话 defaultPort 必须在 1 到 65535 之间')
  if (inboxLimit < 1 || inboxLimit > 200) throw new Error('捎话 inboxLimit 必须在 1 到 200 之间')
  return {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    tokenCredentialRef: credentialRef(config.tokenCredentialRef?.trim() || DEFAULT_CREDENTIAL_REF),
    timeoutMs,
    defaultPort,
    inboxLimit,
    autoAnnounce: config.autoAnnounce ?? true,
    // Blank and duplicate entries are dropped here so the announcer never asks
    // for a recipient that the control plane can only reject as `to: ""`.
    announceTargets: (config.announceTargets ?? []).map(target => target.trim()).filter(target => target.length > 0),
  }
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = cleanOptional(value) ?? DEFAULT_BASE_URL
  const parsed = new URL(trimmed)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('捎话 baseUrl 必须使用 http 或 https')
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '')
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/$/u, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function arrayField(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function truncate(value: string, max = 20000): string {
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated]`
}

function errorCodeFromBody(body: unknown): KnownErrorCode | undefined {
  const raw = isRecord(body) ? stringField(body.error) : undefined
  return KNOWN_ERROR_CODES.find(code => code === raw)
}

function errorCodeForStatus(statusCode: number): TidingsErrorCode {
  if (statusCode === 400) return 'bad-request'
  if (statusCode === 401 || statusCode === 403) return 'unauthorized'
  if (statusCode === 404) return 'not-found'
  if (statusCode === 502) return 'send-failed'
  return 'internal'
}

function httpErrorMessage(method: string, target: URL, statusCode: number, body: unknown): string {
  const reported = isRecord(body) ? stringField(body.message) : undefined
  if (reported !== undefined) return truncate(reported, 800)
  return `${method} ${target.pathname} 返回 HTTP ${String(statusCode)}`
}

function networkErrorCode(error: unknown): TidingsErrorCode {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENOTFOUND') return 'unreachable'
  return 'internal'
}

function networkErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function appendQuery(target: URL, query: TidingsRequestOptions['query']): void {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) target.searchParams.set(key, String(value))
  }
}

function parseJsonBody(body: string, method: string, target: URL): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new TidingsRequestError('bad-response', `${method} ${target.pathname} 返回的内容不是 JSON`)
  }
}

/**
 * One request/response exchange, with a hard per-request timeout.
 * @param target - absolute control-plane URL.
 * @param options - method and headers.
 * @param body - already-serialized request body, when any.
 * @param timeoutMs - request deadline.
 * @returns the status line and decoded body.
 */
function requestJson(
  target: URL,
  options: RequestOptions,
  body: string | undefined,
  timeoutMs: number,
): Promise<{ readonly statusCode: number; readonly headers: IncomingHttpHeaders; readonly body: string }> {
  const client = target.protocol === 'https:' ? requestHttps : requestHttp
  return new Promise((resolve, reject) => {
    let timedOut = false
    const request = client(target, options, (response) => {
      response.setEncoding('utf8')
      let responseBody = ''
      response.on('data', (chunk) => { responseBody += chunk })
      response.on('end', () => {
        resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: responseBody })
      })
    })
    request.setTimeout(timeoutMs, () => {
      timedOut = true
      request.destroy(new Error(`控制面请求超过 ${String(timeoutMs)} 毫秒未响应`))
    })
    request.on('error', (error) => {
      if (timedOut) {
        reject(new TidingsRequestError('timeout', `控制面请求超过 ${String(timeoutMs)} 毫秒未响应`))
        return
      }
      reject(new TidingsRequestError(networkErrorCode(error), networkErrorMessage(error)))
    })
    if (body !== undefined) request.write(body)
    request.end()
  })
}

function normalizeHealth(raw: unknown): TidingsHealthView {
  const value = isRecord(raw) ? raw : {}
  return {
    ok: booleanField(value.ok) ?? false,
    nodeId: stringField(value.nodeId) ?? '',
    nick: stringField(value.nick) ?? '',
    platform: stringField(value.platform) ?? '',
    udpPort: numberField(value.udpPort) ?? 0,
    httpPort: numberField(value.httpPort) ?? 0,
    peers: numberField(value.peers) ?? 0,
    online: numberField(value.online) ?? 0,
    pending: numberField(value.pending) ?? 0,
    uptimeMs: numberField(value.uptimeMs) ?? 0,
  }
}

/**
 * Normalize one pending-request row.
 *
 * Returns `undefined` for a row we cannot read rather than a half-filled
 * object: a request missing its `wsId` or `id` cannot be answered, and a
 * placeholder would make the responder loop fire on junk.
 */
function normalizeSessionPageRequest(raw: unknown): TidingsSessionPageRequestView | undefined {
  if (!isRecord(raw)) return undefined
  const id = numberField(raw.id)
  const nodeId = stringField(raw.nodeId)
  const wsId = stringField(raw.wsId)
  if (id === undefined || nodeId === undefined || nodeId.length === 0) return undefined
  if (wsId === undefined || wsId.length === 0) return undefined
  return {
    id,
    nodeId,
    wsId,
    offset: numberField(raw.offset) ?? 0,
    ...(numberField(raw.limit) === undefined ? {} : { limit: numberField(raw.limit) }),
    at: numberField(raw.at) ?? 0,
  }
}

function normalizeAgentSession(raw: unknown): TidingsAgentSessionView | undefined {
  if (!isRecord(raw)) return undefined
  const nodeId = stringField(raw.nodeId)
  const sessionId = stringField(raw.sessionId)
  if (nodeId === undefined || sessionId === undefined) return undefined
  const alias = stringField(raw.alias)
  const agentKind = stringField(raw.agentKind)
  const state = stringField(raw.state)
  const title = stringField(raw.title)
  const startedAt = numberField(raw.startedAt)
  const agentId = stringField(raw.agentId)
  const wsId = stringField(raw.wsId)
  const wsTitle = stringField(raw.wsTitle)
  const wsPath = stringField(raw.wsPath)
  return {
    nodeId,
    sessionId,
    ...alias === undefined ? {} : { alias },
    ...agentKind === undefined ? {} : { agentKind },
    ...state === undefined ? {} : { state },
    ...title === undefined ? {} : { title },
    ...startedAt === undefined ? {} : { startedAt },
    ...agentId === undefined ? {} : { agentId },
    ...wsId === undefined ? {} : { wsId },
    ...wsTitle === undefined ? {} : { wsTitle },
    ...wsPath === undefined ? {} : { wsPath },
    announcedOut: booleanField(raw.announcedOut) ?? false,
    announcedIn: booleanField(raw.announcedIn) ?? false,
    updatedAt: numberField(raw.updatedAt) ?? 0,
    eventCount: numberField(raw.eventCount) ?? 0,
  }
}

function normalizeAgentEvent(raw: unknown): TidingsAgentEventView | undefined {
  if (!isRecord(raw)) return undefined
  const nodeId = stringField(raw.nodeId)
  const sessionId = stringField(raw.sessionId)
  const cursor = numberField(raw.cursor)
  const eventType = stringField(raw.eventType)
  // cursor 0 is legitimate (§8.2 counts from zero), so test for `undefined`,
  // not falsiness — `!cursor` would silently drop the first event of a session.
  if (nodeId === undefined || sessionId === undefined || cursor === undefined || eventType === undefined) {
    return undefined
  }
  const summary = stringField(raw.summary)
  const body = stringField(raw.body)
  const ref = stringField(raw.ref)
  return {
    nodeId,
    sessionId,
    cursor,
    eventType,
    ...summary === undefined ? {} : { summary },
    ...body === undefined ? {} : { body },
    ...ref === undefined ? {} : { ref },
    at: numberField(raw.at) ?? 0,
  }
}

/**
 * One `GET /v1/agent/workspaces` row (PPE-1 增补 §4).
 *
 * `wsId` is the frame's only required key (增补 §2.2), so a row without it is
 * not a workspace: dropped rather than rendered with an empty group key.
 */
function normalizeWorkspace(raw: unknown): TidingsWorkspaceView | undefined {
  if (!isRecord(raw)) return undefined
  const nodeId = stringField(raw.nodeId)
  const wsId = stringField(raw.wsId)
  if (nodeId === undefined || wsId === undefined) return undefined
  const agentKey = stringField(raw.agentKey)
  const wsTitle = stringField(raw.wsTitle)
  const wsPath = stringField(raw.wsPath)
  const agentId = stringField(raw.agentId)
  const agentKind = stringField(raw.agentKind)
  const online = booleanField(raw.online)
  const sessionCount = numberField(raw.sessionCount)
  return {
    nodeId,
    wsId,
    ...agentKey === undefined ? {} : { agentKey },
    ...wsTitle === undefined ? {} : { wsTitle },
    ...wsPath === undefined ? {} : { wsPath },
    // agentId 与 agentKey 都透给面板：agentKey 是归组键（= agentId ?? agentKind），
    // agentId 是原值（改名可迁移，见手机端 WorkspaceUi 的同一条 KDoc）。
    ...agentId === undefined ? {} : { agentId },
    ...agentKind === undefined ? {} : { agentKind },
    ...online === undefined ? {} : { online },
    ...sessionCount === undefined ? {} : { sessionCount },
    updatedAt: numberField(raw.updatedAt) ?? 0,
  }
}

/** 授权策略取值（`AgentGrantPolicies`）；未知值不猜，回 `undefined`。 */
function grantPolicyField(value: unknown): TidingsGrantPolicy | undefined {
  return value === 'auto' || value === 'byDevice' || value === 'request' ? value : undefined
}

/** 授权粒度取值（`AgentGrantScopes`）。 */
function grantScopeField(value: unknown): TidingsGrantScope | undefined {
  return value === 'all' || value === 'agent' ? value : undefined
}

/**
 * One grant row (`GET /v1/agent/grants`, PPE-1 增补 §3.3).
 *
 * `scope` decides whether `agentKey` means anything, so an unrecognized scope
 * drops the row: rendering it would show a whitelist entry the node itself
 * would not match against.
 */
function normalizeGrant(raw: unknown): TidingsGrantView | undefined {
  if (!isRecord(raw)) return undefined
  const nodeId = stringField(raw.nodeId)
  const scope = grantScopeField(raw.scope)
  if (nodeId === undefined || scope === undefined) return undefined
  const agentKey = stringField(raw.agentKey)
  const grantedBy = stringField(raw.grantedBy)
  return {
    nodeId,
    scope,
    ...agentKey === undefined ? {} : { agentKey },
    grantedAt: numberField(raw.grantedAt) ?? 0,
    ...grantedBy === undefined ? {} : { grantedBy },
  }
}

/** One pending grant request (`GET /v1/agent/grants`). */
function normalizeGrantRequest(raw: unknown): TidingsGrantRequestView | undefined {
  if (!isRecord(raw)) return undefined
  const nodeId = stringField(raw.nodeId)
  if (nodeId === undefined) return undefined
  const agentKey = stringField(raw.agentKey)
  const reason = stringField(raw.reason)
  return {
    nodeId,
    ...agentKey === undefined ? {} : { agentKey },
    ...reason === undefined ? {} : { reason },
    at: numberField(raw.at) ?? 0,
  }
}

/**
 * Shape one `grant` / `revoke` entry for the PUT body.
 *
 * `scope=agent` without an `agentKey` is refused here rather than at the node:
 * the key is what groups the grant (§3.3), and the node's own 400 for it says
 * the same thing. Saying it early keeps the failure message about *this*
 * caller's arguments.
 */
function grantWriteBody(entry: TidingsGrantWriteEntry, kind: 'grant' | 'revoke'): Record<string, unknown> {
  const nodeId = cleanOptional(entry.nodeId)
  if (nodeId === undefined) throw new TidingsRequestError('bad-request', `${kind} 需要 nodeId`)
  if (grantScopeField(entry.scope) === undefined) {
    throw new TidingsRequestError('bad-request', `${kind} 的 scope 只能是 all / agent；收到「${String(entry.scope)}」`)
  }
  const agentKey = cleanOptional(entry.agentKey)
  if (entry.scope === 'agent' && agentKey === undefined) {
    throw new TidingsRequestError('bad-request', `${kind} 的 scope=agent 时 agentKey 必填（缺了它无法归组）`)
  }
  const body: Record<string, unknown> = { nodeId, scope: entry.scope }
  if (agentKey !== undefined) body.agentKey = agentKey
  if (kind === 'grant' && entry.grantedBy !== undefined) body.grantedBy = entry.grantedBy
  return body
}

/** Shape one `grantReply` entry: the node validates state against `AgentGrantStates`. */
function grantReplyBody(entry: TidingsGrantReplyEntry): Record<string, unknown> {
  const nodeId = cleanOptional(entry.nodeId)
  if (nodeId === undefined) throw new TidingsRequestError('bad-request', 'grantReply 需要 nodeId')
  const state: TidingsGrantState | undefined =
    entry.state === 'approved' || entry.state === 'denied' || entry.state === 'revoked' ? entry.state : undefined
  if (state === undefined) {
    throw new TidingsRequestError('bad-request', `grantReply 的 state 只能是 approved / denied / revoked；收到「${String(entry.state)}」`)
  }
  if (grantScopeField(entry.scope) === undefined) {
    throw new TidingsRequestError('bad-request', `grantReply 的 scope 只能是 all / agent；收到「${String(entry.scope)}」`)
  }
  const agentKey = cleanOptional(entry.agentKey)
  const body: Record<string, unknown> = { nodeId, state, scope: entry.scope }
  if (agentKey !== undefined) body.agentKey = agentKey
  return body
}

function normalizePeer(raw: unknown): TidingsPeerView | undefined {
  if (!isRecord(raw)) return undefined
  const host = stringField(raw.ip) ?? stringField(raw.host) ?? ''
  const udpPort = numberField(raw.udpPort)
  const nodeId = stringField(raw.nodeId) ?? (host.length === 0 ? undefined : `${host}:${String(udpPort ?? 0)}`)
  if (nodeId === undefined) return undefined
  const tcpPort = numberField(raw.tcpPort)
  const profileRev = numberField(raw.profileRev)
  return {
    nodeId,
    nick: stringField(raw.nick) ?? nodeId,
    host,
    ...udpPort === undefined ? {} : { udpPort },
    ...tcpPort === undefined ? {} : { tcpPort },
    platform: stringField(raw.platform) ?? '',
    online: booleanField(raw.online) ?? false,
    lastSeen: numberField(raw.lastSeen) ?? 0,
    ...profileRev === undefined ? {} : { profileRev },
  }
}

function normalizeMessage(raw: unknown, labels: ReadonlyMap<string, string>): TidingsMessageView | undefined {
  if (!isRecord(raw)) return undefined
  const seq = numberField(raw.seq)
  if (seq === undefined) return undefined
  const peerId = stringField(raw.peerId) ?? ''
  const envelope = isRecord(raw.envelope) ? raw.envelope : {}
  const payload = isRecord(envelope.payload) ? envelope.payload : {}
  return {
    seq,
    peerId,
    peerLabel: labels.get(peerId) ?? (peerId.length === 0 ? '未知节点' : peerId),
    direction: raw.direction === 'in' ? 'in' : 'out',
    at: numberField(raw.at) ?? 0,
    kind: stringField(payload.kind) ?? 'unknown',
    text: typeof payload.text === 'string' ? payload.text : '',
  }
}

export class TidingsClient {
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  configView(): ResolvedConfig {
    return this.config
  }

  /** Read node identity and counters. */
  async health(): Promise<TidingsHealthView> {
    return normalizeHealth(await this.request({ path: '/healthz' }))
  }

  /** Read the current neighbour list. */
  async peers(): Promise<readonly TidingsPeerView[]> {
    const body = await this.request({ path: '/v1/peers' })
    const raw = isRecord(body) ? arrayField(body.peers) : []
    return raw.map(normalizePeer).filter((peer): peer is TidingsPeerView => peer !== undefined)
  }

  /** Read messages after `since`, newest `limit` kept. */
  async inbox(args: TidingsInboxArgs = {}): Promise<TidingsInboxView> {
    const since = Math.max(args.since ?? 0, 0)
    const limit = Math.min(Math.max(args.limit ?? this.config.inboxLimit, 1), 200)
    const body = await this.request({ path: '/v1/inbox', query: { since, limit } })
    const root = isRecord(body) ? body : {}
    const raw = arrayField(root.messages)
    const labels = new Map((await this.safePeers()).map(peer => [peer.nodeId, peer.nick]))
    const messages = raw
      .map(entry => normalizeMessage(entry, labels))
      .filter((message): message is TidingsMessageView => message !== undefined)
    // The control plane ignores `limit` and answers every message after
    // `since`, so the cap is applied here to keep the newest `limit` rows.
    return {
      since: numberField(root.since) ?? since,
      nextSince: numberField(root.nextSince) ?? since,
      messages: messages.slice(-limit),
    }
  }

  /** Send one text message; `queued` means the peer is offline and unread. */
  async send(args: TidingsSendArgs): Promise<TidingsSendReceiptView> {
    const to = cleanOptional(args.to)
    if (to === undefined) throw new TidingsRequestError('bad-request', '请先选择或填写收件人')
    const text = args.text.trim()
    if (text.length === 0) throw new TidingsRequestError('bad-request', '消息内容不能为空')
    const port = args.port ?? this.config.defaultPort
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TidingsRequestError('bad-request', '端口必须在 1 到 65535 之间')
    const body = await this.request({ method: 'POST', path: '/v1/send', body: { to, text, port } })
    const value = isRecord(body) ? body : {}
    return {
      status: value.status === 'queued' ? 'queued' : 'sent',
      to: stringField(value.to) ?? to,
      toHost: stringField(value.toHost) ?? '',
      note: stringField(value.note) ?? '',
    }
  }

  /** Declare or update an Agent session (PPE-1 §6.1). */
  async agentSession(args: TidingsAgentSessionArgs): Promise<TidingsAgentReceiptView> {
    const to = cleanOptional(args.to)
    if (to === undefined) throw new TidingsRequestError('bad-request', '请先选择或填写收件人')
    const sessionId = cleanOptional(args.sessionId)
    if (sessionId === undefined) throw new TidingsRequestError('bad-request', 'sessionId 不能为空')
    const port = args.port ?? this.config.defaultPort
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TidingsRequestError('bad-request', '端口必须在 1 到 65535 之间')
    const requestBody: Record<string, unknown> = { to, sessionId, port }
    if (args.alias !== undefined) requestBody.alias = args.alias
    if (args.agentKind !== undefined) requestBody.agentKind = args.agentKind
    if (args.state !== undefined) requestBody.state = args.state
    if (args.title !== undefined) requestBody.title = args.title
    if (args.startedAt !== undefined) requestBody.startedAt = args.startedAt
    // PPE-1 增补 D1/D6：四个新可选键原样透传（cap 门控在 agentNode 投递层，不在这里）。
    if (args.agentId !== undefined) requestBody.agentId = args.agentId
    if (args.wsId !== undefined) requestBody.wsId = args.wsId
    if (args.wsTitle !== undefined) requestBody.wsTitle = args.wsTitle
    if (args.wsPath !== undefined) requestBody.wsPath = args.wsPath
    // 活动时刻（排序键）：与 startedAt 同档，原样透传。
    if (args.updatedAt !== undefined) requestBody.updatedAt = args.updatedAt
    // 可见性两键（与 DSH 的 sessionVisible() 同口径）：手机拿它们在展示层过滤
    // 子代理会话与空壳会话。**分页那一页必须带**这些键，否则手机对历史会话
    // 永远学不会「这条该藏」。
    if (args.origin !== undefined) requestBody.origin = args.origin
    if (args.blank !== undefined) requestBody.blank = args.blank

    const body = await this.request({ method: 'POST', path: '/v1/agent/session', body: requestBody })
    const value = isRecord(body) ? body : {}
    return {
      status: value.status === 'queued' ? 'queued' : 'sent',
      to: stringField(value.to) ?? to,
      type: 'agent-session',
      note: stringField(value.note) ?? '',
    }
  }

  /** Emit an event for an ongoing Agent session (PPE-1 §6.2). */
  async agentEvent(args: TidingsAgentEventArgs): Promise<TidingsAgentReceiptView> {
    const to = cleanOptional(args.to)
    if (to === undefined) throw new TidingsRequestError('bad-request', '请先选择或填写收件人')
    const sessionId = cleanOptional(args.sessionId)
    if (sessionId === undefined) throw new TidingsRequestError('bad-request', 'sessionId 不能为空')
    const eventType = cleanOptional(args.eventType)
    if (eventType === undefined) throw new TidingsRequestError('bad-request', 'eventType 不能为空')
    if (!Number.isInteger(args.cursor) || args.cursor < 0) throw new TidingsRequestError('bad-request', 'cursor 必须是非负整数')
    const port = args.port ?? this.config.defaultPort
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TidingsRequestError('bad-request', '端口必须在 1 到 65535 之间')
    const requestBody: Record<string, unknown> = {
      to,
      sessionId,
      cursor: args.cursor,
      eventType,
      port,
    }
    if (args.summary !== undefined) requestBody.summary = args.summary
    if (args.body !== undefined) requestBody.body = args.body
    if (args.ref !== undefined) requestBody.ref = args.ref

    const body = await this.request({ method: 'POST', path: '/v1/agent/event', body: requestBody })
    const value = isRecord(body) ? body : {}
    return {
      status: value.status === 'queued' ? 'queued' : 'sent',
      to: stringField(value.to) ?? to,
      type: 'agent-event',
      note: stringField(value.note) ?? '',
    }
  }

  /**
   * Announce **one workspace of this host** (PPE-1 增补 §2.2, D3).
   *
   * Cap `aws1` gating lives in the node's delivery layer, not here: this call
   * only hands the frame over and reports the receipt. The control plane
   * requires `wsId`, and it 400s a non-boolean `online` rather than silently
   * dropping the key — both facts stay upstream; this client only refuses
   * obviously empty arguments so the failure message stays actionable.
   */
  async agentWorkspace(args: TidingsAgentWorkspaceArgs): Promise<TidingsAgentReceiptView> {
    const to = cleanOptional(args.to)
    if (to === undefined) throw new TidingsRequestError('bad-request', '请先选择或填写收件人')
    const wsId = cleanOptional(args.wsId)
    if (wsId === undefined) throw new TidingsRequestError('bad-request', 'wsId 不能为空（增补 §2.2 的必填键）')
    const port = args.port ?? this.config.defaultPort
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TidingsRequestError('bad-request', '端口必须在 1 到 65535 之间')
    const requestBody: Record<string, unknown> = { to, wsId, port }
    if (args.wsTitle !== undefined) requestBody.wsTitle = args.wsTitle
    if (args.wsPath !== undefined) requestBody.wsPath = args.wsPath
    // D6：归组键靠它与会话侧对齐（少了它，同一个工作区会在手机上被拆成两行）。
    if (args.agentId !== undefined) requestBody.agentId = args.agentId
    if (args.agentKind !== undefined) requestBody.agentKind = args.agentKind
    if (args.online !== undefined) requestBody.online = args.online
    if (args.sessionCount !== undefined) {
      if (!Number.isInteger(args.sessionCount) || args.sessionCount < 0) {
        throw new TidingsRequestError('bad-request', 'sessionCount 必须是非负整数')
      }
      requestBody.sessionCount = args.sessionCount
    }
    // 注册表持久序（见 TidingsAgentWorkspaceArgs.order）。与 sessionCount 同款：形状错了就拒，
    // 不要把一个排不出序的值发到线上（控制面也会 400，这里先拦是为了报错更近）。
    if (args.order !== undefined) {
      if (!Number.isInteger(args.order) || args.order < 0) {
        throw new TidingsRequestError('bad-request', 'order 必须是非负整数')
      }
      requestBody.order = args.order
    }
    if (args.at !== undefined) requestBody.at = args.at

    const body = await this.request({ method: 'POST', path: '/v1/agent/workspace', body: requestBody })
    const value = isRecord(body) ? body : {}
    return {
      // 三档原样回给调用方：sent（对端 ACK）/ not-acked（对端是不认识这帧的旧版本 ——
      // 状态快照故意不入队、不标离线）/ queued（对端离线）。把 not-acked 折成 "sent"
      // 会让工具报告一件没发生的事（那个坑正是不入队设计要避免的）。
      status: value.status === 'queued' ? 'queued' : value.status === 'not-acked' ? 'not-acked' : 'sent',
      to: stringField(value.to) ?? to,
      type: 'agent-workspace',
      note: stringField(value.note) ?? '',
    }
  }

  /**
   * Read the node's workspace ledger (PPE-1 增补 §4, 「面板第三面」).
   *
   * Rows are the **node's** memory since it started — the same caveat as
   * `agentSessions()` carries. Pass `nodeId` to restrict the answer to one
   * peer: outbound rows are keyed by the target node, inbound ones by
   * `envelope.from`, so a mixed list is only meaningful once narrowed.
   */
  async agentWorkspaces(args: TidingsAgentWorkspacesArgs = {}): Promise<TidingsAgentWorkspacesView> {
    const nodeId = cleanOptional(args.nodeId)
    const body = await this.request({ path: '/v1/agent/workspaces', query: { nodeId } })
    const root = isRecord(body) ? body : {}
    const workspaces = arrayField(root.workspaces)
      .map(normalizeWorkspace)
      .filter((w): w is TidingsWorkspaceView => w !== undefined)
    return {
      workspaces,
      total: numberField(root.total) ?? workspaces.length,
    }
  }

  /**
   * Read this host's grant policy, whitelist, and pending requests
   * (PPE-1 增补 §3.3, D7).
   *
   * An unrecognized `policy` value is not guessed at: it throws. The panel
   * renders one of three tiers, and quietly defaulting to `auto` would display
   * "open to every added node" while the node enforces something else.
   */
  async grants(): Promise<TidingsGrantsView> {
    const body = await this.request({ path: '/v1/agent/grants' })
    const root = isRecord(body) ? body : {}
    const policy = grantPolicyField(root.policy)
    if (policy === undefined) {
      throw new TidingsRequestError('bad-response', `授权策略返回值不认识：${String(JSON.stringify(root.policy ?? null))}`)
    }
    const grants = arrayField(root.grants)
      .map(normalizeGrant)
      .filter((g): g is TidingsGrantView => g !== undefined)
    const requests = arrayField(root.requests)
      .map(normalizeGrantRequest)
      .filter((g): g is TidingsGrantRequestView => g !== undefined)
    return { policy, grants, requests }
  }

  /**
   * Write the grant policy / whitelist (PPE-1 增补 §3.3, D7; `PUT /v1/agent/grants`).
   *
   * At least one of the four keys must be present — the node 400s an empty
   * body, so the client refuses it first with a message that names the keys.
   * `request()` passes any HTTP method through to node:http, so PUT needs no
   * extra transport work.
   */
  async writeGrants(args: TidingsGrantsWriteArgs): Promise<TidingsGrantsWriteView> {
    const requestBody: Record<string, unknown> = {}
    if (args.policy !== undefined) {
      if (grantPolicyField(args.policy) === undefined) {
        throw new TidingsRequestError('bad-request', `policy 只能是 auto / byDevice / request；收到「${String(args.policy)}」`)
      }
      requestBody.policy = args.policy
    }
    if (args.grant !== undefined) requestBody.grant = grantWriteBody(args.grant, 'grant')
    if (args.revoke !== undefined) requestBody.revoke = grantWriteBody(args.revoke, 'revoke')
    if (args.grantReply !== undefined) requestBody.grantReply = grantReplyBody(args.grantReply)
    if (Object.keys(requestBody).length === 0) {
      throw new TidingsRequestError('bad-request', 'policy / grant / revoke / grantReply 至少要带一个')
    }
    const body = await this.request({ method: 'PUT', path: '/v1/agent/grants', body: requestBody })
    const root = isRecord(body) ? body : {}
    const policy = grantPolicyField(root.policy)
    if (policy === undefined) {
      throw new TidingsRequestError('bad-response', `授权策略返回值不认识：${String(JSON.stringify(root.policy ?? null))}`)
    }
    return {
      ok: booleanField(root.ok) ?? false,
      policy,
      notes: arrayField(root.notes).map(entry => stringField(entry) ?? '').filter(entry => entry.length > 0),
    }
  }

  /**
   * Read the public-tidings pairing code.
   *
   * The control plane answers one of three shapes and all three are worth
   * showing, so this returns them discriminated rather than throwing: a code,
   * a too-long fallback that still carries the text, or the reason no code can
   * be made. Only genuine transport failures throw.
   */
  async pairingQr(): Promise<TidingsPairingQrResult> {
    const body = await this.request({ path: '/v1/pairing-qr' })
    const value = isRecord(body) ? body : {}
    if (value.tooLong === true) {
      return {
        kind: 'tooLong',
        tooLong: true,
        payload: stringField(value.payload) ?? '',
        bytes: numberField(value.bytes) ?? 0,
        capacity: numberField(value.capacity) ?? 0,
      }
    }
    if (arrayField(value.modules).length > 0 && numberField(value.size) !== undefined) {
      return {
        kind: 'code',
        payload: stringField(value.payload) ?? '',
        version: numberField(value.version) ?? 0,
        size: numberField(value.size) ?? 0,
        mask: numberField(value.mask) ?? 0,
        modules: arrayField(value.modules).map(entry => entry === true),
        needsToken: booleanField(value.needsToken) ?? false,
      }
    }
    // Neither shape: the node declined. Surface its reason verbatim — "no public
    // URL configured" is actionable, a generic failure is not.
    return {
      kind: 'missing',
      configured: false,
      reason: stringField(value.message)
        ?? stringField(value.error)
        ?? '控制面没有给出配对码所需的数据。',
    }
  }

  /** Read the pending `agent-session-page` requests the node is holding for us. */
  async sessionPages(): Promise<TidingsSessionPagesView> {
    const body = await this.request({ path: '/v1/agent/session-pages' })
    const root = isRecord(body) ? body : {}
    const requests = arrayField(root.requests)
      .map(normalizeSessionPageRequest)
      .filter((r): r is TidingsSessionPageRequestView => r !== undefined)
    return { requests, total: numberField(root.total) ?? requests.length }
  }

  /** Mark one answered request resolved (idempotent; `false` = it was already gone). */
  async resolveSessionPage(id: number): Promise<boolean> {
    const body = await this.request({
      path: '/v1/agent/session-pages/resolve',
      method: 'POST',
      body: { id },
    })
    return isRecord(body) && body.removed === true
  }

  /**
   * Read the node's agent-session ledger (PPE-1 §6.1/§6.2).
   *
   * Distinct from `inbox()` on purpose: agent frames never enter the chat
   * store, so asking for them through the message stream would return nothing
   * (or noise). Pass `sessionId` to also get that session's event list, and
   * `nodeId` to restrict the answer to one node.
   *
   * `nodeId` is not decoration: two nodes may report the same `sessionId`, so a
   * bare-id detail request can come back with another node's rows for that id.
   */
  async agentSessions(
    args: { readonly sessionId?: string | undefined; readonly nodeId?: string | undefined } = {},
  ): Promise<TidingsAgentSessionsView> {
    const sessionId = cleanOptional(args.sessionId)
    const nodeId = cleanOptional(args.nodeId)
    const body = await this.request({
      path: '/v1/agent/sessions',
      // Both keys are dropped when undefined (appendQuery skips undefined).
      query: { sessionId, nodeId },
    })
    const root = isRecord(body) ? body : {}
    const sessions = arrayField(root.sessions)
      .map(normalizeAgentSession)
      .filter((s): s is TidingsAgentSessionView => s !== undefined)
    // The discriminator is **whether we asked**, not whether the array is empty:
    // a session that was named but has no events yet must come back as `[]`, or
    // the panel cannot tell "no events yet" from "you didn't ask for events".
    // (Keying off `length === 0` collapsed those two — caught by check-real's
    // "点名时 events 是数组" assertion.)
    const events = sessionId === undefined
      ? undefined
      : arrayField(root.events)
        .map(normalizeAgentEvent)
        .filter((e): e is TidingsAgentEventView => e !== undefined)
    return {
      sessions,
      ...events === undefined ? {} : { events },
      total: numberField(root.total) ?? sessions.length,
    }
  }

  /** Report whether the optional control-plane token is present. */
  async describeCredential(): Promise<TidingsCredentialView> {
    const credential = this.config.tokenCredentialRef
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) return { credentialRef: credential, configured: false, writable: false }
    const info = await credentials.describe(credential)
    return {
      credentialRef: credential,
      configured: info.configured,
      writable: info.writable,
      ...info.source === undefined ? {} : { source: info.source },
    }
  }

  /** Store the optional token; the value never leaves this call. */
  async setCredential(value: string): Promise<TidingsCredentialSavedView> {
    const credential = this.config.tokenCredentialRef
    const trimmed = value.trim()
    if (trimmed.length === 0) throw new TidingsRequestError('bad-request', '令牌不能为空')
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) throw new TidingsRequestError('internal', '凭据服务未挂载，无法保存令牌')
    await credentials.set(credential, trimmed)
    return { credentialRef: credential, configured: true }
  }

  /** Remove the stored token; the node stays reachable when it has no token. */
  async clearCredential(): Promise<TidingsCredentialSavedView> {
    const credential = this.config.tokenCredentialRef
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) throw new TidingsRequestError('internal', '凭据服务未挂载，无法清除令牌')
    await credentials.unset(credential)
    return { credentialRef: credential, configured: false }
  }

  private async safePeers(): Promise<readonly TidingsPeerView[]> {
    try {
      return await this.peers()
    } catch {
      return []
    }
  }

  private async resolveToken(): Promise<string | undefined> {
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) return (await credentials.resolve(this.config.tokenCredentialRef))?.value
    const value = process.env[this.config.tokenCredentialRef]
    return value === undefined || value.length === 0 ? undefined : value
  }

  private async request(options: TidingsRequestOptions): Promise<unknown> {
    const target = new URL(options.path, `${this.config.baseUrl}/`)
    appendQuery(target, options.query)
    const method = options.method ?? 'GET'
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)
    const token = await this.resolveToken()
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': 'dsh-tidings-bridge/0.1.0',
      ...token === undefined ? {} : { authorization: `Bearer ${token}` },
      ...body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    }
    const response = await requestJson(target, { method, headers }, body, this.config.timeoutMs)
    if ((response.statusCode >= 300 && response.statusCode < 400) || response.headers.location !== undefined) {
      throw new TidingsRequestError('bad-response', `${method} ${target.pathname} 返回了重定向；控制面请求不跟随重定向`, response.statusCode)
    }
    const parsed = response.body.trim().length === 0 ? {} : parseJsonBody(response.body, method, target)
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new TidingsRequestError(
        errorCodeFromBody(parsed) ?? errorCodeForStatus(response.statusCode),
        httpErrorMessage(method, target, response.statusCode, parsed),
        response.statusCode,
      )
    }
    return parsed
  }
}

/**
 * Build a client for one configuration.
 * @param ctx - the Host plugin context, used for the credentials service.
 * @param config - raw configuration.
 * @returns the client.
 */
export function createTidingsClient(ctx: Context, config: Config): TidingsClient {
  return new TidingsClient(ctx, resolveConfig(config))
}

/** Internals exported for tests only. */
export const internals = {
  errorCodeForStatus,
  normalizeHealth,
  normalizeMessage,
  normalizePeer,
  resolveConfig,
}
