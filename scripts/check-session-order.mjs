#!/usr/bin/env node
/**
 * 会话顺序门禁 —— 手机工作区的会话顺序必须来自 DSH **自己的活动序**。
 *
 * ## 它钉的真机故障（用户反馈「看起来跟 dsh 上显示的不一样,不是最新的」）
 *
 * 第一版 provider 用 `sessionQuery.listSessions()` 取会话，那是 **createdAt 倒序**
 * （packages/session-query/session-query/src/corpus.ts 的 compareSessions），不是 DSH UI 的
 * 活动倒序（packages/api/session-controller/src/list.ts 先取同一个源，再
 * `items.sort((left, right) => right.updatedAt - left.updatedAt)`）。于是手机上看到的
 * 是「最近创建的」而不是「最近动过的」。
 *
 * 同时它把 `updatedAt` 写死成 0（`SessionPageEntry.updatedAt` 早就声明了），
 * 于是手机端只能拿「收到这一帧的时刻」排 —— 而分页是一整页同一毫秒到达的，
 * 那个排序键必然退化成到达顺序。**两个缺陷各自都能独立造成同一个症状**，
 * 所以门禁必须两条都钉。
 *
 * ## 为什么是静态检查
 *
 * 本仓没有单元测试基建（见 package.json 的 check 脚本组），而这两条都是**取值路径**
 * 问题：源错了/字段丢了行为就是错的，且错得完全无声（外层 catch 把一切都吞掉）。
 * 静态检查能精确覆盖，不需要起 DSH 进程。
 *
 * ## 假绿教训（本仓已有先例，见 check-announce-accounting.mjs 与 check-title-shape.mjs）
 *
 * 只查「文件里出现过某个标识符」会假绿 —— 必须查**用在取值里的形式**，
 * 并且先剥注释（注释里写对了代码写错，是最容易骗过静态检查的一种）。
 *
 * 退出码：0 = 通过；1 = 有问题。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '..', 'src', 'index.ts')
const raw = readFileSync(src, 'utf8')
// 先剥注释：本门禁的判据全是「代码里怎么取值」，注释里出现同样的写法不算数。
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const text = stripComments(raw)

const problems = []

const section = (from, to) => {
  const start = text.indexOf(from)
  if (start < 0) return undefined
  // 从 start + from.length 之后找终点：否则终点标记若是起点本身的前缀，段会是空的。
  const end = to === undefined ? text.length : text.indexOf(to, start + from.length)
  return text.slice(start, end < 0 ? text.length : end)
}

// ① 权威源必须存在且被真的调用。
const controllerRead = section(
  'async function readFromSessionController(',
  'async function readFromSessionQuery(',
)
if (controllerRead === undefined) {
  problems.push('找不到 readFromSessionController（权威源 = DSH 自己的会话列表）')
} else {
  if (!/\.list\s*\(/.test(controllerRead)) {
    problems.push('readFromSessionController 没有调用 controller.list()')
  }
  if (!/updatedAt:\s*item\.updatedAt/.test(controllerRead)) {
    problems.push('权威源的 updatedAt 没有取自 SessionSummary.updatedAt（它是唯一的活动序依据）')
  }
}
if (!/ctx\.get\('sessionController'\)/.test(text)) {
  problems.push("没有取 ctx.get('sessionController') —— 权威源没接上")
}

// ② 兜底源只许用 header.createdAt 当排序键。
//    用 Date.now() 顶替是最坏的写法：顺序看起来对，实际每个会话的活动时刻都是假的。
const queryRead = section(
  'async function readFromSessionQuery(',
  'function visibleOnPhone(',
)
if (queryRead === undefined) {
  problems.push('找不到 readFromSessionQuery（兜底源）')
} else {
  if (!/updatedAt:\s*record\.header\.createdAt/.test(queryRead)) {
    problems.push('兜底源的 updatedAt 必须退回 header.createdAt')
  }
  if (/updatedAt:\s*Date\.now\(/.test(queryRead)) {
    problems.push('兜底源拿 Date.now() 当活动时刻 —— 那是假的，顺序会看起来对而实际荒谬')
  }
}

// ③ 过滤必须走 visibleOnPhone，且两条规则都要在。
if (!/filter\(record => visibleOnPhone\(record, sameWorkspace\)\)/.test(text)) {
  problems.push('没有用 visibleOnPhone 过滤会话（子代理与 blank 会话会漏到手机上）')
}
const visible = section('function visibleOnPhone(', 'function ')
if (visible === undefined) {
  problems.push('找不到 visibleOnPhone')
} else {
  if (!/candidate\.origin === 'subagent'/.test(visible)) {
    problems.push("visibleOnPhone 缺少 origin === 'subagent' 的隐藏规则（与 DSH 工作区浏览器对齐）")
  }
  if (!/candidate\.blank/.test(visible)) {
    problems.push('visibleOnPhone 缺少 blank 会话规则')
  }
}

// ④ 条目里不许再写死 0，必须透传活动时刻。
if (!/updatedAt:\s*record\.updatedAt/.test(text)) {
  problems.push('entries 没有透传 record.updatedAt（写死 0 = 手机只能按到达顺序排）')
}
if (/updatedAt:\s*0\b/.test(text)) {
  problems.push('仍然有 updatedAt: 0 的写死值')
}

// ⑤ 这四件事必须可观测：用的哪个源、权威源为什么没成、两个源都没成的原因。
//    没有它们，「顺序不对」与「服务根本没装配」在手机上长得一模一样。
//
//    判据只能扫**这个工具自己的返回对象**：从 asJson({ 到它闭合为止。
//    第一版扫「工具名之后整段文件」，于是 provider 里的赋值也算命中 ——
//    把返回体里的字段删掉，门禁照样绿（变异实测）。
const toolAt = text.indexOf("name: 'tidings_announce_status'")
const jsonAt = toolAt < 0 ? -1 : text.indexOf('return asJson({', toolAt)
const jsonEnd = jsonAt < 0 ? -1 : text.indexOf('\n      })', jsonAt)
const toolBody = jsonAt < 0 || jsonEnd < 0 ? '' : text.slice(jsonAt, jsonEnd)
if (toolBody.length === 0) {
  problems.push('定位不到 tidings_announce_status 的返回对象')
} else {
  for (const field of ['sessionControllerAvailable', 'sessionSource', 'controllerFallback', 'lastReadFailure']) {
    if (!new RegExp('\\b' + field + '\\b').test(toolBody)) {
      problems.push(field + ' 没有进 tidings_announce_status 的输出（顺序链路必须可观测）')
    }
  }
}
if (problems.length === 0) {
  console.log('会话顺序门禁通过：活动序权威源 + createdAt 兜底 + subagent/blank 过滤 + updatedAt 透传 + 可观测。')
  process.exit(0)
}
console.error('会话顺序门禁失败（' + problems.length + ' 项）：')
for (const p of problems) console.error('  · ' + p)
process.exit(1)
