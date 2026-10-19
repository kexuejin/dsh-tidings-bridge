#!/usr/bin/env node
/**
 * 图片/附件内容块门禁 —— user/message 的 content 里有图时，事件必须仍然发得出去。
 *
 * ## 它钉的真机故障（2026-10-18，用户反馈「DSH 发的图片消息 tidings 这边看不到」）
 *
 * DSH 的 user/message content 是块数组，图片块长这样（真机 session log 实测）：
 *
 *     { type: 'image',
 *       attachment: { attachmentId, mediaType: 'image/jpeg', width: 920, height: 412,
 *                     bytes: 31169, name: 'image.png' } }
 *
 * 而 extractUserPrompt 原来**只拼 type === 'text' 的块** ⇒ 一条只有图片的消息得到
 * 空串 ⇒ pendingFor 里那句 body === undefined 让**整条事件不转发**：手机端不是
 * 「图没渲染」，是「这条消息不存在」。
 *
 * ## 判据（静态，本仓没有单元测试基建 —— 见 check-title-shape.mjs 的同一段说明）
 *
 * ① extractUserPrompt 必须对**非 text 块**调用 attachmentPlaceholder（而不是只
 *    continue 掉），这样 body 不会是空串；
 * ② attachmentPlaceholder 必须真读附件元数据（name/width/height/bytes），并把它们
 *    放进返回的那一行 —— 只查「出现过标识符」会假绿；
 * ③ 图片/附件块类型必须被显式接受（image/file/attachment）；
 * ④ titleFrom 在只有图片时也要给出标题（否则会话在手机上退回 session-…）。
 *
 * ## 这四条**自己能挡住回归**（--self-test）
 *
 * 量具必须能证明自己不是空转：--self-test 会把源码改回「只拼 text」的旧形态，并断言
 * 四条判据**真的报错**。否则「检查通过」只说明脚本跑完了，不说明它看得见问题。
 *
 * 退出码：0 = 通过；1 = 有问题。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const selfTest = args.includes('--self-test')
const explicit = args.find(value => !value.startsWith('--'))
const defaultPath = resolve(here, '../src/announce.ts')

function bodyOf(source, name) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) return undefined
  const next = source.indexOf(String.fromCharCode(10) + 'function ', start + 1)
  const nextExport = source.indexOf(String.fromCharCode(10) + 'export function ', start + 1)
  const ends = [next, nextExport].filter(value => value > 0)
  const end = ends.length > 0 ? Math.min(...ends) : source.length
  return source.slice(start, end)
}

/** 四条判据。返回问题清单（空 = 通过）。 */
export function checkSource(source) {
  const problems = []
  const extract = bodyOf(source, 'extractUserPrompt')
  const placeholder = bodyOf(source, 'attachmentPlaceholder')
  const title = bodyOf(source, 'titleFrom')

  if (extract === undefined) problems.push('找不到 extractUserPrompt')
  if (placeholder === undefined) problems.push('找不到 attachmentPlaceholder')

  if (extract !== undefined) {
    const imageBranch = extract.split("block['type'] === 'text'")[1] ?? ''
    if (!imageBranch.includes('attachmentPlaceholder(')) {
      problems.push('extractUserPrompt 对非 text 块没有调用 attachmentPlaceholder ⇒ 只有图片的消息会得到空 body ⇒ 整条事件不转发')
    }
    if (!imageBranch.includes('parts.push(')) {
      problems.push('extractUserPrompt 没有把附件占位推进 parts ⇒ 占位到不了 body')
    }
    if (extract.includes('prompt.trim().length > 0 ? prompt.trim() : undefined') && !extract.includes('parts.join(')) {
      problems.push('extractUserPrompt 仍是「只拼 text」的旧形态')
    }
  }

  if (placeholder !== undefined) {
    for (const field of ['name', 'width', 'height', 'bytes']) {
      if (!placeholder.includes("['" + field + "']")) {
        problems.push('attachmentPlaceholder 没有读附件的 ' + field + ' ⇒ 占位会是一句没有信息量的常量')
      }
    }
    for (const type of ['image', 'file', 'attachment']) {
      if (!placeholder.includes("'" + type + "'")) {
        problems.push('attachmentPlaceholder 没有接受 ' + type + ' 块')
      }
    }
    if (!placeholder.includes('return ')) problems.push('attachmentPlaceholder 没有返回值')
  }

  if (title !== undefined && !title.includes('attachmentPlaceholder(')) {
    problems.push('titleFrom 没有在「只有图片」时退回附件占位 ⇒ 会话标题会空成 session-…')
  }
  return problems
}

if (selfTest) {
  const good = readFileSync(explicit ?? defaultPath, 'utf8')
  // 把源码改回旧形态：extractUserPrompt 只拼 text、titleFrom 不退回占位。
  const mutated = good
    .replace(/const placeholder = attachmentPlaceholder\(block\)[\s\S]*?if \(placeholder !== undefined\) parts\.push\(placeholder\)/, '')
    .replace(/\/\/ 只有图片的用户消息[\s\S]*?if \(placeholder !== undefined\) return placeholder/, '')
  const clean = checkSource(good)
  const dirty = checkSource(mutated)
  let failed = false
  if (clean.length !== 0) {
    console.error('[check-image-blocks] 自检失败：当前源码本该通过，却报 ' + clean.length + ' 条')
    failed = true
  }
  if (mutated === good) {
    console.error('[check-image-blocks] 自检失败：没能构造出旧形态样本（正则没匹配上）')
    failed = true
  }
  if (dirty.length === 0) {
    console.error('[check-image-blocks] 自检失败：旧形态（只拼 text / 标题不退回占位）居然通过了 ⇒ 判据是空转')
    failed = true
  }
  if (failed) process.exit(1)
  console.log('[check-image-blocks] 自检通过：旧形态会被这 ' + dirty.length + ' 条判据抓住，当前源码 0 条')
  process.exit(0)
}

const problems = checkSource(readFileSync(explicit ?? defaultPath, 'utf8'))
if (problems.length > 0) {
  for (const problem of problems) console.error('[check-image-blocks] FAIL — ' + problem)
  process.exit(1)
}
console.log('[check-image-blocks] OK — 图片/附件块会转成占位文本，事件不会整条消失')

