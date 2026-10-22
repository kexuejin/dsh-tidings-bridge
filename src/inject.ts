// SPDX-License-Identifier: GPL-3.0-only

/**
 * Tidings（捎话）→ 本机 agent 的 prompt 注入。
 *
 * ## 职责边界（这条重构的核心）
 *
 * 本模块**只消费结论，不做策略判定**。
 *
 * 「这条消息是不是 @ 到 agent」「发送者有没有执行权」「该投给哪个会话」三个判据
 * 全部在 Tidings 侧（Kotlin 的 `core` 模块：`AgentExecAuthorizer` / `AgentSessionPick` /
 * `mentionedVirtualAgent`），随 `/v1/inbox` 的 `agentHint` 一起过来。
 *
 * ## 为什么这样切
 *
 * 之前这里有一份 `pickAgentSession`，是 Kotlin 侧 `AgentSessionPick` 的 TypeScript 重写。
 * 那意味着**每接一个新 agent 宿主，就要把这套策略再写一遍**，而且两份会漂。
 * 现在桥接侧只剩下「拿到 targetSessionId → 调自己宿主的 followup」。
 * 接新 agent 的成本因此降到「写一个薄适配器」，而不是「重写策略」。
 *
 * ## 三档结果
 *
 * - `injected` —— 投出去了；
 * - `skipped` —— 不是给 agent 的（正常跳过）；
 * - `refused` —— 是给 agent 的但不该投（没授权 / 没会话 / 空指令）。
 *
 * 三者分开而不是统一返回 boolean：拒绝时要能说清为什么，否则用户会以为是宿主卡住了。
 */

import type { TidingsMessageView } from './model.ts'

/** 一次注入尝试的结果。 */
export type TidingsInjectionOutcome =
  | { readonly kind: 'injected'; readonly sessionId: string }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * 一条消息要不要注入、投给谁。
 *
 * **纯函数**：不碰 ctx、不碰会话表，只吃「消息 + 本地候选」，所以能被单测秒级钉住。
 * 真正的 `agent.followup()` 调用在 [deliverTidingsPrompt] 里，是薄薄一层。
 *
 * @param candidates 仅用于**兜底校验**（Tidings 给的会话在不在本地候选里），不用于挑选。
 */
export function decideTidingsInjection(
  message: TidingsMessageView,
  candidates: readonly { readonly sessionId: string; readonly wsId?: string | null }[],
): TidingsInjectionOutcome {
  const hint = message.agentHint
  if (hint === undefined) {
    return { kind: 'skipped', reason: '这条消息没有注入判定（不是给 agent 的）' }
  }
  if (!hint.addressedToAgent) {
    return { kind: 'skipped', reason: '没有 @ 到本机任何 agent' }
  }
  // **授权**：只有群主 / 管理员 / agent 宿主 / 显式授权者可以让本机执行。
  // 判据在 Tidings 侧；缺键（旧版 Tidings）按 false 处理 —— fail-closed。
  if (hint.senderMayExecute !== true) {
    const why = hint.denyReason === undefined ? '没有执行授权' : `没有执行授权（${hint.denyReason}）`
    return { kind: 'refused', reason: why }
  }
  // **回声的判据是「发送者是不是 agent」，不是方向。**
  //
  // 原先只看 `direction !== 'in'`，于是**本机用户 @ 自己的 agent 第一条就被跳过**：
  // 那条消息 direction 是 `out`（本机发的），但它不是回声 —— 它是用户第一次下指令。
  // 真机症状：消息发出去了、对端手机也收到了、但 agent 从来不执行。
  //
  // 三种情况的正确判据：
  //   用户 @ 自己的 agent   out + 发送者是人    → 该注入
  //   agent 自己的回复      out + 发送者是 agent → 不注入（那才是回声）
  //   别人 @ 你的 agent     in                 → 该注入
  //
  // `senderIsAgent` 由 Tidings 侧算好（与 senderMayExecute / targetSessionId 同源）：
  // 桥接侧不该自己拼发送者身份，否则「接一个新 agent 就重写一遍策略」会重演。
  if (hint.senderIsAgent === true) {
    return { kind: 'skipped', reason: '这是 agent 自己说的话，不回声' }
  }
  const text = message.text.trim()
  if (text.length === 0) {
    return { kind: 'refused', reason: '消息正文为空' }
  }
  // **会话由 Tidings 侧选定**（`targetSessionId`），这里不再自己挑。
  const target = hint.targetSessionId?.trim()
  if (target === undefined || target.length === 0) {
    return {
      kind: 'refused',
      reason: '没有算出可投的会话（该 agent 在工作区下没有会话，或还没同步）',
    }
  }
  // 兜底校验：Tidings 说投这个，但本地候选里没有它 ⇒ 不投（防旧数据 / 竞态）。
  if (candidates.length > 0 && !candidates.some(c => c.sessionId === target)) {
    return { kind: 'refused', reason: `目标会话 ${target} 不在本地候选里（可能刚结束）` }
  }
  return { kind: 'injected', sessionId: target }
}

/** 把 `@dsh` 那段去掉，留下真正的指令（与 Tidings 侧 `extractAgentPrompt` 同口径）。 */
export function stripMention(text: string, agentName?: string): string {
  const name = agentName?.trim()
  const withoutMention = name !== undefined && name.length > 0
    ? text.replace(new RegExp(`@${escapeRegExp(name)}`, 'gi'), ' ')
    : text.replace(/@[\w.-]+/gu, ' ')
  return withoutMention.replace(/\s+/gu, ' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * 本机 agent 服务的最小视图（只用到 `get` + `followup`）。
 *
 * 为什么自己声明一份而不 import 官方类型：本插件的 `inject` 只许写基线服务
 * （`scripts/check-inject-baseline.mjs` 钉着一次真实故障：多写一个名字会让 cordis
 * 拒绝加载整个插件，且日志里一行都没有）。拿不到的服务一律走运行时可选读取。
 */
export interface AgentsServiceLike {
  get(sessionId: string): AgentHandleLike | undefined
}

/** agent 句柄的最小视图。 */
export interface AgentHandleLike {
  followup(message: unknown): void
}

/** 一次真正投递的结果（比 TidingsInjectionOutcome 多一层「服务在不在」）。 */
export type TidingsDeliveryOutcome =
  | { readonly kind: 'injected'; readonly sessionId: string }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * 把一条 Tidings 消息真的投进本机 agent 会话。
 *
 * 分两段：先 [decideTidingsInjection] 判（纯函数、可测），再调 `followup`。
 */
export function deliverTidingsPrompt(
  message: TidingsMessageView,
  candidates: readonly { readonly sessionId: string; readonly wsId?: string | null }[],
  agents: AgentsServiceLike | undefined,
  buildMessage: (text: string) => unknown,
): TidingsDeliveryOutcome {
  const decision = decideTidingsInjection(message, candidates)
  if (decision.kind !== 'injected') return decision
  if (agents === undefined) {
    // 宿主没提供 agents 服务：**如实说 unavailable**，不假装投过。
    return { kind: 'unavailable', reason: '宿主没有提供 agents 服务，无法注入会话' }
  }
  const handle = agents.get(decision.sessionId)
  if (handle === undefined) {
    return { kind: 'refused', reason: `会话 ${decision.sessionId} 此刻不存在（可能刚结束）` }
  }
  const text = stripMention(message.text, message.agentHint?.agentName)
  if (text.length === 0) {
    return { kind: 'refused', reason: '去掉 @ 之后没有可执行的指令' }
  }
  handle.followup(buildMessage(text))
  return { kind: 'injected', sessionId: decision.sessionId }
}
