/**
 * 捎话 (Tidings) Tidings plugin, browser half.
 *
 * ## 2026-10-14 去面板化（设计文档 §2.1）
 *
 * 这个插件曾在 DSH 侧边栏占一个一级入口，里面是一个 8 视图、2000+ 行的 Web IM
 * 控制台。用户裁决**彻底去掉**它：DSH 里的人要开发、调度 Agent，没人在侧边栏常开一个
 * IM 面板 —— 那个面板是纯粹的体验臃肿与代码负债。
 *
 * 现在的形态与 `dsh-im` 等生态插件对齐：**设置页里的一个极简集成卡片**，
 * 零干扰，配置一次终身静默工作。
 *
 * 插件的核心使命因此收敛成两件（Host 半程，见 `src/index.ts`）：
 *   1. 听 DSH 会话/工作区事件并推给 `127.0.0.1:8788`；
 *   2. 应答手机端的历史会话分页请求（D8）。
 *
 * @module dsh-tidings/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: the client Context seats this half reads. `locale` and the slot map
// are declared by their own packages.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// 设置页 slot（`settings.section`）由 ui-settings 声明；本插件不直接依赖那个包
// （它还会拖进 configForms / api-remotes 一整套），所以只声明**本插件用到的那一席**。
import type {} from './settings-slots.d.ts'
import { TIDINGS_RPC_CHANNEL, type TidingsRpcEndpoint, type TidingsRpcResult, type TidingsRpcResultMap } from '../model.ts'
import { TidingsSettingsSection, type TidingsSettingsPort } from './TidingsSettingsSection.tsx'
import { en, zh } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
export const NS = 'tidings'

/** The settings section id (drives `only` filtering and nav identity). */
export const SECTION_ID = 'tidings'

/** Services this half reads from the client context. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Register the settings card and its copy.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tidings: dictionaries')
  const t = ctx.locale.bind(NS)
  // The client Context declares no `connection` seat of its own, so it is read
  // through `ctx.get` and narrowed here — the same shape other client plugins use.
  const connection = ctx.get('connection') as ConnectionHandle

  // The card's only channel to the Host half is this face, handed over at
  // registration rather than parked in a module-level handle.
  const port: TidingsSettingsPort = {
    call: <E extends TidingsRpcEndpoint>(
      endpoint: E,
      payload: unknown,
    ): Promise<TidingsRpcResult<TidingsRpcResultMap[E]>> =>
      connection.rpc.call(TIDINGS_RPC_CHANNEL, endpoint, payload) as Promise<TidingsRpcResult<TidingsRpcResultMap[E]>>,
  }

  // `order: -20` 让它在设置导航里靠前（与官方 account 的 -10 同量级但不抢位）。
  // `label` 由注册方给（设置外壳自己不拥有任何文案，见 ui-settings 的契约注释）。
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: -20,
    locale: NS,
    label: () => t('panel'),
    inject: () => ({ port }),
  }, TidingsSettingsSection))
}
