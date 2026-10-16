#!/usr/bin/env node
/**
 * 会话标题读取门禁 —— 消费 `readTitleSnapshots()` 必须按**真实返回形状**取值。
 *
 * ## 它钉的真机故障（2026-10-15，用户反馈「工作区的会话怎么都是 session id」）
 *
 * `ctx.get('sessionQuery').readTitleSnapshots(ids)` 的返回**不是** `{ session, title }`
 * 的数组，而是**可辨识联合**（`packages/session-query/session-query/src/types.ts` 的
 * `SessionTitleObservationResult`）：
 *
 *     | { sessionId; status: 'fulfilled'; value: { session; title?: SessionTitleSnapshot } }
 *     | { sessionId; status: 'rejected';  reason: unknown }
 *
 * 且标题本身还嵌一层：`value.title` 是对象（`SessionTitleSnapshot`），字符串在
 * `value.title.title`。官方消费姿势见
 * `packages/session-query/tool-session-query/src/workspace-access.ts`：
 * `observation.value.title?.title ?? 'untitled'`。
 *
 * 第一版按 `snapshot.title`（当它是字符串）与 `snapshot.session.id` 读，两个取值
 * **都是 undefined**，而守卫 `typeof x === 'string'` 只是**安静地不成立** ——
 * 没有异常、没有日志，标题 map 永远为空，手机端每个会话都退回显示 `session-…`。
 *
 * ## 判据
 *
 * provider 里读标题那段必须同时满足：
 * ① 分流 `status`（跳过非 `'fulfilled'` 的结果，而不是假设每条都成功）；
 * ② 标题字符串从 `value.title` 再取一层 `.title`；
 * ③ 用它自己的 `sessionId` 建索引（`observation.sessionId`），不依赖返回顺序。
 *
 * ## 为什么是静态检查
 *
 * 本仓没有单元测试基建（见 package.json），而这是一条**取值路径**问题：形状错了行为
 * 就是错的，且错得完全无声。静态检查能精确覆盖，不需要起 DSH 进程。
 *
 * ## 假绿教训（本仓已有先例，见 check-announce-accounting.mjs）
 *
 * 只查「文件里出现过某个标识符」会假绿 —— 必须查**用在取值里的形式**。
 *
 * 退出码：0 = 通过；1 = 有问题。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '..', 'src', 'index.ts')
const text = readFileSync(src, 'utf8')

const problems = []

// 注释里也会出现 `.value.title` 这类写法（上一版就因此放过了一次变异），所以先剥注释
// 再判 —— 否则「文档里写对了」会被当成「代码写对了」。
// 只做够用的一层剥离：`/* … */` 与行注释；`//` 前面是 `:` 时不当注释
// （`https://`、`file://` 会出现在 provider 的 KDoc 里）。
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')


// 定位 provider 里读标题那一段（从 readTitleSnapshots 调用到建 entries 为止）。
const callAt = text.indexOf('await query.readTitleSnapshots(')
if (callAt < 0) {
  console.error('会话标题门禁失败：找不到 query.readTitleSnapshots( 的调用')
  process.exit(1)
}
const consume = stripComments(text.slice(callAt, text.indexOf('const entries = page.map(', callAt)))
if (consume.length === 0) {
  console.error('会话标题门禁失败：定位不到标题消费段')
  process.exit(1)
}

// ① 必须分流 status —— 官方契约把「操作失败」隔离在每条结果里，不是整批 reject。
if (!/status\s*!==\s*'fulfilled'/.test(consume) && !/status\s*===\s*'fulfilled'/.test(consume)) {
  problems.push(
    "没有按 status 分流（返回是可辨识联合：'fulfilled' | 'rejected'）—— " +
    '直接假设每条都成功会让失败的会话被当成「没有标题」',
  )
}

// ② 标题字符串必须从 value.title.title 取 —— 少一层就是恒为 undefined 的守卫。
// 反向检查更可靠：出现「一层就取字符串」的写法即判红。
if (/\.value\.title\s*(?:\?\?|\)|;|\|\||&&|===)/.test(consume)) {
  problems.push('把 value.title 当字符串用了 —— 它是 SessionTitleSnapshot 对象，字符串在 value.title.title')
}
if (!/\.value\.title\s*\?\.\s*title/.test(consume)) {
  problems.push('缺少 value.title?.title 的取值（官方姿势：observation.value.title?.title）')
}

// ③ 索引要用 observation 自己的 sessionId，不依赖返回顺序。
if (!/\.sessionId\b/.test(consume)) {
  problems.push('没有用 observation.sessionId 建索引（不能依赖返回顺序匹配）')
}

// 反向检查：第一版的错误形状必须彻底消失。
if (/\.session\.id/.test(consume)) {
  problems.push("仍在读 snapshot.session.id —— 真实字段是 value.session.id（且建索引用 observation.sessionId）")
}

// ④ 这个计数必须存在并进诊断：读标题有两个能安静失败的取值，没有计数就分不清
//    「形状错了」与「这批会话本来没标题」（两者处置完全不同）。
if (!/titlesRead\s*=\s*titles\.size/.test(text)) {
  problems.push('缺少 titlesRead 计数（读标题能安静失败，必须可观测）')
}
if (!/titlesRead\s*[:,]/.test(text.slice(text.indexOf("name: 'tidings_announce_status'")))) {
  problems.push('titlesRead 没有进 tidings_announce_status 的输出')
}

if (problems.length === 0) {
  console.log('会话标题门禁通过：status 分流、value.title.title 取值、observation.sessionId 建索引、titlesRead 可观测。')
  process.exit(0)
}

console.error('会话标题门禁失败（' + problems.length + ' 项）：')
for (const p of problems) console.error('  · ' + p)
process.exit(1)
