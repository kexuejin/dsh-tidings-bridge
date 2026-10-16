#!/usr/bin/env node
/**
 * 会话可见性门禁 —— 手机上能看到的会话，必须是 DSH 也会显示的那些。
 *
 * ## 它钉的是什么（2026-10-14 真机抓到）
 *
 * 用户的话：「目前工作区列表上显示的会话，看起来跟 dsh 上显示的不一样」。真机上多出来的
 * 那一截是**子代理会话**：19 对「父会话 + \u0060MEMORY.md\u0060 归档子代理」，标题全是
 * \u0060Route this bounded MEMORY.md archive\u0060，被**实时宣告**那条路推到了手机上。
 *
 * DSH 自己的工作区浏览器对它们是一律隐藏的
 * （\u0060packages/client/ui-workspace/src/client/tree.ts\u0060 的 \u0060sessionVisible()\u0060：
 * \u0060if (session.origin === 'subagent') return false\u0060）。手机是**同一份会话清单的
 * 另一个视图** —— 判据不同源，两边就永远对不上，而且不对齐的方向是「手机多出一截」。
 *
 * ## 为什么两条路都要各钉一遍
 *
 * 会话到手机上只有两条路，它们**在不同的文件里各写了一份可见性判断**：
 *
 *  1. **按需分页**（手机点开工作区时）：\u0060src/index.ts\u0060 的 \u0060visibleOnPhone\u0060；
 *  2. **实时宣告**（会话正在活动时）：\u0060src/announce.ts\u0060 的 \u0060onCreated/onEvent\u0060。
 *
 * 修好一条而漏另一条，症状是「历史列表对了、正在跑的那条又冒出来」—— 比两条都错更难查。
 * 所以这里**分别**钉：任何一条丢了 \u0060origin\u0060 判据都要判红，哪怕另一条还在。
 *
 * 另外还钉「推迟宣告」：\u0060onCreated\u0060 不许发会话帧。DSH 的 blank 口径
 * （\u0060packages/api/session-controller/src/list.ts\u0060 的 \u0060applySessionListMetadata\u0060）
 * 是投影初值 \u0060blank: true\u0060、收到 \u0060turn/start\u0060 才变 false，所以在 created 那一刻
 * 「按 DSH 自己的定义」每个会话都还是 blank —— 在那里发帧等于把空壳会话也推上去。
 *
 * ## 假绿教训（本仓先例：check-title-shape / check-session-order / check-announce-accounting）
 *
 * ① 必须查**用在判定里的形式**，只查标识符出现会假绿（\u0060origin\u0060 这个词在注释里到处都是）；
 * ② 必须先剥注释；
 * ③ 段边界要用**函数签名**锚定，并在锚不到时判红，而不是静默跳过。
 *
 * 退出码：0 = 通过；1 = 有问题。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = (name) => readFileSync(resolve(here, '..', 'src', name), 'utf8')
// 先剥注释：下面对「代码里怎么取值」判定，注释里写对了不算数。
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const announce = stripComments(source('announce.ts'))
const index = stripComments(source('index.ts'))

const problems = []

// 段边界两端都锚不到就算「找不到」：静默取到文件尾会让段里混进**别的函数**的代码，
// 于是本段该有的缺陷被另一处的正确写法盖住 —— 这是静态门禁最典型的一种假绿。
const section = (text, from, to) => {
  const start = text.indexOf(from)
  if (start < 0) return undefined
  if (to === undefined) return text.slice(start)
  const end = text.indexOf(to, start + from.length)
  if (end < 0) return undefined
  return text.slice(start, end)
}

// ① 子代理的身份键必须一路带到 announcer。
if (!/origin\?:\s*'subagent'/.test(section(announce, 'export interface AnnounceSession', 'const EVENT_TYPE_BY_SESSION_EVENT'))) {
  problems.push("AnnounceSession 没有声明 origin（announcer 拿不到子代理身份，实时那条路无从过滤）")
}
const listeners = section(index, "ctx.on('session/created'", 'const announceTimer')
if (listeners === undefined) {
  problems.push("找不到 session 生命周期监听器（订阅点变了，判据要跟着改）")
} else {
  const passed = listeners.match(/origin:\s*session\.header\?\.origin/g)?.length ?? 0
  // 三条监听器（created / event / disposed）都要传：少一条就有一条路把子代理放过去。
  if (passed < 3) {
    problems.push(`只有 ${passed}/3 条 session 监听器把 origin 递给了 announcer（subagent 会从缺的那条漏上去）`)
  }
}

// ② 实时宣告那条路：创建与事件两处都要挡，且创建处不发帧。
const onCreated = section(announce, 'onCreated(session: AnnounceSession', 'private announceSession(')
if (onCreated === undefined) {
  problems.push('找不到 onCreated')
} else {
  if (!/session\.origin\s*===\s*'subagent'/.test(onCreated)) {
    problems.push("onCreated 没有挡子代理会话（origin === 'subagent'）")
  }
  if (/this\.sessionFrame\(/.test(onCreated)) {
    problems.push('onCreated 直接发了会话帧 —— 它在 DSH 的 blank 口径下永远是空壳，必须推迟到第一个映射事件')
  }
}
const onEvent = section(announce, 'onEvent(session: AnnounceSession', 'onDisposed(session: AnnounceSession)')
if (onEvent === undefined) {
  problems.push('找不到 onEvent')
} else if (!/session\.origin\s*===\s*'subagent'/.test(onEvent)) {
  problems.push("onEvent 没有挡子代理会话 —— 订阅是全局的，onCreated 的过滤拦不住这条路上的 track")
}
const onDisposed = section(announce, 'onDisposed(session: AnnounceSession', 'stop()')
if (onDisposed === undefined) {
  problems.push('找不到 onDisposed')
} else if (!/if\s*\(!track\.announced\)\s*return/.test(onDisposed)) {
  problems.push('onDisposed 会在从没宣告过的会话上发 done —— 手机凭空多出一条它从没见过的空壳')
}
// 推迟之后，第一帧必须有人补发。
const announcer = section(announce, 'private announceSession(', 'onEvent(session: AnnounceSession,')
if (announcer === undefined) {
  problems.push('找不到 announceSession（推迟宣告后第一帧的补发点没了）')
} else if (!/^\s{4}this\.sessionFrame\(/m.test(announcer)) {
  // 要求它是**语句级**的调用（顶格四空格），不是藏在 `if (…)` 里 —— 一个永远不成立的
  // 条件同样能让 \`this.sessionFrame(\` 出现在这段文本里，而那时第一帧根本发不出去。
  problems.push('announceSession 没有真正发帧 —— 推迟之后就没有任何一处发出第一帧了')
}

// ③ 分页那条路：可见性判据要还在，且与上面同一个口径。
const visible = section(index, 'function visibleOnPhone(', 'function samePath(')
if (visible === undefined) {
  problems.push('找不到 visibleOnPhone（分页那条路的可见性判据没了）')
} else if (!/candidate\.origin\s*===\s*'subagent'/.test(visible)) {
  problems.push("visibleOnPhone 没有挡子代理会话（origin === 'subagent'）")
}

if (problems.length === 0) {
  console.log('会话可见性门禁通过：子代理不推手机 + 两条路同口径 + 空壳会话推迟宣告。')
  process.exit(0)
}
console.error('会话可见性门禁失败（' + problems.length + ' 项）：')
for (const problem of problems) console.error('  · ' + problem)
process.exit(1)
