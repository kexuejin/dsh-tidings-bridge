#!/usr/bin/env node
/**
 * CSS 一致性门禁 —— 类名拼错必须当场判红。
 *
 * ## 为什么需要它
 *
 * 2026-10-14 的教训：去掉旧面板后新写的设置卡片引用了 17 个类名，**一个都不存在于
 * 样式表里**，而 typecheck 与 build 全绿 —— 因为 `*.module.css` 的声明当时是宽松的
 * `Record<string, string>`，任何键都过得去。结果是一张完全没样式的卡片（用户当场
 * 反馈「样式很丑」），而所有自动化门禁都报平安。
 *
 * 判据：引用的每个类名都要在样式表里真实存在；反过来，样式表里的每个类名也都该
 * 被用到（死样式同样是负债）。
 *
 * ## 两条实现细节（第一版正是被它们误判）
 *
 * · CSS **注释先剥掉**再取类名 —— 否则 .module.css / .tsx 这类文件名会被当成类名；
 * · 组合类要单独识别 —— .is-ok 从不出现在 css. 里，它只在 className 的字面量里。
 *
 * 退出码：0 = 通过；1 = 有问题。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientDir = resolve(here, '..', 'src', 'client')

/** 剥掉 CSS 注释：注释里的文件名不是类名。 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ')

/** 从 CSS 里取类名（注释已剥掉）。 */
function definedClasses(css) {
  const out = new Set()
  for (const m of stripComments(css).matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) out.add(m[1])
  return out
}

/** 从 TSX 取类名引用：css.foo，以及 className 表达式里的字符串字面量（组合类）。 */
function usedClasses(tsx) {
  const out = new Set()
  // 只认属性访问，不认比较：`css.state === 'online'` 里的 state 不是类名引用
  // （第一版把这类比较也算了进去，实测误报 css.online / css.loading）。
  for (const m of tsx.matchAll(/\bcss\.([a-zA-Z][a-zA-Z0-9_]*)/g)) { if (!/^\s*[=!]=/.test(tsx.slice(m.index + m[0].length))) out.add(m[1]) }
  // 组合类：只取**真正进 className 的**字面量，即三元的值位置（`? 'foo'` / `: 'foo'`）——
  // 比较操作数（`=== 'online'`）不是类名。第一版把比较值也算进去，误报 'online'/'loading'。
  for (const m of tsx.matchAll(/className=\{([^}]*)\}/g)) {
    for (const lit of m[1].matchAll(/[?:]\s*['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]/g)) out.add(lit[1])
  }
  return out
}

const problems = []
let checked = 0

for (const entry of readdirSync(clientDir)) {
  if (!entry.endsWith('.module.css')) continue
  const base = entry.slice(0, -'.module.css'.length)
  const cssPath = join(clientDir, entry)
  const tsxPath = join(clientDir, base + '.tsx')
  const css = readFileSync(cssPath, 'utf8')

  let tsx
  try {
    tsx = readFileSync(tsxPath, 'utf8')
  } catch {
    problems.push(entry + ': 找不到同名组件 ' + base + '.tsx（样式表没有主）')
    continue
  }
  checked += 1

  const defined = definedClasses(css)
  const used = usedClasses(tsx)

  for (const name of used) {
    if (!defined.has(name)) {
      problems.push(base + '.tsx: 引用了 css.' + name + '，但 ' + entry + ' 里没有 —— 会渲染成空 class（没有样式）')
    }
  }
  for (const name of defined) {
    if (!used.has(name)) problems.push(entry + ': .' + name + ' 定义了但没人用（死样式）')
  }

  const body = stripComments(css)

  // 负 margin：容器已经用 gap 管间距，子元素再减就是**重叠**。
  // 这一条来自真机缺陷（2026-10-14「高级设置里样式重叠」）：`.rowHint` 带着
  // `margin: -8px 0 0`（为另一个上下文写的），而折叠区里的 `.field` 自带 margin-top，
  // 两者叠加把说明文字拉进了输入框。负 margin 在「容器管间距」的体系里没有合法用途。
  for (const m of body.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)[^{]*\{[^}]*margin:\s*-(\d)/g)) {
    problems.push(entry + ': .' + m[1] + ' 使用了负 margin —— 容器已用 gap 管间距，再减会重叠')
  }
  for (const m of body.matchAll(/var\([^)]*,[^)]*\)/g)) {
    problems.push(entry + ': var() 回落值（' + m[0] + '）—— 不存在的 token 必须当场炸，不能有兜底颜色')
  }
  for (const m of body.matchAll(/(#[0-9a-fA-F]{3,8}\b|\brgba?\()/g)) {
    problems.push(entry + ': 颜色字面量 ' + m[0] + ' —— 颜色必须走 --dsw-* 主题变量，否则深色主题下读不清')
  }
}

if (problems.length === 0) {
  console.log('client CSS 门禁通过：' + checked + ' 份样式表，类名双向一致、无回落值、无颜色字面量。')
  process.exit(0)
}

console.error('client CSS 门禁失败（' + problems.length + ' 项）：')
for (const p of problems) console.error('  · ' + p)
process.exit(1)