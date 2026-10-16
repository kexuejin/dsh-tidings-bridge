#!/usr/bin/env node
/**
 * `inject` 门禁 —— 硬依赖写错会让**整个插件静默不加载**。
 *
 * ## 它钉的 2026-10-14 真实故障
 *
 * 我把 `workspaceRegistry` / `sessionController` 写进 `inject`，它们由
 * `@deepseek-ai/dsh-workspace` / `dsh-session-controller` 提供，而本机 web profile 的
 * node_modules 里**没有**这两个包 ⇒ cordis 拒绝加载整个插件，**日志里连一行都没有**。
 *
 * 症状是最难查的那一类：工具不见了、面板空了、节点台账永远为空，而没有任何报错可看 ——
 * 宿主进程甚至没有到 8788 的连接（我用 `lsof` 才看出来）。
 *
 * ## 判据
 *
 * `inject` 里的每个名字都必须是宿主**一定**提供的基线服务（`tools` / `connection`）；
 * 其余一律走 `ctx.get(...)` 的运行时可选读取。
 *
 * 退出码：0 = 通过；1 = 有问题。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '..', 'src', 'index.ts')
const text = readFileSync(src, 'utf8')

// 宿主一定提供的基线服务（与官方插件一致）。
const BASELINE = new Set(['tools', 'connection'])

const m = text.match(/export const inject = \[([^\]]*)\]/)
if (m === null) {
  console.error('inject 门禁失败：找不到 export const inject 声明')
  process.exit(1)
}
const names = m[1].split(',').map(s => s.trim().replace(/['\"]/g, '')).filter(s => s.length > 0)
const problems = names.filter(n => !BASELINE.has(n)).map(n =>
  'inject 声明了 ' + n + ' —— 若宿主没提供它，cordis 会拒绝加载整个插件且不报错；请改用 ctx.get() 运行时可选读取')

if (problems.length === 0) {
  console.log('inject 门禁通过：只声明基线服务（' + names.join(', ') + '），其余走 ctx.get 可选读取。')
  process.exit(0)
}

console.error('inject 门禁失败（' + problems.length + ' 项）：')
for (const p of problems) console.error('  · ' + p)
process.exit(1)