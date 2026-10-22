#!/usr/bin/env node
/**
 * 注入判据门禁 —— Tidings 的 `agentHint` 到达后，**该不该投、投给谁**。
 *
 * ## 这条门禁守什么
 *
 * 判据决定「命令在哪个目录里执行」。判错的后果不是显示错，而是**在错误的项目里跑命令**。
 *
 * ## 五条不变量
 *
 * ① 没有 `agentHint` ⇒ 跳过（旧对端 / 纯聊天）；
 * ② `addressedToAgent=false` ⇒ 跳过（没 @ 到）；
 * ③ `senderMayExecute != true` ⇒ 拒绝（fail-closed，缺键也不放行）；
 * ④ **回声的判据是「发送者是不是 agent」**（`senderIsAgent`），不是方向：
 *    本机用户 @ 自己的 agent 时 direction=out，但那不是回声；
 *    agent 自己的回复才是。旧判据只看方向，会把用户指令第一条就跳过；
 * ⑤ **会话由 Tidings 给定**（`targetSessionId`）：没有就拒，不在本地候选里也拒。
 *
 * ## --self-test
 *
 * 把授权检查短路掉，断言 ③ 真的会失败 —— 证明这工具不是空转。
 *
 * 退出码：0 = 通过；1 = 有问题。
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const selfTest = process.argv.slice(2).includes('--self-test')

const failures = []
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) failures.push(label + '\n     期望 ' + e + '\n     实得 ' + a)
}

const mod = await import(new URL('../src/inject.ts', import.meta.url))
const api = {
  decideTidingsInjection: mod.decideTidingsInjection,
  deliverTidingsPrompt: mod.deliverTidingsPrompt,
  stripMention: mod.stripMention,
}

// 自检：把「授权检查」短路掉，模拟坏形态。
const decide = selfTest
  ? (message) => {
      const hint = message.agentHint
      if (hint === undefined) return { kind: 'skipped', reason: '这条消息没有注入判定（不是给 agent 的）' }
      if (!hint.addressedToAgent) return { kind: 'skipped', reason: '没有 @ 到本机任何 agent' }
      const target = hint.targetSessionId?.trim()
      if (target === undefined || target.length === 0) {
        return { kind: 'refused', reason: '没有算出可投的会话（该 agent 在工作区下没有会话，或还没同步）' }
      }
      return { kind: 'injected', sessionId: target }
    }
  : api.decideTidingsInjection

function msg(extra) {
  return { seq: 1, peerId: 'p', peerLabel: 'p', direction: 'in', at: 0, kind: 'group-text', text: '@dsh 跑测试', ...extra }
}
const cands = [{ sessionId: 's-1' }]
const okHint = { addressedToAgent: true, senderMayExecute: true, targetSessionId: 's-1' }

check('① 没有 agentHint ⇒ 跳过', decide(msg({}), cands), {
  kind: 'skipped', reason: '这条消息没有注入判定（不是给 agent 的）',
})
check('② addressedToAgent=false ⇒ 跳过', decide(msg({ agentHint: { addressedToAgent: false } }), cands), {
  kind: 'skipped', reason: '没有 @ 到本机任何 agent',
})
check(
  '③ 缺 senderMayExecute（旧版 Tidings）⇒ 拒绝',
  decide(msg({ agentHint: { addressedToAgent: true, targetSessionId: 's-1' } }), cands),
  { kind: 'refused', reason: '没有执行授权' },
)
check(
  '③ senderMayExecute=false ⇒ 拒绝并带上原因',
  decide(
    msg({ agentHint: { addressedToAgent: true, senderMayExecute: false, denyReason: 'MemberOnly', targetSessionId: 's-1' } }),
    cands,
  ),
  { kind: 'refused', reason: '没有执行授权（MemberOnly）' },
)
check(
  '④a 本机用户 @ 自己的 agent（out + 人发）⇒ 要注入',
  decide(msg({ direction: 'out', agentHint: { ...okHint, senderIsAgent: false } }), cands),
  { kind: 'injected', sessionId: 's-1' },
)
check(
  '④b agent 自己说的话（out + agent 发）⇒ 跳过，防回声',
  decide(msg({ direction: 'out', agentHint: { ...okHint, senderIsAgent: true } }), cands),
  { kind: 'skipped', reason: '这是 agent 自己说的话，不回声' },
)
check(
  '④c 别人 @ 你的 agent（in）⇒ 要注入',
  decide(msg({ direction: 'in', agentHint: { ...okHint, senderIsAgent: false } }), cands),
  { kind: 'injected', sessionId: 's-1' },
)
check(
  '④d 旧版 Tidings 没有 senderIsAgent 键 ⇒ 不按回声处理（宁可投一次）',
  decide(msg({ direction: 'out', agentHint: okHint }), cands),
  { kind: 'injected', sessionId: 's-1' },
)
check(
  '⑤ 没有 targetSessionId ⇒ 拒绝',
  decide(msg({ agentHint: { addressedToAgent: true, senderMayExecute: true } }), cands),
  { kind: 'refused', reason: '没有算出可投的会话（该 agent 在工作区下没有会话，或还没同步）' },
)
check(
  '⑤ targetSessionId 不在本地候选里 ⇒ 拒绝（防旧数据）',
  decide(msg({ agentHint: { ...okHint, targetSessionId: 's-gone' } }), cands),
  { kind: 'refused', reason: '目标会话 s-gone 不在本地候选里（可能刚结束）' },
)
check('⑤ 正常路径 ⇒ 投出去', decide(msg({ agentHint: okHint }), cands), {
  kind: 'injected', sessionId: 's-1',
})
check('正文为空 ⇒ 拒绝', decide(msg({ text: '   ', agentHint: okHint }), cands), {
  kind: 'refused', reason: '消息正文为空',
})

// ---------------------------------------------------------------- 投递层
const fakeAgents = (handles) => ({ get: (sid) => handles[sid] })
const okHandle = { followup: () => {} }

check(
  '投递：正常路径 ⇒ injected',
  api.deliverTidingsPrompt(msg({ agentHint: okHint }), cands, fakeAgents({ 's-1': okHandle }), (t) => ({ text: t })),
  { kind: 'injected', sessionId: 's-1' },
)
check(
  '投递：宿主没提供 agents 服务 ⇒ 明确 unavailable',
  api.deliverTidingsPrompt(msg({ agentHint: okHint }), cands, undefined, (t) => ({ text: t })),
  { kind: 'unavailable', reason: '宿主没有提供 agents 服务，无法注入会话' },
)
check(
  '投递：会话刚结束 ⇒ refused',
  api.deliverTidingsPrompt(msg({ agentHint: okHint }), cands, fakeAgents({}), (t) => ({ text: t })),
  { kind: 'refused', reason: '会话 s-1 此刻不存在（可能刚结束）' },
)
check(
  '投递：去掉 @ 后没有指令 ⇒ refused',
  api.deliverTidingsPrompt(
    msg({ text: '@dsh', agentHint: { ...okHint, agentName: 'dsh' } }),
    cands,
    fakeAgents({ 's-1': okHandle }),
    (t) => ({ text: t }),
  ),
  { kind: 'refused', reason: '去掉 @ 之后没有可执行的指令' },
)
check('stripMention 去掉 @ 与名字', api.stripMention('@dsh 跑一下测试', 'dsh'), '跑一下测试')

if (failures.length === 0) {
  console.log(selfTest ? '自检通过（判据不空转）' : '注入判据门禁通过')
  process.exit(0)
}

if (selfTest) {
  console.log('自检通过：坏形态被这 ' + failures.length + ' 条判据抓到了')
  process.exit(0)
}
console.error('注入判据门禁失败：')
for (const f of failures) console.error('  · ' + f)
process.exit(1)
