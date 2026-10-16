/**
 * Answer one `agent-session-page` request from the phone (PPE-1 增补 D8).
 *
 * ## Why this exists
 *
 * `agent-session` frames are only emitted while a session is **live in this
 * process** (`session/created` / `session/event`). A DSH that has run 300
 * sessions therefore shows a workspace with "6 conversations" on the phone and
 * **zero actual rows** once opened. The data was never missing — the host
 * always had it — the phone simply had no way to ask.
 *
 * ## Where the data comes from
 *
 * `ctx.sessionController.list()` returns every visible attached **and
 * persisted** session with its `cwd`, which is exactly the join key: the
 * phone asked for one workspace, and a workspace is one canonical directory
 * (`Workspace.path`). We page by `offset`/`limit` because a single TCP frame
 * tops out at 4096 bytes — a hundred summaries do not fit in one.
 *
 * Always `updatedAt` descending, so the first page is the most recent work —
 * the order the phone shows without further sorting.
 */
export interface SessionPageEntry {
  readonly sessionId: string
  readonly title: string | undefined
  /** Coarse state for the phone's badge. `running` → `busy`; otherwise omitted. */
  readonly state: string | undefined
  readonly updatedAt: number
  /**
   * 可见性两键：手机照 DSH 的 `sessionVisible()` 在展示层过滤。
   *
   * **不能在这一层过滤** —— 这一页的 offset 与手机本地已知条数同分母，少发一条
   * 就会让下一页错位；而且被过滤掉的行手机永远学不到它该被隐藏
   * （absence of evidence）。判据原样送到手机，由手机过滤。
   */
  readonly origin: string | undefined
  readonly blank: boolean | undefined
}

export interface SessionPageResult {
  readonly entries: readonly SessionPageEntry[]
  /** Total sessions this workspace has, so the caller can report "N more". */
  readonly total: number
}

/**
 * Read one page of sessions for a workspace path.
 *
 * Returns `undefined` when the host cannot answer (no session service, or the
 * call threw) — the caller then stays silent rather than sending a fake
 * "empty" page, which the phone would render as "this workspace has no work".
 */
export type SessionPageProvider = (
  path: string,
  offset: number,
  limit: number,
) => Promise<SessionPageResult | undefined>
