/**
 * The two host services this plugin consumes, declared locally.
 *
 * ## Why a local declaration instead of importing the harness packages
 *
 * `ctx.workspaceRegistry` and `ctx.sessionController` are declared by
 * `@deepseek-ai/dsh-workspace` / `@deepseek-ai/dsh-session-controller`, but
 * those packages are **not** resolvable from this plugin's own install (a
 * plugin is loaded by the host and must not pin a harness version). A local
 * declaration states exactly the surface we use — nothing more — so a harness
 * refactor that keeps these methods cannot silently widen what we can call.
 *
 * The shapes mirror `packages/workspace/workspace` and
 * `packages/api/session-controller` at 2026-10-14.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly workspaceRegistry: {
      /** Every workspace this host knows, newest-first per the host's own order. */
      list(): readonly {
        readonly id: string
        readonly path: string
        readonly title: string
        readonly sessionIds: readonly string[]
      }[]
    }
    readonly sessionController: {
      /**
       * Every visible attached **and persisted** session, with its canonical
       * `cwd`. This is the source for historical conversations: the
       * `session/created` events the plugin otherwise listens to only fire for
       * sessions that are live in the current process.
       */
      list(): Promise<
        readonly {
          readonly sessionId: string
          readonly updatedAt: number
          readonly cwd?: string
          readonly title?: string
          readonly running?: boolean
        }[]
      >
    }
  }
}

export {}
