import type { TidingsClient } from './tidings.ts'
import type { SessionPageEntry, SessionPageProvider, SessionPageResult } from './session-pages.ts'
import type { TidingsWorkspaceRegistry } from './workspace-registry.ts'

/**
 * Answer the phone's `agent-session-page` requests out of DSH's own session ledger.
 *
 * ## The loop
 *
 * The node cannot answer these itself (it only forwards); it queues them
 * (`GET /v1/agent/session-pages`). This responder polls that queue, reads the
 * page out of the host, sends one ordinary `agent-session` frame per entry, and
 * then marks the request resolved. No new reply frame exists — the phone's
 * existing ingest path does all the work.
 *
 * ## Why poll instead of an event
 *
 * The queue lives in a **separate process** (agentNode); there is no in-process
 * signal to subscribe to. Polling is the honest mechanism, and it is cheap: one
 * small GET per interval, and the interval only matters while the user is
 * actively opening a workspace.
 */
export interface SessionPageResponderDeps {
  readonly client: () => TidingsClient
  /** Page provider; `undefined` answer = host cannot read, so stay silent. */
  readonly provider: SessionPageProvider
  readonly registry: TidingsWorkspaceRegistry
}

/** Default poll interval: fast enough to feel immediate, slow enough to be free. */
const POLL_MS = 1_500

/**
 * One running responder.
 *
 * Never throws: `session/event` listeners and timers alike would surface an
 * exception as noise on every tick. Failures leave the request **unresolved**,
 * so the next tick simply retries — that is the intended recovery path.
 */
export class SessionPageResponder {
  private timer: ReturnType<typeof setTimeout> | undefined

  private running = false

  private stopped = false

  constructor(private readonly deps: SessionPageResponderDeps) {}

  start(): void {
    if (this.stopped) return
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule())
    }, POLL_MS)
  }

  /** One pass over the pending queue. Exposed for tests. */
  async tick(): Promise<void> {
    // Re-entrancy guard: a slow host read must not let a second pass start and
    // answer the same request twice (the frames would duplicate on the phone).
    if (this.running || this.stopped) return
    this.running = true
    try {
      const view = await this.deps.client().sessionPages()
      for (const request of view.requests) {
        const path = this.deps.registry.pathOf(request.wsId)
        if (path === undefined) {
          // Unknown workspace id: leave it pending. It may be a workspace this
          // host no longer has, and guessing a path would answer with another
          // project's sessions — worse than a request that times out.
          continue
        }
        const workspace = this.deps.registry.workspaceOf(path)
        const agentId = this.deps.registry.hostAgentId()
        const limit = request.limit === undefined ? DEFAULT_LIMIT : request.limit
        const page = await this.deps.provider(path, request.offset, limit)
        if (page === undefined) continue
        for (const entry of page.entries) {
          await this.deps.client().agentSession({
            to: request.nodeId,
            sessionId: entry.sessionId,
            ...(entry.title === undefined ? {} : { title: entry.title }),
            ...(entry.state === undefined ? {} : { state: entry.state }),
            agentKind: 'DSH',
            agentId,
            wsId: request.wsId,
            ...(workspace?.wsTitle === undefined ? {} : { wsTitle: workspace.wsTitle }),
            wsPath: path,
            // 活动时刻必须转发：不转的话手机端只能按「收到这一帧的时刻」排，
            // 而分页是一次几十条**同一毫秒**到达的 ⇒ 顺序退化为请求顺序，
            // 用户看到的就是「跟 DSH 上显示的不一样，不是最新的」。
            // 它不是可选的装饰，是这一页唯一的排序依据。
            updatedAt: entry.updatedAt,
            // 可见性两键：宿主**不**在分页里藏行（藏了 offset 会错位、手机也永远
            // 学不到该藏哪条），而是把 DSH 的判据送到手机，由手机在展示层过滤。
            ...(entry.origin === undefined ? {} : { origin: entry.origin }),
            ...(entry.blank === undefined ? {} : { blank: entry.blank }),
          })
        }
        await this.deps.client().resolveSessionPage(request.id)
      }
    } catch {
      // Swallow: the queue is durable in the node, so the next tick retries.
    } finally {
      this.running = false
    }
  }
}

/**
 * How many sessions one answer carries when the request did not say.
 *
 * 20 keeps a single JSON payload comfortably under the TCP text budget
 * (TEXT_TCP_LIMIT is 4096 bytes) even with long titles — the whole frame is
 * only sent when it cannot fit in a UDP packet, and overflowing the TCP budget
 * would make the node reject the frame outright.
 */
const DEFAULT_LIMIT = 20
