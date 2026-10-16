#!/usr/bin/env node
/**
 * 会话活动时刻门禁（实时路径）—— 手机排会话用的那个时刻必须**真的来自用户的动作**。
 *
 * ## 它钉的两条规则
 *
 * 1. 活动时刻只认**人自己发的话**：`event.type === 'user/message' && event.data.source.kind === 'user'`，
 *    与 DSH 自己的 `lastPromptAt` 判据（packages/api/session-controller/src/list.ts 的
 *    `applySessionListMetadata`）逐字一致。漏掉 `source.kind` 那一半的后果是**安静而持续**的：
 *    `user/message` 同时承载 `agent.inject()` 的合成内容（文件变更提示、AGENTS.md、skill 正文、
 *    cron 通知、goal 续跑轮次），于是没人碰过的会话会一直往上浮 —— 这正是用户报的「不是最新的」
 *    换了个原因再犯一次。
 *
 * 2. `updatedAt` 与 `startedAt` 必须各司其职：`startedAt` 的语义是「会话开始时间」，手机用它说
 *    「开始于 …」；拿它当排序键会让那句文案说假话。所以禁止 `updatedAt: extra.startedAt` 这类挪用。
 *
 * ## 为什么还要钉「整条链路都在传」
 *
 * 这个键从 announce.ts 出发，要穿过 tidings.ts 的请求体装配、agentNode 的控制面、core 的线协议，
 * 任何一层漏掉都是**静默丢键**（`requestBody` 是逐键拼的，没有形状约束），手机侧只能退回到达顺序。
 * 静态检查是这里唯一能一次覆盖四层的量具。
 *
 * ## 假绿教训（本仓先例：check-title-shape.mjs / check-session-order.mjs / check-announce-accounting.mjs）
 *
 * ① 必须查**用在取值里的形式**，只查标识符出现会假绿；
 * ② 必须先剥注释 —— 注释里写对了、代码写错，是最容易骗过静态检查的一种。
 *
 * 退出码：0 = 通过；1 = 有问题。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = (name) => readFileSync(resolve(here, '..', 'src', name), 'utf8')
// 先剥注释：判据全是「代码里怎么取值」，注释里出现同样的写法不算数。
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const announce = stripComments(source('announce.ts'))
const tidings = stripComments(source('tidings.ts'))
const model = stripComments(source('model.ts'))
const responder = stripComments(source('session-page-responder.ts'))

const problems = []

const section = (text, from, to) => {
  const start = text.indexOf(from)
  if (start < 0) return undefined
  const end = to === undefined ? text.length : text.indexOf(to, start + from.length)
  return text.slice(start, end < 0 ? text.length : end)
}

// ① 人的话才更新活动时刻。
const onEvent = section(announce, 'onEvent(session: AnnounceSession', 'onDisposed(session: AnnounceSession)')
if (onEvent === undefined) {
  problems.push('找不到 onEvent —— 实时路径的入口变了，判据要跟着改')
} else {
  if (!/isUserAuthored\(event\.data\)/.test(onEvent)) {
    problems.push('onEvent 没有用 isUserAuthored 守卫 —— 合成内容会被算成人的活动')
  }
  if (!/track\.updatedAt\s*=/.test(onEvent)) {
    problems.push('onEvent 没有写入 track.updatedAt —— 实时帧的活动时刻永远是空的')
  }
  if (/updatedAt:\s*extra\.startedAt/.test(onEvent)) {
    problems.push('updatedAt 被挪用了 startedAt —— 「开始于 …」那句文案会说假话')
  }
}
const guard = section(announce, 'function isUserAuthored(', 'function titleFrom(')
if (guard === undefined) {
  problems.push('找不到 isUserAuthored（活动时刻的判据必须是具名的一处，不许内联重复）')
} else {
  if (!/source\['kind'\]\s*===\s*'user'/.test(guard) && !/source\.kind\s*===\s*'user'/.test(guard)) {
    problems.push("isUserAuthored 没有判 source.kind === 'user'（与 DSH 的 lastPromptAt 判据不一致）")
  }
}

// ② 创建时刻是活动时刻的起点，不许拿 Date.now() 硬顶（那是假的，只是恰好接近）。
//
// 判据写成「先记下 session.createdAt，再让它起算 updatedAt」两步，而不是原来的一行
// `track.updatedAt = session.createdAt` —— 会话帧推迟到第一个映射事件之后，`onCreated`
// 必须把创建时刻**留在 track 上**（第一帧要用它当 startedAt），所以是两步。
// 只查第一步会漏掉「记下了但没起算」，只查第二步会漏掉「起算了但没用 created」。
const onCreated = section(announce, 'onCreated(session: AnnounceSession', 'private announceSession(')
if (onCreated === undefined) {
  problems.push('找不到 onCreated')
} else {
  if (!/track\.createdAt\s*=\s*session\.createdAt/.test(onCreated)) {
    problems.push('onCreated 没有记下 session.createdAt（新建会话少一段真实历史，第一帧也说不出「开始于」）')
  }
  if (!/track\.updatedAt\s*=\s*track\.createdAt/.test(onCreated)) {
    problems.push('onCreated 没有让创建时刻起算活动时刻（一个刚建好还没人说话的会话排不准）')
  }
}
if (/updatedAt:\s*Date\.now\(/.test(announce)) {
  problems.push('announce.ts 里出现 updatedAt: Date.now() —— 把活动时刻硬编成「现在」')
}

// ③ 发帧时必须带上这个键（带了 null 不上线，漏了就静默丢）。
const frame = section(announce, 'private sessionFrame(', 'private targets(')
if (frame === undefined) {
  problems.push('找不到 sessionFrame')
} else if (!/^\s*updatedAt,$/m.test(frame)) {
  problems.push('sessionFrame 的 base 没有带 updatedAt —— 实时帧一个都不带排序键')
}

// ④ 四层透传，缺一层就是静默丢键。
if (!/readonly updatedAt\?: number/.test(model)) {
  problems.push('TidingsAgentSessionArgs 没有声明 updatedAt（tidings.ts 的逐键装配拿不到它）')
}
if (!/args\.updatedAt !== undefined/.test(tidings) || !/requestBody\.updatedAt\s*=\s*args\.updatedAt/.test(tidings)) {
  problems.push('tidings.ts 没有把 args.updatedAt 装进 requestBody（逐键装配是静默的）')
}
if (!/updatedAt:\s*entry\.updatedAt/.test(responder)) {
  problems.push('session-page-responder 没有透传 entry.updatedAt（分页那一页会退回到达顺序）')
}

if (problems.length === 0) {
  console.log('会话活动时刻门禁通过：人的话才计时 + 创建时刻起算 + 发帧带上 + 四层透传。')
  process.exit(0)
}
console.error('会话活动时刻门禁失败（' + problems.length + ' 项）：')
for (const problem of problems) console.error('  · ' + problem)
process.exit(1)