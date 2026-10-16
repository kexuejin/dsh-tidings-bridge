#!/usr/bin/env node
/**
 * 宣告记账门禁 —— 记账必须问**结果**，且状态快照必须会**重申**。
 *
 * ## 它钉的两条真机故障（都是 2026-10-14）
 *
 * ① **空受众不记账**：第一版无条件 `add(wsId)` 然后才遍历受众。桌面端还没启动时
 *    第一次宣告把 15 个 wsId 全标成「已宣告」而一个帧都没发 ⇒ 工作区永远推不过去。
 *
 * ② **状态快照要重申**：`agent-workspace` 不入队（对端离线即丢），所以「发过一次」
 *    不等于「对端现在有」。第一版只记 wsId 且永不失效 ⇒ 手机在宣告那一刻被停掉，
 *    那台设备就永远看不到清单（真机：桌面端台账 14 条、手机 0 条）。
 *
 * ## 判据
 *
 * `announceKnownWorkspaces` 必须：受众先算 → 空受众就 break → 有「刷新窗口」判定
 * （`ANNOUNCE_REFRESH_MS`）→ 记账发生在判定之后。
 *
 * ## 为什么是静态检查
 *
 * 本仓没有单元测试基建（见 package.json），而这两条都是**顺序/结构**问题：错了两者的
 * 行为就是错的。静态检查能精确覆盖，且不需要起进程。
 *
 * 退出码：0 = 通过；1 = 有问题。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '..', 'src', 'announce.ts')
const text = readFileSync(src, 'utf8')

const start = text.indexOf('announceKnownWorkspaces()')
if (start < 0) {
  console.error('announce 门禁失败：找不到 announceKnownWorkspaces 方法')
  process.exit(1)
}
const body = text.slice(start, text.indexOf('\n  }', start))

const problems = []

const audienceAt = body.indexOf('const audience = this.targets()')
const guardAt = body.indexOf('audience.length === 0')
// 关键不是「文件里有没有这个常量」，而是**它出现在判定里**（`>= ANNOUNCE_REFRESH_MS`）。
//（第一版我只查 indexOf，结果把窗口删掉后门禁仍报通过 —— 那是一条假绿。）
const refreshAt = body.indexOf('>= ANNOUNCE_REFRESH_MS')
const recordAt = body.indexOf('announcedWorkspaces.set(')

if (audienceAt < 0) problems.push('没有把受众先算出来（应写 const audience = this.targets()）')
if (guardAt < 0) problems.push('缺少「受众为空就不记账」的守卫（audience.length === 0）')
if (refreshAt < 0) problems.push('缺少刷新窗口判定（`>= ANNOUNCE_REFRESH_MS`）—— 状态快照不入队，发过一次不等于对端现在有')
if (recordAt < 0) problems.push('找不到 announcedWorkspaces.set( 的记账点')

if (audienceAt >= 0 && recordAt >= 0 && audienceAt > recordAt) problems.push('受众在记账之后才算 ⇒ 对空受众也会记成已宣告（这正是故障①）')
if (guardAt >= 0 && recordAt >= 0 && guardAt > recordAt) problems.push('守卫在记账之后 ⇒ 空受众仍会被记成已宣告')
if (refreshAt >= 0 && recordAt >= 0 && refreshAt > recordAt) problems.push('刷新判定在记账之后 ⇒ 记完才判要不要发（窗口永远生效不了）')

if (problems.length === 0) {
  console.log('宣告记账门禁通过：受众先算、空受众不记账、状态快照按窗口重申。')
  process.exit(0)
}

console.error('宣告记账门禁失败（' + problems.length + ' 项）：')
for (const p of problems) console.error('  · ' + p)
process.exit(1)