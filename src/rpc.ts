/**
 * Host half of the Tidings panel's loopback RPC channel.
 *
 * Every endpoint reads or writes the local agentNode control plane through
 * {@link TidingsClient}. The optional token is written through the DSH
 * credentials provider and is never returned; status reports only presence.
 *
 * @module dsh-tidings/rpc
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-client-connection'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createTidingsClient, TidingsRequestError } from './tidings.ts'
import { sanitizeTidingsConfigPatch, TidingsConfigStore } from './config-store.ts'
import {
  TIDINGS_RPC_CHANNEL,
  type TidingsAgentWorkspacesArgs,
  type TidingsClearCredentialArgs,
  type TidingsCredentialSavedView,
  type TidingsCredentialView,
  type TidingsErrorCode,
  type TidingsGrantPolicy,
  type TidingsGrantsWriteArgs,
  type TidingsGrantScope,
  type TidingsGrantState,
  type TidingsInboxArgs,
  type TidingsRpcError,
  type TidingsSaveConfigArgs,
  type TidingsSaveCredentialArgs,
  type TidingsSendArgs,
  type TidingsStatusView,
} from './model.ts'

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(payload: unknown, field: string): string | undefined {
  if (!isRecord(payload)) return undefined
  const value = payload[field]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function numberField(payload: unknown, field: string): number | undefined {
  if (!isRecord(payload)) return undefined
  const value = payload[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function inboxArgs(payload: unknown): TidingsInboxArgs {
  const since = numberField(payload, 'since')
  const limit = numberField(payload, 'limit')
  return {
    ...since === undefined ? {} : { since },
    ...limit === undefined ? {} : { limit },
  }
}

function agentSessionsArgs(payload: unknown): { readonly sessionId?: string; readonly nodeId?: string } {
  // Trim to nothing means "no filter": an empty string would be sent as
  // `sessionId=` and the control plane would filter on a session that cannot
  // exist, silently returning an empty ledger.
  const sessionId = stringField(payload, 'sessionId')?.trim()
  // `nodeId` restricts the query to one node. It matters because two nodes may
  // report the same `sessionId`: without it, asking for a session's events can
  // return another node's rows for the same id.
  const nodeId = stringField(payload, 'nodeId')?.trim()
  return {
    ...sessionId === undefined || sessionId.length === 0 ? {} : { sessionId },
    ...nodeId === undefined || nodeId.length === 0 ? {} : { nodeId },
  }
}

/** `agentWorkspaces` 的参数：`nodeId` 为空串时按「不过滤」处理（与 `agentSessionsArgs` 同纪律）。 */
function agentWorkspacesArgs(payload: unknown): TidingsAgentWorkspacesArgs {
  const nodeId = stringField(payload, 'nodeId')?.trim()
  return nodeId === undefined || nodeId.length === 0 ? {} : { nodeId }
}

const GRANT_POLICIES: readonly TidingsGrantPolicy[] = ['auto', 'byDevice', 'request']
const GRANT_SCOPES: readonly TidingsGrantScope[] = ['all', 'agent']
const GRANT_STATES: readonly TidingsGrantState[] = ['approved', 'denied', 'revoked']

/** Narrow an untrusted scope string; the node validates the same set. */
function isGrantScope(value: string): value is TidingsGrantScope {
  return (GRANT_SCOPES as readonly string[]).includes(value)
}

function isGrantState(value: string): value is TidingsGrantState {
  return (GRANT_STATES as readonly string[]).includes(value)
}

function isGrantPolicy(value: string): value is TidingsGrantPolicy {
  return (GRANT_POLICIES as readonly string[]).includes(value)
}

/**
 * Pick the first non-empty object out of the payload's four write keys and
 * shape it into {@link TidingsGrantsWriteArgs}.
 *
 * Unknown / out-of-range enum values are dropped rather than forwarded: the
 * node 400s them, but a panel that mistypes a scope should see *which* key the
 * Host gave up on, so the reason travels back in the thrown message below.
 */
function grantsWriteArgs(payload: unknown): TidingsGrantsWriteArgs {
  if (!isRecord(payload)) return {}
  const rawPolicy = stringField(payload, 'policy')
  if (rawPolicy !== undefined && !isGrantPolicy(rawPolicy)) {
    throw new Error(`policy 只能是 auto / byDevice / request；收到「${rawPolicy}」`)
  }
  const policy = rawPolicy
  // Each entry is validated into its own typed shape before it is assembled.
  // Assembling into an untyped record and casting at the end would let a wrong
  // enum string travel to the client, which re-validates but reports *its* own
  // message rather than this endpoint's.
  const grant = grantWriteEntry(payload.grant, 'grant')
  const revoke = grantWriteEntry(payload.revoke, 'revoke')
  const grantReply = grantReplyEntry(payload.grantReply)
  return {
    ...policy === undefined ? {} : { policy },
    ...grant === undefined ? {} : { grant },
    ...revoke === undefined ? {} : { revoke },
    ...grantReply === undefined ? {} : { grantReply },
  }
}

function grantWriteEntry(
  raw: unknown,
  kind: 'grant' | 'revoke',
): TidingsGrantsWriteArgs['grant'] | undefined {
  if (!isRecord(raw)) return undefined
  const nodeId = stringField(raw, 'nodeId')
  if (nodeId === undefined) throw new Error(`${kind} 需要 nodeId`)
  const scope = stringField(raw, 'scope')
  if (scope === undefined || !isGrantScope(scope)) throw new Error(`${kind} 需要 scope（all / agent）`)
  const agentKey = stringField(raw, 'agentKey')
  if (scope === 'agent' && agentKey === undefined) throw new Error(`${kind} 的 scope=agent 时 agentKey 必填`)
  const grantedBy = kind === 'grant' ? stringField(raw, 'grantedBy') : undefined
  return {
    nodeId,
    scope,
    ...agentKey === undefined ? {} : { agentKey },
    ...grantedBy === undefined ? {} : { grantedBy },
  }
}

function grantReplyEntry(raw: unknown): TidingsGrantsWriteArgs['grantReply'] | undefined {
  if (!isRecord(raw)) return undefined
  const nodeId = stringField(raw, 'nodeId')
  if (nodeId === undefined) throw new Error('grantReply 需要 nodeId')
  const state = stringField(raw, 'state')
  if (state === undefined || !isGrantState(state)) {
    throw new Error('grantReply 需要 state（approved / denied / revoked）')
  }
  const scope = stringField(raw, 'scope')
  if (scope === undefined || !isGrantScope(scope)) throw new Error('grantReply 需要 scope（all / agent）')
  const agentKey = stringField(raw, 'agentKey')
  return { nodeId, state, scope, ...agentKey === undefined ? {} : { agentKey } }
}

function sendArgs(payload: unknown): TidingsSendArgs {  const raw = isRecord(payload) ? payload : {}
  const port = numberField(payload, 'port')
  return {
    to: stringField(payload, 'to') ?? '',
    text: typeof raw.text === 'string' ? raw.text : '',
    ...port === undefined ? {} : { port },
  }
}

function saveConfigArgs(payload: unknown): TidingsSaveConfigArgs {
  const config = isRecord(payload) && isRecord(payload.config) ? payload.config : {}
  return { config: sanitizeTidingsConfigPatch(config) }
}

function saveCredentialArgs(payload: unknown): TidingsSaveCredentialArgs {
  return { credentialRef: stringField(payload, 'credentialRef') ?? '', value: stringField(payload, 'value') ?? '' }
}

function clearCredentialArgs(payload: unknown): TidingsClearCredentialArgs {
  return { credentialRef: stringField(payload, 'credentialRef') ?? '' }
}

function errorCodeOf(error: unknown): TidingsErrorCode {
  return error instanceof TidingsRequestError ? error.code : 'internal'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 凭据台账的读法，**带时限**。
 *
 * ## 为什么必须有时限（2026-10-14 真机抓到：卡片永远停在「检查中…」）
 *
 * `statusView` 先 `await` 这个函数、再去探控制面。而它内部 `await credentials.describe(...)`
 * 没有任何超时 —— 凭据服务一旦不回（未就绪、等一个拿不到的钥匙串），**整个 status RPC
 * 永远不返回**，设置页那张卡片就永远停在「检查中…」，按钮永远禁用，屏幕上没有一句话说
 * 为什么。而我给它加的 catch 接不住这种情况：**挂起不是失败，它不会 reject。**
 *
 * 凭据台账只是状态页的**附属信息**（面板本来就为「读不到」准备了降级形状），所以它不该
 * 有能力拖住整个状态读取。超时就退回那个降级形状 —— 如实说「configured: false」，
 * 而不是让用户看着一张死卡片。
 */
async function credentialView(ctx: Context, store: TidingsConfigStore): Promise<TidingsCredentialView> {
  const fallback = (): TidingsCredentialView => {
    const client = createTidingsClient(ctx, store.current())
    return { credentialRef: client.configView().tokenCredentialRef, configured: false, writable: false }
  }
  try {
    return await Promise.race([
      createTidingsClient(ctx, store.current()).describeCredential(),
      new Promise<TidingsCredentialView>(resolve => {
        // 2 秒足够一次本地读；超过它，凭据服务就没在正常工作。
        const timer = setTimeout(() => resolve(fallback()), 2_000)
        // 不让这个定时器拖住宿主退出（unref 在 Node 里存在；浏览器端没有它）。
        if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      }),
    ])
  } catch {
    return fallback()
  }
}

/**
 * Probe the control plane without letting a failure hide the settings: the
 * panel needs config and credential facts even while the node is down.
 */
async function statusView(ctx: Context, store: TidingsConfigStore): Promise<TidingsStatusView> {
  const config = store.view()
  const credential = await credentialView(ctx, store)
  try {
    const health = await createTidingsClient(ctx, store.current()).health()
    return { state: health.ok ? 'online' : 'error', health, config, credential }
  } catch (error) {
    const code = errorCodeOf(error)
    const state = code === 'unauthorized' ? 'unauthorized' : code === 'unreachable' || code === 'timeout' ? 'unreachable' : 'error'
    return { state, config, credential, errorCode: code, errorMessage: messageOf(error) }
  }
}

async function saveCredential(ctx: Context, args: TidingsSaveCredentialArgs): Promise<TidingsCredentialSavedView> {
  const ref = credentialRef(args.credentialRef)
  return await createTidingsClient(ctx, { tokenCredentialRef: ref }).setCredential(args.value)
}

async function clearCredential(ctx: Context, args: TidingsClearCredentialArgs): Promise<TidingsCredentialSavedView> {
  const ref = credentialRef(args.credentialRef)
  return await createTidingsClient(ctx, { tokenCredentialRef: ref }).clearCredential()
}

function ok(value: unknown): { readonly ok: true; readonly value: JsonValue } {
  return { ok: true, value: asJson(value) }
}

function failure(error: unknown): { readonly ok: false; readonly error: TidingsRpcError } {
  return { ok: false, error: { code: errorCodeOf(error), message: messageOf(error), details: {} } }
}

/**
 * Mount the panel's RPC channel on the Host connection service.
 * @param ctx - the Host plugin context; must inject `connection`.
 * @param store - the settings store shared with the agent tools.
 */
/**
 * 处理器被调用过几次（诊断用）。
 *
 * 为什么需要它（2026-10-15）：通道挂载报 `ok`，而浏览器那条 `POST /tidings-pantry/status`
 * 永远 pending。这时只有两种可能，且**它们要分别处理**：①请求根本没进处理器（路由没生效/
 * 被别的东西截了）；②处理器跑了但响应没回到浏览器。数一下调用次数就能分开。
 */
export let tidingsRpcCalls = 0

export function registerTidingsRpc(ctx: Context, store: TidingsConfigStore): void {
  ctx.connection.rpc.handle(TIDINGS_RPC_CHANNEL, async (endpoint, payload) => {
    tidingsRpcCalls += 1
    try {
      switch (endpoint) {
        case 'status':
          return ok(await statusView(ctx, store))
        case 'config':
          return ok(store.view())
        case 'saveConfig':
          return ok(store.save(saveConfigArgs(payload).config))
        case 'saveCredential':
          return ok(await saveCredential(ctx, saveCredentialArgs(payload)))
        case 'clearCredential':
          return ok(await clearCredential(ctx, clearCredentialArgs(payload)))
        case 'peers':
          return ok(await createTidingsClient(ctx, store.current()).peers())
        case 'inbox':
          return ok(await createTidingsClient(ctx, store.current()).inbox(inboxArgs(payload)))
        case 'send':
          return ok(await createTidingsClient(ctx, store.current()).send(sendArgs(payload)))
        case 'pairingQr':
          return ok(await createTidingsClient(ctx, store.current()).pairingQr())
        case 'agentSessions':
          return ok(await createTidingsClient(ctx, store.current()).agentSessions(agentSessionsArgs(payload)))
        case 'agentWorkspaces':
          return ok(await createTidingsClient(ctx, store.current()).agentWorkspaces(agentWorkspacesArgs(payload)))
        case 'grants':
          return ok(await createTidingsClient(ctx, store.current()).grants())
        case 'writeGrants':
          return ok(await createTidingsClient(ctx, store.current()).writeGrants(grantsWriteArgs(payload)))
        default:
          return failure(new Error(`未知的捎话接口：${endpoint}`))
      }
    } catch (error) {
      return failure(error)
    }
  })
}
