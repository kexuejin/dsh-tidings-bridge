/**
 * Automatic announcement of this host's DSH sessions to the local agentNode.
 *
 * The agent tools (`tidings_agent_session` / `tidings_agent_event`) are *manual*:
 * nothing says an agent will ever call them, so a phone would only ever see a
 * host that remembers to report itself. This module subscribes to the Session
 * lifecycle and does it without being asked — session frames (PPE-1 §6.1 with
 * 增补 D1/D6 keys), event frames (§6.2), and the workspace frame that covers
 * 「工作区存在但还没有任何会话」 (增补 D3).
 *
 * Two constraints shape the design:
 *
 *  1. **The host must never notice.** A synchronous throw in `session/created`
 *     vetoes creation and rolls the session back (core/session `Events` KDoc),
 *     and a `session/event` throw is logged as a broken observer on every
 *     append. So every path here is run-catching: no tidings availability, peer
 *     availability, or ledger write may reach the caller, and nothing is
 *     awaited before the listener returns.
 *  2. **`session/event` is a firehose.** One turn emits dozens of events, and
 *     every frame is an HTTP request to the control plane plus a network
 *     delivery. Events are therefore coalesced per session behind a trailing
 *     throttle, and a turn boundary flushes what is pending immediately so the
 *     phone's view of "busy → idle" is never delayed by the window.
 *
 * @module dsh-tidings/announce
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TidingsClient, ResolvedConfig } from './tidings.ts'
import { TidingsRequestError } from './tidings.ts'
import type {
  TidingsAgentAttachment,
  TidingsAgentEventArgs,
  TidingsAgentSessionArgs,
  TidingsAgentWorkspaceArgs,
  TidingsPeerView,
} from './model.ts'
import type { TidingsWorkspaceRegistry } from './workspace-registry.ts'

/** Trailing throttle window for event frames, in milliseconds. */
const EVENT_THROTTLE_MS = 500

/** How long the discovered peer list stays reusable. */
const PEER_CACHE_MS = 60_000

/**
 * 状态快照的重申窗口：超过它就把同一份清单再发一遍。
 *
 * 选 60 秒是与宣告周期（10 秒）的折中：对上线的设备最多 1 分钟内拿到清单，而每个窗口
 * 的代价只是这一批幂等帧（15 个工作区 × 在线邻居）。
 */
const ANNOUNCE_REFRESH_MS = 60_000

/**
 * Cap on one session's pending event queue. A burst larger than this drops its
 * oldest entries rather than growing without bound: the phone is watching a
 * live feed, not reading an audit log.
 */
const MAX_PENDING_EVENTS = 16

/** Longest derived session title we will send (增补 §2.1: `AGENT_WS_TITLE = 200`). */
const MAX_TITLE_LENGTH = 200

/** One host session, as much as the announcement needs to know about it. */
export interface AnnounceSession {
  readonly id: string
  readonly cwd?: string | undefined
  /**
   * 会话的创建时刻（`SessionHeader.createdAt`，epoch 毫秒）。
   *
   * 它是**活动时刻的下界**：DSH 自己的会话列表（`sessionController.list()`）口径是
   * `max(createdAt, lastPromptAt)`，一个刚建好还没人说话的会话的活动时刻就是创建时刻。
   * 缺席时退回收帧那一刻（见 onCreated）。
   */
  readonly createdAt?: number | undefined
  /**
   * 会话的来源（`SessionHeader.origin`）。`'subagent'` = 子代理会话，不上手机。
   *
   * ## 为什么这个字段必须一路带到这里（2026-10-14 真机抓到）
   *
   * 用户报「工作区列表上显示的会话跟 DSH 上显示的不一样」。真机上多出来的那一截正是
   * 子代理会话：19 对「父会话 + MEMORY.md 归档子代理」被实时宣告推到了手机上，标题全是
   * 「Route this bounded MEMORY.md archive」，而 DSH 自己的工作区浏览器
   * （packages/client/ui-workspace/src/client/tree.ts 的 `sessionVisible()`）对
   * `origin === 'subagent'` **一律返回 false**。
   *
   * 两处口径必须同源：手机是同一份会话清单的另一个视图，DSH 藏起来的它也不该显示。
   * 分页那条路（index.ts 的 `visibleOnPhone`）早就有这条判据，缺的是实时这条路。
   */
  readonly origin?: 'subagent' | undefined
}

/** The session/event subset this module maps; every other type is ignored. */
const EVENT_TYPE_BY_SESSION_EVENT: Readonly<Record<string, string>> = {
  'turn/start': 'session.started',
  'user/message': 'user.message',
  'assistant/message': 'assistant.text',
  'tool/call': 'tool.started',
  'tool/result': 'tool.completed',
  'turn/end': 'turn.end',
}

/** A mapped event waiting for its window. */
interface PendingEvent {
  readonly eventType: string
  readonly summary?: string | undefined
  readonly body?: string | undefined
  readonly ref?: string | undefined
  readonly attachment?: TidingsAgentAttachment | undefined
}

/** Per-session announcement state. */
interface SessionTrack {
  /** Last state string already sent; a change is what triggers a session frame. */
  state: string | undefined
  /** Monotonic cursor counter, per session (PPE-1 §6.2: session-scoped order). */
  cursor: number
  /** Coalesced events not yet flushed. */
  pending: PendingEvent[]
  timer: ReturnType<typeof setTimeout> | undefined
  /** Whether the session frame was already announced. */
  announced: boolean
  /** Display title, derived from the first user message; sent once known. */
  title: string | undefined
  /** Session's working directory, as read at creation time. */
  cwd: string | undefined
  /**
   * 会话的创建时刻（epoch 毫秒），`onCreated` 时记下。
   *
   * 为什么 track 要单独记它：会话帧推迟到第一个映射事件才发（见 `onCreated`），那时
   * `Date.now()` 已经晚于创建时刻了，而 `startedAt`（手机上那句「开始于 …」）说的必须是
   * **创建**，不是「宣告」。不记就只能退回宣告那一刻，文案会说假话。
   */
  createdAt: number | undefined
  /**
   * 本会话最后一次活动时刻（epoch 毫秒），口径与 DSH 会话列表一致：
   * `max(createdAt, 最近一条用户消息的时间)`。
   *
   * 为什么必须由 track 记住而不是调用方每次现算：`session/event` 是**无状态的通知**
   * （每次只有这一个事件），而排序要的是「这条会话到目前最晚的一次活动」—— 那是累计量，
   * 只能沿着会话的生命周期累积。读 DSH 侧的服务也拿不到它：那些服务只回答「有哪些会话」，
   * 不回答「这一条现在该排第几」。
   */
  updatedAt: number | undefined
  origin: 'subagent' | undefined
  turnReasoning?: string[] | undefined
  turnTexts?: string[] | undefined
  shown?: number | undefined
}

/** Services the announcer needs, injected so this module owns no lifecycle. */
/**
 * One workspace as the DSH host itself knows it (ctx.workspaceRegistry).
 *
 * 为什么不让插件自己从 cwd 推：DSH 有**权威台账**（~/.dsh/storages/workspace.json 的
 * tables.workspaces），里面是用户真正用过的工作区全集，且每个都带 title 与 sessionIds。
 * 插件自己维护的那份只记「会话正跑在哪」，于是用户的 15 个工作区在手机上看得到 1 个
 * （原话：「真实的 dsh 现在的 workspace 有很多」）。
 */
export interface KnownDshWorkspace {
  readonly path: string
  readonly title: string
  readonly sessionCount: number
  /**
   * DSH 注册表里的**持久顺序**：`workspaceRegistry.list()` 的下标。
   *
   * 为什么要有它（2026-10-15，用户「工作区的排序跟 dsh 不一样」）：DSH 的分组顺序是
   * 一份**用户可手工拖动的**持久顺序（packages/api/workspace-controller 的 insertBefore），
   * 而 `list()` 就是按它返回的。这份顺序在手机上没有任何出路：手机把工作区落库后那条
   * `ORDER BY updated_at DESC` 会把它打乱。所以顺序必须成为一个显式字段送出去 —— 与
   * `at` 同一条纪律：**只用于排序，不用于显示时间**。
   */
  readonly order: number
  /**
   * 这个工作区的**成员会话 id**（`Workspace.sessionIds`，DSH 注册表台账）。
   *
   * 为什么成员身份也要送进来（2026-10-15，用户「工作区显示的会话比 dsh 真实显示的要多」）：
   * DSH 的工作区成员是**用户/宿主显式记的账**（packages/workspace/workspace 的 entity.ts：
   * `record.sessionIds.filter(id => host.sessionPath(id) === record.path)`），不是「cwd 等于
   * 这个目录的全部会话」。真机上 teahouse-mobile 台账 39 条、按 cwd 匹配却是 408 条 ——
   * 那 369 条是跑在同一个目录、但归属别处（或从未 attach）的会话，DSH 不把它们算进这个
   * 工作区。按 cwd 全量匹配就会让手机多出一大截。
   *
   * undefined = 这个宿主没有 workspace 服务，调用方**不许猜**（退回 cwd 匹配，见 provider）。
   */
  readonly sessionIds: readonly string[]
}

export interface AnnounceDeps {
  readonly ctx: Context
  readonly client: () => TidingsClient
  readonly registry: TidingsWorkspaceRegistry
  /**
   * DSH 的权威工作区清单；返回 undefined = 这个宿主没有 workspace 服务。
   *
   * 可选是刻意的：插件要能在没有该服务的宿主里照常工作（退回 registry.known()）。
   */
  readonly dshWorkspaces?: () => readonly KnownDshWorkspace[] | undefined
  readonly config: () => ResolvedConfig & { readonly announceTargets?: readonly string[] | undefined }
}

/**
 * One running announcer.
 *
 * Recipient resolution (`to`): an explicit `announceTargets` list wins;
 * otherwise the control plane's **online** peers are the audience. The cap gate
 * (`agn1` for session/event frames, `aws1` for workspace frames) lives in the
 * node's delivery layer, so announcing at a peer that does not speak agent is
 * answered with a 409 that is swallowed — which is why peer discovery is cached
 * rather than probed per frame. There is no way to read a peer's caps through
 * the control plane today (`GET /v1/peers` does not carry them), so "try it and
 * drop the failure" is the only honest filter available from this side.
 */
export class SessionAnnouncer {
  private readonly tracks = new Map<string, SessionTrack>()

  private peers: readonly TidingsPeerView[] = []

  private peersFetchedAt = 0

  private peersFetching = false

  /**
   * 已宣告过的 (对端 × 工作区) 对。
   *
   * ## 为什么键要带**对端**，而不是只记工作区（2026-10-14 真机抓到）
   *
   * 第一版只记 wsId。可一条 `agent-workspace` 帧声明的其实是「**你**应该知道这个工作区」——
   * 它是否已经送到，取决于**那个对端**的状态，而不是本进程。后果：对端的台账是内存态、
   * 重启就清空，而这里仍记着「已宣告」⇒ 重启后的机器**永远收不到**这份清单
   * （真机症状：桌面端重启后台账回 0，而 `announced` 仍是 15；手机端只有手工推的几条）。
   *
   * 判据：**记账的键必须与「这次宣告什么时候算送达」的那件事对齐。** 送达是相对某个对端的，
   * 键里就必须有那个对端。
   */
  private readonly announcedWorkspaces = new Map<string, number>()

  /** 上一次做宣告时的受众快照；用于识别「有新对端上线」与「某对端换了身份」。 */
  private lastAudience: readonly string[] = []

  /** 最近一次发包失败的原因；undefined = 上一发成功。见 send 的 KDoc。 */
  private lastSendError: string | undefined = undefined

  /** Sessions whose queue already drained, so a late event cannot resurrect them. */
  private readonly closed = new Set<string>()

  constructor(private readonly deps: AnnounceDeps) {}

  /**
   * 记下一个新会话，并把它的工作区宣告出去（首次见到时）。
   *
   * ## 这里**不发会话帧**，会话帧推迟到第一个映射事件（2026-10-14 真机抓到）
   *
   * DSH 判定「空壳会话」（blank）的口径（packages/api/session-controller/src/list.ts 的
   * `applySessionListMetadata`）是：投影初值 `blank: true`，只有收到 `turn/start` 才变 false。
   * 也就是说**在 session/created 那一刻，任何会话按 DSH 自己的定义都还是 blank**——
   * 在这里判 blank 等价于「永远不宣告」。
   *
   * 所以推迟：创建时只记账（含创建时刻与活动时刻），等第一个映射事件到了再发第一帧。
   * 后果正是想要的 —— 一个建出来从没被用过、也从没说过话的会话永远不上手机（DSH 的
   * 工作区浏览器同样不显示它，见 tree.ts 的 `sessionVisible()`）。
   *
   * 顺带的收益：`startedAt` 可以如实说**创建**时刻，而不是「我们决定宣告它的那一刻」。
   * 推迟把这两者分开了，`startedAt` 才第一次真的等于会话开始时间。
   *
   * 子代理会话（`origin === 'subagent'`）在这里就被挡掉：连 track 都不建，后续
   * `onEvent` / `onDisposed` 会因为查不到 track 而自然跳过（见 onDisposed 的那句
   * `tracks.get` —— 但 onEvent 会 trackFor 建新 track，所以它也要判）。
   */
  onCreated(session: AnnounceSession): void {
    this.runCatching('会话宣告', () => {
      if (session.origin === 'subagent') return
      const track = this.trackFor(session.id, session.cwd, session.origin)
      track.createdAt = session.createdAt ?? Date.now()
      track.updatedAt = track.createdAt
      if (session.cwd !== undefined) this.announceWorkspace(session.cwd)
    })
  }

  /**
   * 发某个会话的第一帧（幂等）。`onEvent` 每个映射事件都会调它。
   *
   * 为什么单独一个方法：第一帧的判据（`announced`）要在**两条**路上成立 ——
   * `onCreated` 之后的第一个事件、以及（理论上）没收到 created 的情况下收到的第一个事件。
   * 写两个地方迟早会漏一个。
   */
  private announceSession(sessionId: string, track: SessionTrack): void {
    if (track.announced) return
    track.announced = true
    track.state = 'busy'
    this.sessionFrame(sessionId, track, {
      state: 'busy',
      ...track.createdAt === undefined ? {} : { createdAt: track.createdAt },
    })
  }

  /**
   * Map one session event onto the announcement stream.
   *
   * Never throws and never awaits: `session/event` listeners run inside the
   * append notification, so a rejection here would be logged for every event of
   * the turn.
   */
  onEvent(session: AnnounceSession, event: { readonly type: string; readonly data?: unknown }): void {
    this.runCatching('事件宣告', () => {
      const mapped = EVENT_TYPE_BY_SESSION_EVENT[event.type]
      if (mapped === undefined) return
      // 子代理会话不上手机（判据与 DSH 的 tree.ts 一致，也与 `onCreated` 同一处口径）。
      // 这里必须再判一次而不是只靠 `onCreated`：`onEvent` 里的 `trackFor` 是**建** track
      // 的那个调用，订阅是全局的，谁先到都不一定。
      if (session.origin === 'subagent') return
      const track = this.trackFor(session.id, session.cwd, session.origin)
      // 活动时刻只认**用户自己发的话**，与 DSH 的 `lastPromptAt` 判据逐字一致：
      // `event.type === 'user/message' && event.data.source.kind === 'user'`。
      //
      // `source.kind` 这一半是必须的，不是保险：`user/message` 这条事件同时承载
      // `agent.inject()` 的合成内容（文件变更提示、子目录 AGENTS.md、skill 正文、
      // cron 通知、goal 续跑轮次 —— 见 dsh-llm 的 MessageSourceMap KDoc）。那些是
      // **机器自己塞进去的**，把它们算成活动会让一个没人碰过的会话一直往上浮。
      // 工具调用、turn 边界也都不改它：报告里的「最近活动」问的是「这个人什么时候
      // 还在这里用」，不是「这个 agent 自己还在忙」。
      //
      // 时钟取自本端（`Date.now()`）而不是事件：订阅回调拿到的是 `(session, event)`，
      // 而 `event` 是 **SessionEventMap 的 data 载荷**（`UserMessage`）—— 这一层没有
      // `SessionEvent.time`（那个字段在事件的兄弟层，回调不传）。本端收帧时刻与 DSH
      // 写日志时刻的差就是这一跳的延迟（毫秒级），而排序只比较同一工作区里的会话，
      // 这个偏差对所有条目是同一符号的偏移 —— 不改变次序。
      // 用 `>=` 覆盖而不是「有则不动」：会话 id 可复用，时钟也可能回拨。
      if (event.type === 'user/message') {
        if (!isUserAuthored(event.data)) {
          // 合成上下文/提示词注入（time-context, model-selection, agent-instructions, dsh-mnemon）
          // 绝不是用户提问，坚决不能作为 user.message 转发给聊天通道
          return
        }
        if (track.title === undefined) track.title = titleFrom(event.data)
        const at = Date.now()
        if (track.updatedAt === undefined || at >= track.updatedAt) track.updatedAt = at
      }
      // 第一帧（state: busy + 创建时刻）在这里补发：onCreated 只记账不发帧，理由见那段 KDoc。
      this.announceSession(session.id, track)
      if (event.type === 'turn/start') {
        this.setState(session.id, track, 'busy')
        track.turnReasoning = []
        track.turnTexts = []
        track.shown = 0
      }

      if (event.type === 'assistant/message') {
        const data = isRecord(event.data) ? event.data : undefined
        const msg = isRecord(data?.['message']) ? data['message'] : data
        const content = Array.isArray(msg?.['content']) ? msg['content'] : []
        const called = content.some(block => isRecord(block) && (block['type'] === 'tool-call' || block['type'] === 'tool_call'))

        let stepText = ''
        for (const block of content) {
          if (isRecord(block)) {
            if (block['type'] === 'text' && typeof block['text'] === 'string') {
              stepText += (stepText.length > 0 ? '\n' : '') + block['text']
            } else if (block['type'] === 'reasoning' && typeof block['text'] === 'string' && block['text'].trim().length > 0) {
              if (!track.turnReasoning) track.turnReasoning = []
              const r = block['text'].trim()
              if (!track.turnReasoning.includes(r)) {
                track.turnReasoning.push(r)
              }
            }
          }
        }
        const cleaned = stripWrittenCalls(stepText.trim())
        if (cleaned.length > 0) {
          if (!track.turnTexts) track.turnTexts = []
          track.turnTexts.push(cleaned)
        }

        // DeepSeek-Bot showSteps: what a turn says while it works goes to the group at once.
        // A step with a tool call goes on at once; one without may be the turn's last,
        // so it waits for the next text or the turn's end, which shows the rest as the turn's reply.
        const texts = track.turnTexts ?? []
        const shown = track.shown ?? 0
        const upTo = called ? texts.length : texts.length - 1
        for (let i = shown; i < upTo; i++) {
          const stepText = texts[i]
          if (stepText !== undefined && stepText.length > 0) {
            const stepChunks = chunkUtf8(stepText, 24000)
            for (const chunk of stepChunks) {
              track.pending.push({
                eventType: 'assistant.text',
                summary: chunk.length <= 100 ? chunk.replace(/\n/g, ' ') : `${chunk.slice(0, 99).replace(/\n/g, ' ')}…`,
                body: chunk,
              })
            }
          }
        }
        track.shown = Math.max(shown, upTo)
      } else if (event.type === 'turn/end') {
        // DeepSeek-Bot turn/end: What the group already saw of the turn is not posted again.
        const texts = track.turnTexts ?? []
        const shown = track.shown ?? 0
        const remaining = texts.slice(shown).join('\n\n').trim()
        track.shown = texts.length

        const fullReasoning = (track.turnReasoning ?? []).join('\n\n').trim()
        // Cap reasoning safely so wire frame never exceeds safe limits
        const safeReasoning = fullReasoning.length <= 2000
          ? fullReasoning
          : `${fullReasoning.slice(0, 2000)}\n\n[...思考过程过长，已截断...]`

        if (remaining.length > 0) {
          const prefix = safeReasoning.length > 0 ? `<think>${safeReasoning}</think>\n` : ''
          const remainingChunks = chunkUtf8(remaining, 24000)
          for (let i = 0; i < remainingChunks.length; i++) {
            const chunk = remainingChunks[i]
            const chunkBody = i === 0 ? `${prefix}${chunk}` : chunk
            track.pending.push({
              eventType: 'assistant.text',
              summary: chunk.length <= 100 ? chunk.replace(/\n/g, ' ') : `${chunk.slice(0, 99).replace(/\n/g, ' ')}…`,
              body: chunkBody,
            })
          }
        } else if (fullReasoning.length > 0 && texts.length === 0) {
          track.pending.push({
            eventType: 'assistant.text',
            summary: '思考完成',
            body: `<think>${safeReasoning}</think>`,
          })
        }

        this.flush(session.id, track)
        track.turnReasoning = []
        track.turnTexts = []
        track.shown = 0
        this.setState(session.id, track, 'idle')
        if (track.title !== undefined) {
          this.sessionFrame(session.id, track, track.state === undefined ? {} : { state: track.state })
        }
        return
      } else {
        const pending = this.pendingFor(track, event, mapped)
        if (pending !== undefined) {
          const last = track.pending[track.pending.length - 1]
          if (last !== undefined && last.eventType === pending.eventType) {
            track.pending[track.pending.length - 1] = pending
          } else {
            track.pending.push(pending)
          }
          if (track.pending.length > MAX_PENDING_EVENTS) track.pending.splice(0, track.pending.length - MAX_PENDING_EVENTS)
        }
      }
      this.schedule(session.id, track)
    })
  }

  /** Drain one session's queue and mark it `done`. */
  onDisposed(session: AnnounceSession): void {
    this.runCatching('会话关闭宣告', () => {
      const track = this.tracks.get(session.id)
      if (track === undefined) return
      this.flush(session.id, track)
      this.closed.add(session.id)
      // 从没宣告过的会话（建出来就没人用过，或子代理）关掉时**不发 done** —— 手机上
      // 从来没出现过它，补一句「结束了」只会凭空多出一条空壳记录。
      if (!track.announced) return
      track.state = 'done'
      this.sessionFrame(session.id, track, { state: 'done' })
    })
  }

  /**
   * Drop every timer and queued event. Called when the plugin fiber disposes: a
   * timer that outlives its plugin fires into a dead context.
   */
  stop(): void {
    for (const [id, track] of [...this.tracks]) {
      if (track.timer !== undefined) clearTimeout(track.timer)
      track.timer = undefined
      track.pending = []
      this.tracks.delete(id)
    }
    this.closed.clear()
  }

  /**
   * Announce one workspace of this host (增补 D3), at most once per process.
   *
   * This is the frame that covers "the project exists but no session has run in
   * it yet", so it is sent for the workspace itself, not as a side effect of a
   * session frame.
   */
  announceWorkspace(cwd: string): void {
    const workspace = this.deps.registry.workspaceOf(cwd)
    if (workspace === undefined) return
    // 会话触发的这一路**也必须带 agentId**（缺陷：不带时节点台账按 `agentId ?? agentKind`
    // 归行，这一路落到 `agentKey="DSH"`、周期路落到 `agentKey="dsh-029bbbf3"` ⇒ 同一个
    // 工作区在台账里是**两行**，其中一行永远是陈旧快照：周期路每 10 秒刷新共用记账位，
    // 这一路就被永久饿死（2026-10-15 在 `GET /v1/agent/workspaces` 上实测到 16 行）。
    const dsh = this.deps.dshWorkspaces?.()?.find(entry => entry.path === cwd)
    // 与周期宣告共用一套「刷新窗口」记账（见 announceKnownWorkspaces 里的说明）：
    // 会话触发是**更及时**的那条路，但它不该让周期宣告以为「这个工作区已办」。
    const audience = this.targets()
    if (audience.length === 0) return
    const now = Date.now()
    const pending = audience.filter(to => {
      const last = this.announcedWorkspaces.get(`${to}\u0000${workspace.wsId}`)
      return last === undefined || now - last >= ANNOUNCE_REFRESH_MS
    })
    if (pending.length === 0) return
    for (const to of pending) this.announcedWorkspaces.set(`${to}\u0000${workspace.wsId}`, now)
    const args: Omit<TidingsAgentWorkspaceArgs, 'to'> = {
      wsId: workspace.wsId,
      wsTitle: workspace.wsTitle,
      wsPath: workspace.wsPath,
      agentId: this.deps.registry.hostAgentId(),
      agentKind: 'DSH',
      online: true,
      // DSH 那边的真数（拿不到就**不带这个键**而不是报 0 —— 0 是一句我们并不知道的话，
      // 而且 0 < 手机本地已知条数时「加载更多」会直接不画）。
      ...dsh === undefined ? {} : { sessionCount: dsh.sessionCount },
      ...dsh === undefined ? {} : { order: dsh.order },
      at: Date.now(),
    }
    for (const to of pending) {
      void this.send(() => this.deps.client().agentWorkspace({ ...args, to }), `工作区 ${workspace.wsId}`)
    }
  }

  /**
   * Announce **every** workspace this host already knows, once (2026-10-14 新增).
   *
   * `announceWorkspace` only fires for a workspace a session is currently running in,
   * so a host that has run sessions in N directories still shows nothing until each of
   * those directories is visited again. This is the frame that turns the ledger into
   * a list the phone can cache — the user's "real DSH has many workspaces, but the
   * page only shows a couple" is exactly this gap.
   *
   * Idempotent by design: workspaces already announced are skipped, so calling it on
   * startup (and after a reconnect) never spams the peer.
   */
  announceKnownWorkspaces(): void {
    this.runCatching('工作区清单宣告', () => {
      // 优先用 DSH 的权威台账（一个用户真正用过的工作区全集，带 title 与会话数），
      // 拿不到才退回插件自己那份「会话跑过的目录」（见 KnownDshWorkspace 的 KDoc）。
      //
      // `sessionCount` 用 DSH 的 `sessionIds.length`：手机上「N 个会话」这一格在
      // 宣告行上也得是真的 —— 会话帧到齐之前，它是那行唯一的计数来源。
      const fromDsh = this.deps.dshWorkspaces?.()
      const list = fromDsh === undefined
        ? this.deps.registry.known().map((workspace, index) => ({
            wsId: workspace.wsId,
            wsTitle: workspace.wsTitle,
            wsPath: workspace.wsPath,
            sessionCount: 0,
            // 退回自带台账时没有 DSH 的持久序；用本地台账的稳定序（`known()` 是
            // Map 插入序，进程内稳定）当顺序信号，总比让手机按 updated_at 乱排好。
            order: index,
          }))
        : fromDsh.map(workspace => {
            const record = this.deps.registry.workspaceOf(workspace.path)
            return {
              wsId: record?.wsId ?? '',
              wsTitle: workspace.title.length > 0 ? workspace.title : (record?.wsTitle ?? ''),
              wsPath: workspace.path,
              sessionCount: workspace.sessionCount,
              order: workspace.order,
            }
          }).filter(entry => entry.wsId.length > 0)

      // 受众先算一次，**整个批次共用**：`targets()` 内部有邻居缓存，一次调用比每帧一次便宜；
      // 更要紧的是它让下面那条记账规则变得可能。
      const audience = this.targets()
      for (const workspace of list) {
        // 受众里**每个对端各判各的**：换了设备、或这台设备从没收到过这一条，都要发。
        // （见 announcedWorkspaces 的 KDoc —— 只记 wsId 是对端重启后永久失联的根因。）
        // 过刷新窗口就重发（`ANNOUNCE_REFRESH_MS`）。
        //
        // ## 为什么不是「发过一次就永远跳过」（2026-10-14 真机抓到）
        //
        // `agent-workspace` 是**状态快照**，而快照按设计**不入队**（节点侧的回执只有
        // sent / not-acked，没有 queued —— 见 ControlPlane 的说明）。于是「发过一次」
        // 不等于「对端现在有」：手机被停掉、锁屏、换网的那些时刻，帧直接丢了，而这里若记成
        // 已办，那台设备就**永远**看不到这份清单（真机症状：桌面端台账 14 条、手机 0 条，
        // 因为宣告恰好在手机被 force-stop 时发出）。
        //
        // 判据与本次其它修复同源：**不该把「试过」记成「成了」，也不该把一次成功当成永久的。**
        // 状态快照的正确语义是「定期重申」，代价是每窗口一次幂等重发。
        const now = Date.now()
        const pending = audience.filter(to => {
          const last = this.announcedWorkspaces.get(`${to}\u0000${workspace.wsId}`)
          return last === undefined || now - last >= ANNOUNCE_REFRESH_MS
        })
        if (pending.length === 0) continue
        // ## 为什么记账要等确认有受众（2026-10-14 真机抓到的 bug）
        //
        // 第一版在这里无条件 `add(wsId)`，然后才遍历 `targets()`。后果：捎话桌面端还没
        // 启动时（DSH 常开、人要用时才开桌面端，这是最常见的顺序）第一次周期宣告把 15 个
        // wsId 全部标成「已宣告」，而 `targets()` 返回空 ⇒ 一个都没发，之后每个周期都跳过
        // ⇒ **工作区永远推不过去**，而日志与状态都显示「已宣告 15 个」。
        //
        // 判据：**「已宣告」必须意味着「至少发出过一次」，不能把「试过但没人可发」记成已办。**
        // 这与本仓反复抓到的「用了某产物」的计数器同源 —— 记账问的必须是结果，不是意图。
        if (audience.length === 0) break
        for (const to of pending) this.announcedWorkspaces.set(`${to}\u0000${workspace.wsId}`, now)
        const args: Omit<TidingsAgentWorkspaceArgs, 'to'> = {
          wsId: workspace.wsId,
          wsTitle: workspace.wsTitle,
          wsPath: workspace.wsPath,
          agentId: this.deps.registry.hostAgentId(),
          agentKind: 'DSH',
          online: true,
          sessionCount: workspace.sessionCount,
          order: workspace.order,
          at: Date.now(),
        }
        for (const to of pending) {
          void this.send(() => this.deps.client().agentWorkspace({ ...args, to }), `工作区 ${workspace.wsId}`)
        }
      }
    })
  }

  /** Workspace ids this process already announced (exposed for the panel/diagnostics). */
  announcedWorkspaceIds(): readonly string[] {
    // 键是 `peer\u0000wsId`；诊断要的是**多少个工作区被宣告过**，取右侧并按 wsId 去重
    // （同一个工作区发给两个对端只算一个）。
    return [...new Set([...this.announcedWorkspaces.keys()].map(key => {
      const at = key.indexOf('\u0000')
      return at < 0 ? key : key.slice(at + 1)
    }))]
  }

  /** Every workspace this host knows about, announced or not. */
  knownWorkspaces(): ReturnType<TidingsWorkspaceRegistry['known']> {
    return this.deps.registry.known()
  }

  private trackFor(sessionId: string, cwd: string | undefined, origin?: 'subagent'): SessionTrack {
    const existing = this.tracks.get(sessionId)
    if (existing !== undefined) {
      if (origin !== undefined) existing.origin = origin
      if (cwd !== undefined && existing.cwd === undefined) existing.cwd = cwd
      return existing
    }
    const created: SessionTrack = {
      state: undefined,
      cursor: Date.now(),
      pending: [],
      timer: undefined,
      announced: false,
      title: undefined,
      cwd,
      createdAt: undefined,
      updatedAt: undefined,
      origin,
      turnReasoning: [],
      turnTexts: [],
      shown: 0,
    }
    this.tracks.set(sessionId, created)
    return created
  }

  /** Build the queued frame. */
  private pendingFor(track: SessionTrack, event: { readonly type: string; readonly data?: unknown }, eventType: string): PendingEvent | undefined {
    const data = isRecord(event.data) ? event.data : undefined
    const summary = summarize(event.type, data)
    let body: string | undefined = undefined
    let attachment: TidingsAgentAttachment | undefined = undefined
    if (event.type === 'user/message') {
      body = extractUserPrompt(data)
      if (body === undefined) return undefined
      // 结构化附件（task-45，cap att1）：**同时**保留 body 里的占位文本。
      // 占位是回退：对端没声明 att1（或宿主还没把 attachment 接上线上）时，
      // 手机看到的就是那句 图片: name (920x412, 30 KB)，而不是一条消失的消息。
      attachment = extractAttachment(data)
    }
    const ref = event.type === 'tool/call'
      ? asString(data?.callId)
      : event.type === 'tool/result'
        ? asString(data?.callId) ?? asString(isRecord(data?.message) ? data.message['id'] : undefined)
        : undefined
    return {
      eventType,
      ...summary === undefined ? {} : { summary },
      ...body === undefined ? {} : { body },
      ...ref === undefined ? {} : { ref },
      ...attachment === undefined ? {} : { attachment },
    }
  }

  /** Arm the trailing window; an armed window is not re-armed. */
  private schedule(sessionId: string, track: SessionTrack): void {
    if (track.timer !== undefined) return
    if (track.pending.length === 0) return
    track.timer = setTimeout(() => {
      track.timer = undefined
      this.runCatching('事件冲刷', () => { this.flush(sessionId, track) })
    }, EVENT_THROTTLE_MS)
    // A timer whose only job is to keep the loop busy must not hold the process open.
    track.timer.unref?.()
  }

  /** Send every queued event of one session, in cursor order. */
  private flush(sessionId: string, track: SessionTrack): void {
    if (track.timer !== undefined) {
      clearTimeout(track.timer)
      track.timer = undefined
    }
    if (track.pending.length === 0) return
    const batch = track.pending
    track.pending = []
    const targets = this.targets()
    for (const event of batch) {
      track.cursor += 1
      const cursor = track.cursor
      for (const to of targets) {
        const args: TidingsAgentEventArgs = {
          to,
          sessionId,
          cursor,
          eventType: event.eventType,
          ...event.summary === undefined ? {} : { summary: event.summary },
          ...event.body === undefined ? {} : { body: event.body },
          ...event.ref === undefined ? {} : { ref: event.ref },
          ...event.attachment === undefined ? {} : { attachment: event.attachment },
        }
        void this.send(() => this.deps.client().agentEvent(args), `事件 ${event.eventType}`)
      }
    }
  }

  private setState(sessionId: string, track: SessionTrack, state: string): void {
    if (track.state === state) return
    track.state = state
    this.sessionFrame(sessionId, track, { state })
  }

  /**
   * 发一帧会话。
   *
   * 活动时刻（`updatedAt`）**不从这里传**：它必须与手机真正收到的那一帧一致，而
   * `this.targets()` 在配置了 `announceTargets` 时是**写死的对端清单**（其背后是
   * `agents.list` 的 agent 身份解析）—— 在循环外取一次时钟，就是那一批收件人共享的
   * 同一个时刻；放进循环里逐对端取，会把「同一批宣告」拆成互不可比的几个时间戳。
   */
  private sessionFrame(
    sessionId: string,
    track: SessionTrack,
    extra: { readonly state?: string; readonly startedAt?: number; readonly createdAt?: number },
  ): void {
    if (this.closed.has(sessionId) && extra.state !== 'done') return
    if (track.cwd === undefined) {
      const found = this.deps.dshWorkspaces?.()?.find(w => w.sessionIds.includes(sessionId))
      if (found !== undefined) track.cwd = found.path
    }
    const dshWs = this.deps.dshWorkspaces?.()?.find(w => w.path === track.cwd)
    // 成员账核验：非 subagent 且符合会话规范才可归入工作区
    const isMember = track.origin !== 'subagent' &&
      sessionId.startsWith('session-') &&
      (dshWs === undefined || dshWs.sessionIds.includes(sessionId) || track.cwd !== undefined)
    const workspace = isMember && track.cwd !== undefined ? this.deps.registry.workspaceOf(track.cwd) : undefined
    const updatedAt = track.updatedAt ?? Date.now()
    // 「开始于 …」= 会话创建时刻。只有推迟宣告时由调用方从 track 里递进来（那时现在
    // 已经不是创建那一刻了）；其余路径（状态变化、关闭）没有可说的创建时刻，就不带。
    const startedAt = extra.startedAt ?? extra.createdAt
    const base = {
      agentKind: 'DSH',
      agentId: this.deps.registry.hostAgentId(),
      ...track.title === undefined ? {} : { title: track.title },
      ...extra.state === undefined ? {} : { state: extra.state },
      ...startedAt === undefined ? {} : { startedAt },
      updatedAt,
      ...track.origin === undefined ? {} : { origin: track.origin },
      blank: false,
    }
    for (const to of this.targets()) {
      const args: TidingsAgentSessionArgs = {
        to,
        sessionId,
        ...base,
        ...workspace === undefined ? {} : { wsId: workspace.wsId, wsTitle: workspace.wsTitle, wsPath: workspace.wsPath },
      }
      void this.send(() => this.deps.client().agentSession(args), `会话 ${sessionId}`)
    }
  }

  /**
   * Recipients: `announceTargets` when configured, otherwise the online peers
   * the control plane last reported. An empty list is a legitimate answer (no
   * peers) and costs one cached `GET /v1/peers`.
   */
  private targets(): readonly string[] {
    const configured = this.deps.config().announceTargets
    if (configured !== undefined && configured.length > 0) {
      return Array.from(new Set(['self', ...configured.map(target => target.trim()).filter(target => target.length > 0)]))
    }
    this.refreshPeers()
    const onlinePeers = this.peers.filter(peer => peer.online).map(peer => peer.nodeId)
    return Array.from(new Set(['self', ...onlinePeers]))
  }

  /** Refresh the peer list at most once per window; never blocks a listener. */
  private refreshPeers(): void {
    if (this.peersFetching) return
    if (Date.now() - this.peersFetchedAt < PEER_CACHE_MS) return
    this.peersFetching = true
    void this.deps.client().peers().then(
      peers => {
        this.peersFetchedAt = Date.now()
        this.peers = peers
      },
      () => {
        // Control plane down: keep the stale list. Announcements then fail soft
        // on their own request, which is the same outcome as having no peers.
        this.peersFetchedAt = Date.now()
      },
    ).finally(() => { this.peersFetching = false })
  }

  private async send(action: () => Promise<unknown>, what: string): Promise<void> {
    try {
      await action()
      this.lastSendError = undefined
    } catch (error) {
      // Every failure here is expected some of the time (node down, peer not
      // agent-capable, 409 without agn1). One warn line per frame, never a throw:
      // this promise is not awaited by anything in the session lifecycle.
      //
      // ## 为什么除了 warn 还要记一笔（2026-10-14）
      //
      // 我在排查「宣告了 15 个、台账却是 0」时被这条 warn 卡住：宿主**不落盘** logger.warn,
      // 于是这条链路唯一能说话的出口是看不见的。现在把最近一次失败留在这里，
      // `tidings_announce_status` 会报出来 —— 一个对外发包的自动链路必须能被问到「为什么没发成」。
      this.lastSendError = `${what}：${describeError(error)}`
      this.deps.ctx.logger.warn(`tidings-pantry: 自动宣告${what}失败：${describeError(error)}`)
    }
  }

  /** Last send failure, for `tidings_announce_status`（见 send 的说明）。 */
  lastSendFailure(): string | undefined {
    return this.lastSendError
  }

  /**
   * Run one listener body without letting anything escape.
   *
   * A `session/created` throw **vetoes and rolls back the session**, and a
   * `session/event` throw is logged as a broken observer on every append. Both
   * are worse than silence: a defect here must cost a frame, never a session.
   */
  private runCatching(where: string, body: () => void): void {
    try {
      body()
    } catch (error) {
      this.deps.ctx.logger.warn(`tidings-pantry: 自动宣告${where}失败：${describeError(error)}`)
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof TidingsRequestError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * One short line describing a mapped event.
 *
 * Deliberately thin: the frame budget is a wire concern upstream (PPE-1 增补
 * §2.2), and a summary is a label. A tool result never carries its body here.
 */
function summarize(type: string, data: Record<string, unknown> | undefined): string | undefined {
  if (data === undefined) return undefined
  switch (type) {
    case 'turn/start': {
      const turn = typeof data['turn'] === 'number' ? data['turn'] : undefined
      return turn === undefined ? undefined : `turn ${String(turn)}`
    }
    case 'turn/end': {
      const reason = isRecord(data['reason']) ? asString(data['reason']['kind']) : undefined
      const turn = typeof data['turn'] === 'number' ? data['turn'] : undefined
      const turnText = turn === undefined ? undefined : `turn ${String(turn)}`
      if (turnText === undefined) return reason === undefined ? undefined : `ended (${reason})`
      return reason === undefined ? turnText : `${turnText} · ${reason}`
    }
    case 'tool/call':
      return asString(data['name'])
    case 'tool/result': {
      const message = isRecord(data['message']) ? data['message'] : undefined
      const failed = message?.['isError'] === true || data['error'] !== undefined
      const name = asString(data['name']) ?? asString(message?.['name'])
      return failed ? `${name ?? 'tool'} 失败` : name
    }
    case 'assistant/message': {
      const msg = isRecord(data['message']) ? data['message'] : data
      const content = Array.isArray(msg['content']) ? msg['content'] : []
      for (const block of content) {
        if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
          const line = block['text'].replace(/\s+/gu, ' ').trim()
          if (line.length > 0) return line.length <= 100 ? line : `${line.slice(0, 99)}…`
        }
      }
      return undefined
    }
    case 'user/message':
      return titleFrom({ content: data['content'] })
    default:
      return undefined
  }
}

/**
 * Whether a `user/message` event is something the human actually sent.
 *
 * DSH 的判据（packages/api/session-controller/src/list.ts
 * `applySessionListMetadata`）：`event.type === 'user/message' && event.data.source.kind === 'user'`。
 * 另一支是 `agent.inject()` 的合成上下文，它在日志里长得和真实提问一模一样（同为
 * `user/message`、同样有 content 块），只有 `source.kind` 能分开。
 *
 * 形状不确定时返回 false（宁可不更新活动时刻，也不要把合成内容当成人的活动）。
 */
function isUserAuthored(data: unknown): boolean {
  if (!isRecord(data)) return false
  const source = data['source']
  return isRecord(source) && source['kind'] === 'user'
}

/**
 * Derive a display title from the first user message: its first text block,
 * collapsed to one line and cut at {@link MAX_TITLE_LENGTH}.
 *
 * `SessionHeader` carries **no** title field (checked against
 * core/session `SessionHeader`: version / id / createdAt / cwd / lineage /
 * origin / agentPreset only). Host titles live in a `session/title` event that
 * this plugin does not subscribe to, so the prompt itself is the honest source.
 */
function titleFrom(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined
  const content = data['content']
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'text') continue
    const text = asString(block['text'])
    if (text === undefined) continue
    const line = text.replace(/\s+/gu, ' ').trim()
    if (line.length === 0) continue
    return line.length <= MAX_TITLE_LENGTH ? line : `${line.slice(0, MAX_TITLE_LENGTH - 1)}…`
  }
  // 只有图片的用户消息（真机实测：DSH 里直接贴一张图）：没有文本块时标题会是空的，
  // 会话在手机上就退回 session-…。用附件占位当标题。
  for (const block of content) {
    if (!isRecord(block)) continue
    const placeholder = attachmentPlaceholder(block)
    if (placeholder !== undefined) return placeholder
  }
  return undefined
}

/**
 * Extract full user prompt text from user/message content blocks.
 */
/**
 * 协议对 attachment 的硬上限（core/protocol 的 Limits.AGENT_ATTACHMENT_*）。
 *
 * 越界是**整帧拒**（不是丢附件）：所以这里先自检，越界就把 attachment 丢掉、只发
 * 文本占位 —— 少一张卡片，好过整条事件消失（半张卡片比占位更糟）。
 */
const ATTACHMENT_LIMITS = {
  id: 128,
  mediaType: 64,
  name: 128,
  dimension: 32768,
  bytes: 512 * 1024 * 1024,
} as const

/**
 * user/message 的 content 块 → 结构化附件元数据（取第一个带 attachment 的块）。
 *
 * 字段口径与 DSH 的 content 块逐字一致（真机 log 实测）：
 *   { type: 'image', attachment: { attachmentId, mediaType, width, height, bytes, name } }
 *
 * 任一字段越界 ⇒ 返回 undefined：宁可只发占位，也不发一帧会被整帧拒的载荷。
 */
function extractAttachment(data: unknown): TidingsAgentAttachment | undefined {
  if (!isRecord(data)) return undefined
  const content = data['content']
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (!isRecord(block)) continue
    const raw = isRecord(block['attachment']) ? block['attachment'] : undefined
    if (raw === undefined) continue
    const attachmentId = asString(raw['attachmentId'])
    const mediaType = asString(raw['mediaType'])
    if (attachmentId === undefined || mediaType === undefined) continue
    if (attachmentId.length > ATTACHMENT_LIMITS.id) return undefined
    if (mediaType.length > ATTACHMENT_LIMITS.mediaType) return undefined
    const width = typeof raw['width'] === 'number' ? raw['width'] : undefined
    const height = typeof raw['height'] === 'number' ? raw['height'] : undefined
    const bytes = typeof raw['bytes'] === 'number' ? raw['bytes'] : undefined
    const name = asString(raw['name'])
    if (width !== undefined && (!Number.isInteger(width) || width < 0 || width > ATTACHMENT_LIMITS.dimension)) return undefined
    if (height !== undefined && (!Number.isInteger(height) || height < 0 || height > ATTACHMENT_LIMITS.dimension)) return undefined
    if (bytes !== undefined && (!Number.isInteger(bytes) || bytes < 0 || bytes > ATTACHMENT_LIMITS.bytes)) return undefined
    if (name !== undefined && name.length > ATTACHMENT_LIMITS.name) return undefined
    return {
      attachmentId,
      mediaType,
      ...width === undefined ? {} : { width },
      ...height === undefined ? {} : { height },
      ...bytes === undefined ? {} : { bytes },
      ...name === undefined ? {} : { name },
    }
  }
  return undefined
}

function extractUserPrompt(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined
  const content = data['content']
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      if (block['text'].length > 0) parts.push(block['text'])
      continue
    }
    // **真机缺陷（2026-10-18，用户反馈「DSH 发的图片消息 tidings 看不到」）**：
    // 这里原来只拼 text 块。于是一条**只有图片**的用户消息得到空串 ⇒
    // pendingFor 直接 return undefined ⇒ **整条事件根本不转发**，手机上连一个占位
    // 都没有（不是图没渲染，是这条消息不存在）。
    // 本仓协议帧（AGENT_EVENT）只有 summary/body/ref 三个文本字段、没有附件通道，
    // 所以图片/附件块必须转成一行**占位文本**，事件才发得出去。
    const placeholder = attachmentPlaceholder(block)
    if (placeholder !== undefined) parts.push(placeholder)
  }
  const prompt = parts.join('\n').trim()
  return prompt.length > 0 ? prompt : undefined
}

/**
 * 图片/附件内容块 → 一行占位文本。
 *
 * DSH 的 user/message content 里图片长这样（真机 session log 实测）：
 *
 *     { type: 'image',
 *       attachment: { attachmentId, mediaType: 'image/jpeg', width: 920, height: 412,
 *                     bytes: 31169, name: 'image.png' } }
 *
 * 协议没有附件通道 ⇒ 至少把「有一张图、叫什么、多大」如实报上去，手机端就能画出
 * 附件卡片/占位，而不是整条消息消失。
 */
function attachmentPlaceholder(block: Record<string, unknown>): string | undefined {
  const type = typeof block['type'] === 'string' ? block['type'] : ''
  const attachment = isRecord(block['attachment']) ? block['attachment'] : undefined
  if (attachment === undefined) return undefined
  if (type !== 'image' && type !== 'file' && type !== 'attachment') return undefined
  const name = asString(attachment['name']) ?? (type === 'image' ? 'image' : 'attachment')
  const width = typeof attachment['width'] === 'number' ? attachment['width'] : undefined
  const height = typeof attachment['height'] === 'number' ? attachment['height'] : undefined
  const bytes = typeof attachment['bytes'] === 'number' ? attachment['bytes'] : undefined
  const bits: string[] = []
  if (width !== undefined && height !== undefined) bits.push(width + '×' + height)
  if (bytes !== undefined) {
    bits.push(bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB')
  }
  const label = type === 'image' ? '🖼 图片' : '📎 附件'
  return bits.length > 0 ? label + ': ' + name + ' (' + bits.join(', ') + ')' : label + ': ' + name
}

/**
 * Clean written tool calls from model output (ported from DeepSeek-Bot).
 * Some models write <tool_call>... or <function=...> into text; these are pseudo-calls that never ran.
 */
function stripWrittenCalls(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gu, '')
    .replace(/<function=[\w.-]+>[\s\S]*?(?:<\/function>|$)/gu, '')
    .trim()
}

/**
 * Safely split text by UTF-8 byte length without breaking multi-byte sequences.
 */
function chunkUtf8(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text]
  const chunks: string[] = []
  let cur = ''
  let curBytes = 0
  for (const ch of text) {
    const b = Buffer.byteLength(ch, 'utf8')
    if (curBytes + b > maxBytes && cur.length > 0) {
      chunks.push(cur)
      cur = ''
      curBytes = 0
    }
    cur += ch
    curBytes += b
  }
  if (cur.length > 0) chunks.push(cur)
  return chunks
}

