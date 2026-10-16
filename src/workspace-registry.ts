/**
 * Stable workspace and agent identity for this host.
 *
 * PPE-1 增补 D1 requires the **host** to mint and persist `wsId`: the phone
 * groups sessions by it, and an id that changed on restart would split one
 * project into two workspaces. Ids are therefore derived from the working
 * directory once and then kept in `$DSH_HOME/tidings/workspaces.json`, so a
 * restart hands the same workspace the same id.
 *
 * `agentId` (增补 D6) follows the same rule one level up: one stable id for this
 * DSH host process family, generated on first use and reused forever after.
 *
 * Both files are written atomically with owner-only mode, like the settings
 * store in `config-store.ts`: these are local facts about the user's projects,
 * not secrets, but nothing in this directory is world-readable.
 *
 * @module dsh-tidings/workspace-registry
 */

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** Workspace ledger filename, next to `config-v1.json`. */
const WORKSPACES_FILE = 'workspaces.json'

/** Host identity filename, next to `config-v1.json`. */
const IDENTITY_FILE = 'identity.json'

/** Protocol limit for `wsId` / `agentId` (增补 §2.1: `Limits.AGENT_WS_ID = 64`). */
const MAX_ID_LENGTH = 64

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'w', 0o600)
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' })
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    try { chmodSync(tmp, 0o600) } catch {}
    renameSync(tmp, path)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * The stable id for one working directory: `ws-` + 12 hex of its SHA-256.
 *
 * Derived rather than stored on first use because it must be reproducible: a
 * second DSH install, a reinstalled plugin, or a lost ledger all have to agree
 * that `/x/y` is the same workspace. The path is an *attribute* (`wsPath`), and
 * a rename therefore reads as a new workspace — 增补 §9 未决 1 leaves the
 * decoupled alternative to whoever can prove two paths are one project.
 */
export function workspaceIdOf(cwd: string): string {
  return `ws-${createHash('sha256').update(cwd, 'utf8').digest('hex').slice(0, 12)}`
}

/**
 * Display name for one workspace: the directory's own name.
 *
 * This is the host *supplying* the title, which is what 增补 §2.1 asks for. The
 * prohibition is on the receiving UI guessing a name from `wsPath` when no
 * `wsTitle` arrived — not on this side naming its own project.
 */
export function workspaceTitleOf(cwd: string): string {
  const name = basename(cwd).trim()
  return name.length === 0 ? cwd : name
}

/** One workspace: stable id, display title, and the path it was seen at. */
export interface TidingsWorkspace {
  readonly wsId: string
  readonly wsTitle: string
  readonly wsPath: string
}

/**
 * `cwd → wsId` ledger plus the host's own `agentId`.
 *
 * Every method is fail-soft: an unreadable or unwritable ledger falls back to
 * the derived id, which is stable anyway, so no announcement is ever blocked by
 * this file's health.
 */
export class TidingsWorkspaceRegistry {
  private entries: Record<string, string> | undefined

  private agentId: string | undefined

  /**
   * @param dir - the plugin's settings directory; `$DSH_HOME/tidings` by default.
   */
  constructor(private readonly dir: string) {}

  private get workspacesFile(): string {
    return join(this.dir, WORKSPACES_FILE)
  }

  private get identityFile(): string {
    return join(this.dir, IDENTITY_FILE)
  }

  /**
   * The workspace one session belongs to, or `undefined` when the session
   * carries no working directory. No cwd means **unattributed** (增补 §1: an
   * unattributed session is a first-class state), so no workspace is invented.
   */
  workspaceOf(cwd: string | undefined): TidingsWorkspace | undefined {
    const path = typeof cwd === 'string' ? cwd.trim() : ''
    if (path.length === 0) return undefined
    return {
      wsId: this.idFor(path),
      wsTitle: workspaceTitleOf(path),
      wsPath: path,
    }
  }

  /**
   * Reverse lookup: the canonical path behind a workspace id, or `undefined`.
   *
   * Why the registry must answer this: the phone asks by `wsId` (the only stable
   * key on the wire), while DSH keys sessions by `cwd`. The ledger this registry
   * already persists **is** that map, so the reverse lookup costs one read
   * instead of a second index that could drift from it.
   */
  pathOf(wsId: string): string | undefined {
    if (wsId.length === 0) return undefined
    const entries = this.load()
    for (const [path, id] of Object.entries(entries)) {
      if (id === wsId && path.length > 0) return path
    }
    return undefined
  }

  /** Every workspace this host has announced, newest path first. */
  known(): readonly TidingsWorkspace[] {
    const entries = this.load()
    return Object.entries(entries)
      .filter(([path]) => path.length > 0)
      .map(([path, wsId]) => ({ wsId, wsTitle: workspaceTitleOf(path), wsPath: path }))
      .sort((a, b) => b.wsPath.localeCompare(a.wsPath))
  }

  /**
   * This DSH host's stable `agentId` (增补 D6): `dsh-` + 8 hex, generated once
   * and reused across restarts. Multiple workspaces and sessions share it, which
   * is exactly the point — it is the *forwarder's* identity, not the session's.
   */
  hostAgentId(): string {
    if (this.agentId !== undefined) return this.agentId
    const stored = this.readAgentId()
    this.agentId = stored ?? `dsh-${randomBytes(4).toString('hex')}`
    if (stored === undefined) this.persistAgentId(this.agentId)
    return this.agentId
  }

  private idFor(cwd: string): string {
    const derived = workspaceIdOf(cwd)
    const entries = this.load()
    const stored = entries[cwd]
    // A stored id that is empty or over the protocol limit is not a usable
    // identity; the derived id is both valid and what a fresh install would get.
    if (typeof stored === 'string' && stored.length > 0 && stored.length <= MAX_ID_LENGTH) return stored
    const next = { ...entries, [cwd]: derived }
    this.entries = next
    this.persist(next)
    return derived
  }

  private load(): Record<string, string> {
    if (this.entries !== undefined) return this.entries
    const next: Record<string, string> = {}
    try {
      const raw = record(JSON.parse(readFileSync(this.workspacesFile, 'utf8')))
      const workspaces = record(raw?.workspaces) ?? raw ?? {}
      for (const [path, wsId] of Object.entries(workspaces)) {
        if (typeof wsId !== 'string' || wsId.length === 0 || wsId.length > MAX_ID_LENGTH) continue
        if (path.length === 0) continue
        next[path] = wsId
      }
    } catch {
      // Missing or unreadable ledger: fall through to the empty map, which makes
      // the next lookup write the derived id.
    }
    this.entries = next
    return next
  }

  private persist(value: Record<string, string>): void {
    try {
      writeJsonAtomic(this.workspacesFile, { version: 1, workspaces: value })
    } catch {
      // The derived id still works for this run; a write failure must not stop
      // the announcement or surface as an error the user cannot act on.
    }
  }

  private readAgentId(): string | undefined {
    try {
      const raw = record(JSON.parse(readFileSync(this.identityFile, 'utf8')))
      const value = typeof raw?.agentId === 'string' ? raw.agentId.trim() : ''
      return value.length > 0 && value.length <= MAX_ID_LENGTH ? value : undefined
    } catch {
      return undefined
    }
  }

  private persistAgentId(agentId: string): void {
    try {
      writeJsonAtomic(this.identityFile, { version: 1, agentId })
    } catch {
      // Same rule as the workspace ledger: the in-memory id is the authority for
      // this run, and a failed write downgrades nothing else.
    }
  }

  /** Whether the ledger exists on disk; reported by the panel's status line. */
  exists(): boolean {
    try {
      return existsSync(this.workspacesFile)
    } catch {
      return false
    }
  }
}
