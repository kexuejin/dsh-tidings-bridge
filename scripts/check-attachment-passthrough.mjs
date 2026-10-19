#!/usr/bin/env node
/**
 * 结构化附件直通门禁 —— agent-event 的 attachment 元数据必须「带着走」，且占位文本不许丢。
 *
 * ## 背景（task-45 第一步：core/protocol 加了可选 attachment，cap att1）
 *
 * 协议帧的 attachment 只带**元数据**（attachmentId/mediaType/width/height/bytes/name），
 * 字节仍走既有文件传输路径；键是**严格白名单**（多一个键整帧拒）。
 * 本仓（dsh-tidings）的职责是把 DSH 会话事件里的 content 块如实转译过去：
 *
 *   DSH:  { type: 'image', attachment: { attachmentId, mediaType, width, height, bytes, name } }
 *   tidings: POST /v1/agent/event { ..., attachment: { ...同上六个键... } }
 *
 * ## 三条不变量（判据）
 *
 * ① **占位文本不许丢**：body 里始终保留「图片: name (WxH, N KB)」那行 —— 它是回退，
 *    对端没声明 att1（或宿主还没把 attachment 接上线上）时手机就靠它看得见这条消息；
 * ② **只放白名单里的六个键**：不许把 DSH 的原始 attachment 对象整体展开（多一个键
 *    整帧拒 ⇒ 整条事件消失，比少一张卡片更糟）；
 * ③ **越界先自检**：id 128 / mediaType 64 / name 128 / 宽高 32768 / bytes 512 MiB，
 *    任一越界就丢掉 attachment（只发占位），而不是发一帧会被整帧拒的载荷。
 *
 * ## --self-test：量具必须能证明自己不是空转
 *
 * 把源码改成「不发 attachment」与「整体展开原始对象」两种坏形态，断言判据真的报错。
 *
 * 退出码：0 = 通过；1 = 有问题。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const args = process.argv.slice(2)
const selfTest = args.includes('--self-test')

function bodyOf(source, name) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) return undefined
  const next = source.indexOf(String.fromCharCode(10) + 'function ', start + 1)
  return source.slice(start, next > 0 ? next : source.length)
}

/** 判据。返回问题清单（空 = 通过）。 */
export function checkSources(sources) {
  const problems = []
  const announce = sources.announce
  const tidings = sources.tidings
  const model = sources.model

  const extract = bodyOf(announce, 'extractAttachment')
  if (extract === undefined) {
    problems.push('announce.ts 里没有 extractAttachment（附件元数据没被抽取）')
  } else {
    for (const field of ['attachmentId', 'mediaType', 'width', 'height', 'bytes', 'name']) {
      if (!extract.includes("['" + field + "']")) {
        problems.push('extractAttachment 没有读 DSH content 块的 ' + field + ' ⇒ 附件元数据不完整')
      }
    }
    // ② 不许整体展开原始对象（白名单只有六个键）。
    if (extract.includes('...raw') || extract.includes('...attachment,') || extract.includes('...block[')) {
      problems.push('extractAttachment 把原始 attachment 对象整体展开了 ⇒ 多一个键整帧拒')
    }
    // ③ 上限与越界处置：上限值声明在 ATTACHMENT_LIMITS（一处），extractAttachment 用它判。
    const limitsStart = announce.indexOf('const ATTACHMENT_LIMITS = {')
    const limitsBlock = limitsStart < 0 ? '' : announce.slice(limitsStart, announce.indexOf('}', limitsStart))
    if (limitsStart < 0) problems.push('没有 ATTACHMENT_LIMITS（协议上限没有单一出处）')
    for (const limit of ['128', '64', '32768', '512 * 1024 * 1024']) {
      if (!limitsBlock.includes(limit)) problems.push('ATTACHMENT_LIMITS 缺少协议上限 ' + limit)
    }
    if (!extract.includes('ATTACHMENT_LIMITS.')) {
      problems.push('extractAttachment 没有用 ATTACHMENT_LIMITS 做越界自检')
    }
    const guards = extract.split('return undefined').length - 1
    if (guards < 4) problems.push('extractAttachment 的越界自检不足（只有 ' + guards + ' 处 return undefined）')
  }

  // ① 占位文本必须仍然进 body；且 attachment 必须从 content 块抽出来。
  const pendingFor = bodyOf(announce, 'pendingFor') ?? announce.slice(announce.indexOf('pendingFor('))
  if (!pendingFor.includes('extractUserPrompt(data)')) {
    problems.push('pendingFor 不再调用 extractUserPrompt ⇒ 占位回退丢了（没声明 att1 的对端会什么都看不到）')
  }
  if (!pendingFor.includes('extractAttachment(data)')) {
    problems.push('pendingFor 没有调用 extractAttachment ⇒ 附件永远发不出去')
  }
  if (!pendingFor.includes('attachment === undefined ? {} : { attachment }')) {
    problems.push('pendingFor 没有把 attachment 放进待发事件')
  }
  const flushStart = announce.indexOf('private flush(')
  const flush = flushStart < 0 ? '' : announce.slice(flushStart, flushStart + 2000)
  if (!flush.includes('attachment: event.attachment')) {
    problems.push('flush 没有把 attachment 传给 agentEvent ⇒ 元数据到不了控制面')
  }

  // ② 请求体只放六个键、按协议顺序。
  if (!tidings.includes('requestBody.attachment = {')) {
    problems.push('tidings.ts 没有把 attachment 放进 POST /v1/agent/event 的请求体')
  } else {
    const at = tidings.indexOf('requestBody.attachment = {')
    const block = tidings.slice(at, at + 400)
    const order = ['attachmentId', 'mediaType', 'width', 'height', 'bytes', 'name']
    let cursor = -1
    for (const key of order) {
      const found = block.indexOf(key + ':', cursor + 1)
      if (found < 0) {
        problems.push('请求体里的 attachment 缺少 ' + key + '（或顺序与协议不一致）')
        break
      }
      cursor = found
    }
  }

  // 类型：model.ts 的 TidingsAgentAttachment 必须恰好是那六个字段。
  const typeStart = model.indexOf('export interface TidingsAgentAttachment {')
  if (typeStart < 0) {
    problems.push('model.ts 没有 TidingsAgentAttachment 类型')
  } else {
    const typeBody = model.slice(typeStart, model.indexOf('}', typeStart))
    for (const field of ['attachmentId', 'mediaType', 'width', 'height', 'bytes', 'name']) {
      if (!typeBody.includes(field)) problems.push('TidingsAgentAttachment 缺少字段 ' + field)
    }
    const fieldCount = (typeBody.match(/readonly /g) ?? []).length
    if (fieldCount !== 6) problems.push('TidingsAgentAttachment 字段数不是 6（实得 ' + fieldCount + '）⇒ 白名单可能被放宽')
  }
  return problems
}

function readSources() {
  return {
    announce: readFileSync(resolve(root, 'src/announce.ts'), 'utf8'),
    tidings: readFileSync(resolve(root, 'src/tidings.ts'), 'utf8'),
    model: readFileSync(resolve(root, 'src/model.ts'), 'utf8'),
  }
}

if (selfTest) {
  const good = readSources()
  const clean = checkSources(good)
  let failed = false
  if (clean.length !== 0) {
    console.error('[check-attachment] 自检失败：当前源码本该通过，却报 ' + clean.length + ' 条')
    for (const problem of clean) console.error('    - ' + problem)
    failed = true
  }
  // 坏形态 A：不再抽附件（退回"只发占位"）
  const noAttachment = { ...good, announce: good.announce.replace('      attachment = extractAttachment(data)', '') }
  // 坏形态 B：把原始对象整体展开（多一个键整帧拒）
  const spread = {
    ...good,
    announce: good.announce.replace('      attachmentId,', '      ...raw,'),
  }
  for (const [label, mutated] of [['不发 attachment', noAttachment], ['整体展开原始对象', spread]]) {
    if (checkSources(mutated).length === 0) {
      console.error('[check-attachment] 自检失败：坏形态「' + label + '」居然通过了 ⇒ 判据是空转')
      failed = true
    }
  }
  if (failed) process.exit(1)
  console.log('[check-attachment] 自检通过：当前源码 0 条，坏形态（不发附件 / 整体展开）都能被抓住')
  process.exit(0)
}

const problems = checkSources(readSources())
if (problems.length > 0) {
  for (const problem of problems) console.error('[check-attachment] FAIL — ' + problem)
  process.exit(1)
}
console.log('[check-attachment] OK — 附件元数据带着走、只放白名单六键、越界退占位')

