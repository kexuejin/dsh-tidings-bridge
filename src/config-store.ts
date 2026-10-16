/**
 * Runtime settings store for the Tidings panel.
 *
 * The Cordis row supplies deployment defaults; whatever the panel saves here
 * overrides them at request time, so a user never edits YAML to point the
 * plugin at a different control plane. Only non-secret settings live in this
 * file — the optional token goes through the DSH credentials provider.
 *
 * @module dsh-tidings/config-store
 */

import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { TidingsConfigPatch, TidingsConfigView } from './model.ts'
import { resolveConfig, type Config, type ResolvedConfig } from './tidings.ts'

const CONFIG_FILE = 'config-v1.json'

function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

function dshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const expanded = expandHome(raw.trim(), home)
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
  }
  return join(home, '.dsh')
}

/**
 * `$DSH_HOME/tidings/config-v1.json` is the store path since the 2026-10-04
 * rename. A pre-rename install still keeps its settings under `teahouse/`, so an
 * existing legacy file is adopted as-is: renaming a plugin must not silently
 * reset the node URL, port or timeout the user already entered.
 */
function configPath(dir: string = join(dshHome(), 'tidings')): string {
  const path = join(dir, CONFIG_FILE)
  try {
    if (!existsSync(path)) {
      const legacy = join(dshHome(), 'teahouse', CONFIG_FILE)
      if (existsSync(legacy)) return legacy
    }
  } catch {}
  return path
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function cleanString(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : undefined
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Keep only recognized settings that carry a usable value, so a stale key or a
 * blank field can never be written back into the store.
 * @param value - an untrusted patch, typically a panel payload.
 * @returns the patch reduced to known settings.
 */
export function sanitizeTidingsConfigPatch(value: unknown): TidingsConfigPatch {
  const raw = record(value) ?? {}
  const baseUrl = cleanString(raw.baseUrl)
  const tokenCredentialRef = cleanString(raw.tokenCredentialRef)
  const timeoutMs = numberField(raw.timeoutMs)
  const defaultPort = numberField(raw.defaultPort)
  const inboxLimit = numberField(raw.inboxLimit)
  // 2026-10-14：autoAnnounce / announceTargets 进了设置卡片（设计文档 §2.2），
  // 而此前它们**只**在 `Config` 里、没过这道闸 —— 于是卡片写进去的值会被静默丢弃，
  // 表现是「开关拨了但重启又弹回去」。放行它们，形状按 `Config` 的定义收窄。
  const autoAnnounce = typeof raw.autoAnnounce === 'boolean' ? raw.autoAnnounce : undefined
  const announceTargets = Array.isArray(raw.announceTargets)
    ? raw.announceTargets.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map(entry => entry.trim())
    : undefined
  return {
    ...baseUrl === undefined ? {} : { baseUrl },
    ...tokenCredentialRef === undefined ? {} : { tokenCredentialRef },
    ...timeoutMs === undefined ? {} : { timeoutMs },
    ...defaultPort === undefined ? {} : { defaultPort },
    ...inboxLimit === undefined ? {} : { inboxLimit },
    ...autoAnnounce === undefined ? {} : { autoAnnounce },
    ...announceTargets === undefined ? {} : { announceTargets },
  }
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

/** Row defaults plus the panel's saved overrides, persisted as one JSON file. */
export class TidingsConfigStore {
  private overrides: TidingsConfigPatch | undefined

  constructor(private readonly base: TidingsConfigPatch, private readonly file: string = configPath()) {}

  load(): TidingsConfigPatch {
    if (this.overrides !== undefined) return this.overrides
    try {
      this.overrides = sanitizeTidingsConfigPatch(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      this.overrides = {}
    }
    return this.overrides
  }

  /** Settings every request uses: saved overrides over the row defaults. */
  /**
   * The effective config: defaults filled in, ranges checked.
   *
   * Returns `ResolvedConfig` rather than the raw partial `Config`: every
   * consumer (`createTidingsClient`, the announcer, the panel view) wants the
   * resolved shape, and handing back the partial one forced each call site to
   * re-resolve — which is how the announcer ended up with a type-incompatible
   * `Config` where it declared `ResolvedConfig`.
   */
  current(): ResolvedConfig {
    return resolveConfig({ ...this.base, ...this.load() })
  }

  view(): TidingsConfigView {
    return { path: this.file, overrides: this.load(), effective: this.current() }
  }

  /**
   * Validate and persist one patch.
   * @param patch - an untrusted panel payload.
   * @returns the store view after the write.
   */
  save(patch: unknown): TidingsConfigView {
    const next = sanitizeTidingsConfigPatch(patch)
    resolveConfig(next)
    this.overrides = next
    writeJsonAtomic(this.file, next)
    return this.view()
  }
}
