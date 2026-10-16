/**
 * Copy for the 捎话 (Tidings) settings card.
 *
 * Two dictionaries, one key union. Every string the card renders comes from here
 * so the plugin ships bilingual out of the box; the Host never sees these.
 *
 * `zh` is the source of truth for the key union — `en` is typed as
 * `Record<TidingsKey, string>` so a missing translation is a compile error.
 *
 * ## 2026-10-14：从一个面板的 310 个键砍到这里
 *
 * 去面板化删掉了它的字典；随后用户的两条裁决又砍掉一批：
 *   · 「D7 的批准在桌面端是协议写的 ⇒ 这就应该桌面端做」—— 授权策略编辑与待批提示
 *     从这一页移除（它们归桌面端），所以 policy* / pendingRequests 的键也没了；
 *   · 「感觉这里几乎只是一个说明跟引导就好吧」—— 只留说明、状态、引导，加一组
 *     默认收起的高级配置。
 *
 * 谁要加新文案，先确认它属于这三样之一 —— 面板的键不该因为「也许以后用得上」而复活。
 *
 * @module dsh-tidings/client/locales
 */

/** Simplified-Chinese dictionary; the key union is derived from it. */
export const zh = {
  /** 设置导航里那一项的名字（也是卡片标题）。 */
  panel: '捎话',
  /** 这一页是干什么的 —— 卡片的第一句，也是唯一一句说明。 */
  'settings.lead': '把本机 DSH 的工作区与会话同步到局域网上的手机；手机端能看到并打开这些会话。',
  'settings.connection': '连接状态',
  'settings.stateOnline': '已连接',
  'settings.stateOnlineNamed': '已连接 · {nick} · {count} 个邻居在线',
  'settings.stateLoading': '检查中…',
  'settings.stateUnreachable': '未检测到捎话桌面端',
  'settings.stateUnauthorized': '需要访问令牌',
  /** 未连接时：为什么（原因），紧接着给去哪拿（动作）。两句缺一不可。 */
  'settings.notRunningWhy': '这台电脑上的 DSH 会话现在到不了手机：捎话桌面端是承载该能力的常驻节点，它没有在运行。',
  'settings.getDesktop': '前往 GitHub 获取捎话桌面端 ↗',
  'settings.advanced': '高级选项',
  'settings.autoAnnounce': '自动宣告工作区与活动会话',
  'settings.autoAnnounceHint': '开启时，DSH 新开会话或推进会话就实时推给手机；关闭后只有手机主动拉取时才同步。',
  'settings.baseUrl': '控制面地址',
  'settings.baseUrlHint': '留默认值即可。只有桌面端监听在别的端口时才需要改（它默认固定 127.0.0.1:8788）。',
  'settings.refresh': '重新检查',
  'settings.refreshing': '检查中…',
  'settings.close': '关闭',
  'settings.saved': '已保存',
  'settings.failed': '保存失败，请稍后重试。',
} as const

/** Every key the card may render. */
export type TidingsKey = keyof typeof zh

/** English dictionary; missing a key here is a compile error, by type. */
export const en: Record<TidingsKey, string> = {
  panel: 'Tidings',
  'settings.lead': 'Sync this machine\'s DSH workspaces and sessions to phones on the LAN, so they can be seen and opened there.',
  'settings.connection': 'Connection',
  'settings.stateOnline': 'Connected',
  'settings.stateOnlineNamed': 'Connected · {nick} · {count} peers online',
  'settings.stateLoading': 'Checking…',
  'settings.stateUnreachable': 'Tidings desktop app not detected',
  'settings.stateUnauthorized': 'Access token required',
  'settings.notRunningWhy': 'DSH sessions on this machine cannot reach your phone right now: the Tidings desktop app is the resident node that carries them, and it is not running.',
  'settings.getDesktop': 'Get the Tidings desktop app on GitHub ↗',
  'settings.advanced': 'Advanced',
  'settings.autoAnnounce': 'Announce workspaces and live sessions',
  'settings.autoAnnounceHint': 'When on, a new or advancing DSH session is pushed to phones immediately. When off, phones only get sessions they ask for.',
  'settings.baseUrl': 'Control plane address',
  'settings.baseUrlHint': 'Leave the default unless the desktop app listens on another port (it defaults to 127.0.0.1:8788).',
  'settings.refresh': 'Check again',
  'settings.refreshing': 'Checking…',
  'settings.close': 'Close',
  'settings.saved': 'Saved',
  'settings.failed': 'Could not save. Please try again.',
}
