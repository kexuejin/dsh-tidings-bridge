/**
 * 捎话 (Tidings) settings card — the plugin's entire browser surface.
 *
 * ## 这张卡片的全部职责：说明 + 状态 + 引导
 *
 * 用户对本插件的裁决 chains（2026-10-14）：
 *   1. 「去面板化」—— 删掉 8 视图、2000+ 行的 Web IM 控制台；
 *   2. 「D7 的批准在桌面端是协议写的 ⇒ 这就应该桌面端做」—— 授权策略编辑与待批提示
 *      **不属于**这里，它是桌面端的活；
 *   3. 「感觉这里几乎只是一个说明跟引导就好吧」—— 所以卡片只留三样东西。
 *
 * 于是它现在只做三件事，一件都不多：
 *   · 说明这一页是干什么的；
 *   · 报告捎话桌面端（承载本机 DSH 会话的那个常驻节点）在不在；
 *   · 不在时给出**原因 + 去哪拿**（一个真链接，不是一句「请启动」）。
 *
 * ## 为什么工程细节（autoAnnounce / baseUrl / 收件人白名单）收进了折叠区
 *
 * 它们是配置项而不是日常动作：装好之后基本不动，摆在与状态同层会把「说明 + 引导」
 * 这件正事淹掉。但也不能删 —— 设计与 Config Schema 都要求它们可配（可配的东西必须
 * 有界面入口，否则就是一个改不了的配置项）。折中是：默认收起。
 *
 * ## 不在这里的东西（以及为什么）
 *
 * · 授权策略 / 待批申请：D7 规定「决定在桌面端」，这里只显示结果不做决定；
 * · 发消息 / 单会话消息流 / 配对码 / 令牌表单 / agent 会话台账：手机与桌面端已经做得
 *   更好，DSH 侧不需要它们各自的第二个入口。
 *
 * @module dsh-tidings/client/TidingsSettingsSection
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  TidingsConfigPatch,
  TidingsRpcEndpoint,
  TidingsRpcResult,
} from '../model.ts'
import css from './TidingsSettingsSection.module.css'

/** The Host RPC face this card reads and writes through. */
export interface TidingsSettingsPort {
  call<E extends TidingsRpcEndpoint>(endpoint: E, payload: unknown): Promise<TidingsRpcResult<unknown>>
}

/** What the section registration injects into this component. */
export interface TidingsSettingsInjected {
  readonly port: TidingsSettingsPort
}

/**
 * Composed props of one settings page.
 *
 * The five shares, in the shape every official settings page uses
 * (`AccountSectionProps` is the reference): runtime (the owner's `close`),
 * locale (the render machinery synthesizes `t` bound to our namespace — we do
 * **not** read `ctx.locale` ourselves), and our own inject face.
 */
export type TidingsSettingsSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'tidings'> & InjectFace<TidingsSettingsInjected>

/**
 * Where a user gets the 捎话 desktop app — the thing that must be running for this
 * bridge to do anything.
 *
 * ## Why a URL and not just a sentence
 *
 * The old panel's reachability failure only printed a shell command; the user had to
 * open a terminal. The next version said 「请启动捎话桌面端」, which is worse for a user
 * who does not have it installed — telling someone to launch a program they lack is not
 * a way out. So this card carries the **acquisition** path: a link to the project's
 * GitHub page. How to install from there is the project page's business, not this card's.
 *
 * User-set address (2026-10-14).
 */
const REPO_URL = 'https://github.com/kexuejin/tidings'

/** One settings page: explanation, state, and (when it matters) a way to get the host. */
export function TidingsSettingsSection({ t, port, close }: TidingsSettingsSectionProps): ReactNode {
  const [status, setStatus] = useState<StatusSnapshot>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [autoAnnounce, setAutoAnnounce] = useState<boolean | undefined>(undefined)
  const [baseUrl, setBaseUrl] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await port.call('status', {})
      const next = readStatus(result)
      setStatus(next)
      if (next.kind === 'ready') {
        setAutoAnnounce(next.config.autoAnnounce !== false)
        setBaseUrl(next.config.baseUrl ?? 'http://127.0.0.1:8788')
      }
    } catch {
      // ## 为什么必须接住（2026-10-14 真机抓到）
      //
      // 原先只有 finally。RPC 一旦被拒（宿主重启后浏览器还挂在旧通道上，就现成见过一次），
      // 这里既不落状态也不报错 ⇒ 卡片永远停在「检查中…」，按钮永远禁用，
      // **而屏幕上没有一句话说为什么**。用户看到的是一张死卡片。
      //
      // 落到 `failed`：界面会走「未检测到捎话桌面端」那一档，那句文案给出原因与出路（真链接）。
      setStatus({ kind: 'failed' })
    } finally {
      setBusy(false)
    }
  }, [port])

  useEffect(() => { void refresh() }, [refresh])

  const writeConfig = useCallback(async (patch: TidingsConfigPatch): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    try {
      await port.call('saveConfig', { config: patch })
      setNotice(t('settings.saved'))
      await refresh()
    } catch {
      setNotice(t('settings.failed'))
    } finally {
      setBusy(false)
    }
  }, [port, refresh, t])

  const state = status.kind === 'ready' ? status.state : status.kind === 'loading' ? 'loading' : 'unreachable'
  const connected = state === 'online'

  return (
    <div className={css.root}>
      <p className={css.lead}>{t('settings.lead')}</p>

      <div className={css.row}>
        <span className={css.rowLabel}>{t('settings.connection')}</span>
        <span className={connected ? css.stateOk : state === 'loading' ? css.stateIdle : css.stateBad}>
          <span className={css.dot} aria-hidden="true" />
          {stateLabel(state, status, t)}
        </span>
      </div>

      {connected
        ? null
        : (
          /*
           * 这一块必须同时给**原因**与**动作**（用户交付纪律：错误与空态都有原因与出路）。
           * 光写「请启动桌面端」对没装的人等于没有出路 —— 所以这里给一个可点的入口。
           */
          <div className={css.hint}>
            <p style={{ margin: 0 }}>{t('settings.notRunningWhy')}</p>
            <div className={css.guideActions}>
              <a className={css.link} href={REPO_URL} target="_blank" rel="noreferrer">
                {t('settings.getDesktop')}
              </a>
            </div>
          </div>
        )}

      <details className={css.details}>
        <summary className={css.summary}>{t('settings.advanced')}</summary>

        <div className={css.field}>
          <label className={css.rowLabel} htmlFor="tidings-auto-announce">{t('settings.autoAnnounce')}</label>
          <input
            id="tidings-auto-announce"
            type="checkbox"
            checked={autoAnnounce === true}
            disabled={busy || autoAnnounce === undefined}
            onChange={(event) => {
              const next = event.target.checked
              setAutoAnnounce(next)
              void writeConfig({ autoAnnounce: next })
            }}
          />
        </div>
        <p className={css.rowHint}>{t('settings.autoAnnounceHint')}</p>

        <div className={css.field}>
          <label className={css.rowLabel} htmlFor="tidings-base-url">{t('settings.baseUrl')}</label>
          <input
            id="tidings-base-url"
            className={css.input}
            value={baseUrl}
            disabled={busy}
            onChange={(event) => { setBaseUrl(event.target.value) }}
            onBlur={() => {
              const value = baseUrl.trim()
              if (value.length > 0) void writeConfig({ baseUrl: value })
            }}
          />
        </div>
        <p className={css.rowHint}>{t('settings.baseUrlHint')}</p>
      </details>

      <div className={css.actions}>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void refresh() }}>
          {busy ? t('settings.refreshing') : t('settings.refresh')}
        </Button>
        <Button size="sm" variant="ghost" onClick={close}>{t('settings.close')}</Button>
      </div>
      {notice !== undefined ? <p className={css.notice}>{notice}</p> : null}
    </div>
  )
}

type StatusSnapshot =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly state: string; readonly nick?: string; readonly online?: number; readonly config: TidingsConfigPatch }
  | { readonly kind: 'failed' }

function readStatus(result: TidingsRpcResult<unknown>): StatusSnapshot {
  const payload = (result as { readonly value?: unknown }).value
  if (typeof payload !== 'object' || payload === null) return { kind: 'failed' }
  const view = payload as {
    readonly state?: unknown
    readonly health?: { readonly nick?: string; readonly online?: number } | undefined
    readonly config?: { readonly effective?: TidingsConfigPatch } | undefined
  }
  return {
    kind: 'ready',
    state: typeof view.state === 'string' ? view.state : 'error',
    ...view.health === undefined ? {} : { nick: view.health.nick, online: view.health.online },
    config: view.config?.effective ?? {},
  }
}

/** 状态文案。已连接时带上节点名与在线数 —— 那是用户唯一能确认「是在跟谁说话」的地方。 */
function stateLabel(state: string, status: StatusSnapshot, t: TranslateNS<'tidings'>): string {
  if (state === 'online') {
    const nick = status.kind === 'ready' ? status.nick : undefined
    const online = status.kind === 'ready' ? status.online : undefined
    return nick === undefined
      ? t('settings.stateOnline')
      : t('settings.stateOnlineNamed', { nick, count: online ?? 0 })
  }
  if (state === 'loading') return t('settings.stateLoading')
  if (state === 'unauthorized') return t('settings.stateUnauthorized')
  return t('settings.stateUnreachable')
}