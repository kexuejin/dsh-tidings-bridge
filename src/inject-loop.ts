// SPDX-License-Identifier: GPL-3.0-only

/**
 * Tidings 入站 prompt 的**轮询循环**。
 *
 * ## 为什么是轮询而不是事件推送
 *
 * agentNode 的 `/v1/inbox` 是**拉取式**的（`since` 游标增量）。要做推送得改协议、
 * 加长连接 —— 那是一条独立的工程量。开发阶段先用轮询：TTL 短一点（默认 2s），
 * 用户感知不到的延迟，代价是空闲时每条 tick 一次本机回环 HTTP。
 *
 * ## 游标纪律
 *
 * `nextSince` 由服务端给出，**必须**用它推进而不是自己 +1：服务端按 `at` 排，
 * 同一毫秒可能有多条，自己加一会漏。首次启动用 0 会把历史全部拉一遍 ——
 * 那些历史绝不能被当成新指令执行（用户几个月前说的话会突然跑起来）。
 * 所以第一轮只**对齐游标**，不投递。
 */

import { deliverTidingsPrompt, type AgentsServiceLike } from './inject.ts'
import type { TidingsMessageView } from './model.ts'

/** 循环需要的外部能力（全部由调用方注入，便于测试与解耦）。 */
export interface TidingsInjectionLoopDeps {
  /** 拉一页增量；实现里做 HTTP。 */
  fetchPage(since: number): Promise<{
    readonly since: number
    readonly nextSince: number
    readonly messages: readonly TidingsMessageView[]
  }>
  /** 某个 agent 的候选会话（按活跃度倒序）。`wsId` = 会话自己的归属。 */
  candidatesFor(agentName: string | undefined): Promise<
    readonly { readonly sessionId: string; readonly wsId?: string | null }[]
  >
  /** `ctx.get('agents')` 的结果；undefined = 宿主没提供。 */
  agents(): AgentsServiceLike | undefined
  /** 把文本编成 DSH 的 UserMessage。 */
  buildMessage(text: string): unknown
  /** 投递结果回调（写日志/上报）；不抛。 */
  onOutcome?(message: TidingsMessageView, outcome: string, reason?: string): void
  /** 当前游标持久化（重启后接着读，避免重放）。 */
  readCursor(): number
  writeCursor(cursor: number): void
}

/**
 * 跑一轮。抽成**单轮函数**而不是一个 while 循环：
 *
 * ① 可测 —— 测试里调一次就能断言全部行为，不用跟定时器赛跑；
 * ② 出错隔离 —— 一轮抛错不该让整个循环死掉（见下面的 try）。
 *
 * @param firstRun 首次启动：**只对齐游标，不投递**（理由见文件头）。
 */
export async function runInjectionRound(
  deps: TidingsInjectionLoopDeps,
  firstRun: boolean,
): Promise<{ readonly delivered: number; readonly cursor: number }> {
  const since = deps.readCursor()
  const page = await deps.fetchPage(since)
  if (firstRun) {
    // 首轮只对齐：把游标推到最新，一条都不投。
    // 这一步防的是「插件第一次装上，把几个月的旧消息当成待执行指令」。
    deps.writeCursor(page.nextSince)
    return { delivered: 0, cursor: page.nextSince }
  }
  if (page.messages.length === 0) {
    // 没有新消息也推进游标：服务端可能已经跳过了空区间。
    if (page.nextSince !== since) deps.writeCursor(page.nextSince)
    return { delivered: 0, cursor: page.nextSince }
  }
  let delivered = 0
  for (const message of page.messages) {
    // 只处理带注入判定的：其余是普通聊天，桥接侧不该有意见。
    if (message.agentHint === undefined) continue
    const candidates = await deps.candidatesFor(message.agentHint.agentName)
    const outcome = deliverTidingsPrompt(
      message,
      candidates,
      deps.agents(),
      deps.buildMessage,
    )
    if (outcome.kind === 'injected') delivered += 1
    if (outcome.kind !== 'skipped') {
      // skipped 是正常情况（不是给 agent 的），不报；其余四种都报。
      deps.onOutcome?.(
        message,
        outcome.kind,
        'reason' in outcome ? outcome.reason : undefined,
      )
    }
  }
  deps.writeCursor(page.nextSince)
  return { delivered, cursor: page.nextSince }
}
