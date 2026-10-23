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
 * The control-plane address itself is user-editable (advanced section, 2026-10-14).
 */
const REPO_URL = 'https://github.com/kexuejin/tidings'

/** 控制面的默认地址；`saveConfig` 里存的就是它，探活也用它兜底。 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8788'

/**
 * 直接问控制面「你在不在」，**不经 DSH 的插件 RPC**。
 *
 * ## 为什么需要这条兜底
 *
 * 面板 RPC 在框架内部要注册一条 HTTP 前缀路由（`dsh-client-connection` 的 `register`），
 * 因此需要宿主提供 `webServer`。桌面端宿主不提供它 ⇒ 通道挂不起来 ⇒ 卡片读不到状态，
 * 而桌面端其实跑得好好的（8788 在监听、`/healthz` 返回 ok）。那时卡片显示
 * 「未检测到捎话桌面端」，把「我读不到」说成了「它不在」。
 *
 * 而卡片本身跑在**浏览器**里、和 8788 在同一台机器上：只要控制面回一个允许的 Origin，
 * 它就能自己读到状态，根本不需要那条通道。控制面已对 `/healthz` 开放回环来源的 CORS。
 *
 * 只读 `/healthz`（节点名与邻居数），不碰 `/v1/` —— 那条路要令牌，也不该被网页读到。
 */
async function probeControlPlane(baseUrl: string): Promise<{ view?: StatusSnapshot; reason: string }> {
  // 两个写法都试：`127.0.0.1` 与 `localhost` 在个别宿主上解析/策略不同，
  // 而「哪个都不通」与「某一个不通」是不同的结论 —— 失败原因里带上具体 URL，
  // 界面就能显示到底是在跟谁说话。
  const base = baseUrl.replace(/\/+$/, '')
  const candidates = base.includes('localhost') ? [base] : [base, base.replace('127.0.0.1', 'localhost')]
  const failures: string[] = []
  for (const candidate of candidates) {
    const result = await probeOne(candidate)
    if (result.view !== undefined) return result
    failures.push(result.reason)
  }
  return { reason: failures.join('；') }
}

async function probeOne(baseUrl: string): Promise<{ view?: StatusSnapshot; reason: string }> {
  const target = `${baseUrl}/healthz`
  try {
    const response = await fetch(target, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) return { reason: `${target} → HTTP ${String(response.status)}` }
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return { reason: `${target} → 响应不是 JSON 对象` }
    const view = body as { ok?: unknown; nick?: unknown; online?: unknown }
    if (view.ok !== true) return { reason: `${target} → ok 不为 true` }
    return {
      view: {
        kind: 'ready',
        state: 'online',
        ...typeof view.nick === 'string' ? { nick: view.nick } : {},
        ...typeof view.online === 'number' ? { online: view.online } : {},
        config: {},
      },
      reason: '',
    }
  } catch (error) {
    // 「探不到」有好几种完全不同的原因（桌面端没起 / 被 CORS 拒 / 页面来源不是回环 /
    // 被 CSP 拦）。把它们压成一句「未检测到」，正是这个缺陷最初的样子 ——
    // 所以把原因**带出来**，界面能显示它，人就不用靠猜。
    return { reason: `${target} → ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}` }
  }
}

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
      // ## 先别认输：直接问一次控制面（2026-10-23 抓到）
      //
      // 走到这个 catch 有两种完全不同的原因：
      //   ① 桌面端真的没起 —— 那时确实该报「未检测到」；
      //   ② **面板通道挂不起来**（桌面端宿主没有 webServer），而桌面端好好地在跑。
      // 原先把两者都写成「未检测到捎话桌面端」，把宿主限制说成了用户的错。
      //
      // 所以先直连 `/healthz`：能读到就把状态显示对，读不到才落到失败态。
      const probed = await probeControlPlane(baseUrl === '' ? DEFAULT_BASE_URL : baseUrl)
      // 通道挂了 + 直连也探不到 ⇒ 这是**宿主限制**，不是用户没开桌面端。
      // 两者的出路完全不同，所以状态就分开存，不要压成一个 failed。
      setStatus(probed.view ?? { kind: 'channelDown', reason: probed.reason })
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

  const state = status.kind === 'ready'
    ? status.state
    : status.kind === 'loading' ? 'loading' : status.kind === 'channelDown' ? 'error' : 'unreachable'
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
            {status.kind === 'channelDown'
              ? (
                  <>
                    <p style={{ margin: 0 }}>{t('settings.channelDownWhy')}</p>
                    <p className={css.notice}>{t('settings.channelDownHow')}</p>
                    {status.reason === '' ? null : <p className={css.notice}>{status.reason}</p>}
                  </>
                )
              : (
                  <>
                    <p style={{ margin: 0 }}>{t('settings.notRunningWhy')}</p>
                    <div className={css.guideActions}>
                      <a className={css.link} href={REPO_URL} target="_blank" rel="noreferrer">
                        {t('settings.getDesktop')}
                      </a>
                    </div>
                  </>
                )}
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
  /** 面板通道没挂上（宿主限制），且直连控制面也没探到 —— 与「桌面端没运行」是两件事。 */
  | { readonly kind: 'channelDown'; readonly reason: string }
  /** 桌面端确实没运行（探活明确拒绝/不可达，且没有更具体的原因）。 */
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
  // `error` 是「注解到了但读不出来」（通道/协议层），`unreachable` 才是「桌面端没在跑」。
  // 两者混成一句会把宿主限制说成用户的错 —— 2026-10-23 就是这么误导的。
  if (state === 'error') return t('settings.stateChannelDown')
  return t('settings.stateUnreachable')
}