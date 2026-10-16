/**
 * check-real.mjs —— 真实链路门禁（非 check-shell 假壳）。
 *
 * 用途：证明 dsh-tidings 插件的「真客户端」(src/tidings.ts 的 TidingsClient) 能与一个
 * **真实运行的 agentNode** 完成往返，而不是只在假壳（fake connection）里自洽。
 *
 * 它做的是：
 *   - 用生产里的同一个 createTidingsClient(ctx, config) 构造客户端，
 *   - 把 baseUrl 指到活的 agentNode（默认 http://127.0.0.1:8788，可用 TIDINGS_BASE_URL 覆盖），
 *   - 依次真打 health() / peers() / inbox() / send()，断言返回的是真实数据（非空、字段对）。
 *
 * 这补上了假壳门禁的盲区：单元层里的 status/peers/inbox 全是假数据，而本脚本证明
 * 同一条代码路径在真实控制面下也能跑通。要它过，必须先有一个真 agentNode 在跑
 *（捎话桌面端，或源码构建的无头节点，见 README「前提」）。扫码不是前提——扫码只是
 * 取 URL，这里直接用 HTTP。
 *
 * 不做的事：不验证 QR 矩阵可扫（那是 agentNode /v1/pairing-qr 的事，要带 --public-url
 * 的实例，另属捎话节点仓的验证）；不验证 agent session/event（那要求对端声明 agn1 能力，
 * 属另一条链路，排查入口是 tidings_announce_status 工具）。
 */

// 用构建产物 lib/index.js，不用 src/tidings.ts —— Node 的 strip-only 模式解析不了
// tidings.ts 里的参数属性(parameter properties)，会抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
// lib 是 npm run build 的产物，跑本脚本前先 build 一次。
import { createTidingsClient, resolveConfig } from './lib/index.js'

const BASE_URL = process.env.TIDINGS_BASE_URL ?? 'http://127.0.0.1:8788'

// 最小 Context：get('credentials') 返 undefined ⇒ resolveToken 回落到 process.env，
// 再为空 ⇒ 不发送令牌。活 agentNode 默认回环放行，不需要令牌。
const ctx = {
  get: (key) => (key === 'credentials' ? undefined : undefined),
}

const results = []
const record = (label, ok, detail) => {
  results.push({ label, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `  ← ${detail}`}`)
}

const run = async () => {
  const client = createTidingsClient(ctx, { baseUrl: BASE_URL })
  let health
  try {
    health = await client.health()
    record('health() 真实返回且字段齐全',
      health.ok === true && typeof health.nodeId === 'string' && health.nodeId.length > 0,
      JSON.stringify(health).slice(0, 160))
  } catch (error) {
    record('health() 真实返回且字段齐全', false, `异常 ${String(error).slice(0, 160)}`)
    finish()
    return
  }

  let peers
  try {
    peers = await client.peers()
    record('peers() 返回真实邻居数组', Array.isArray(peers) && peers.length >= 0,
      `count=${peers.length}`)
  } catch (error) {
    record('peers() 返回真实邻居数组', false, `异常 ${String(error).slice(0, 160)}`)
    peers = []
  }

  try {
    const inbox = await client.inbox({ limit: 3 })
    record('inbox() 真实返回消息列表', inbox && Array.isArray(inbox.messages),
      `messages=${inbox?.messages?.length ?? 'n/a'}`)
  } catch (error) {
    record('inbox() 真实返回消息列表', false, `异常 ${String(error).slice(0, 160)}`)
  }

  // agent 会话台账：这条走的是**独立于 /v1/inbox** 的只读路由（agent 帧不进聊天存储），
  // 所以要单独证它在真实控制面上存在且形状正确 —— 假壳能返回它，但假壳证明不了路由存在。
  try {
    const ledger = await client.agentSessions()
    const shaped = Array.isArray(ledger.sessions)
      && ledger.sessions.every(s => typeof s.sessionId === 'string' && typeof s.nodeId === 'string')
    record('agentSessions() 真实返回台账（形状正确）', shaped,
      `total=${ledger.total} sessions=${ledger.sessions.length}`)
    // 面板的「默认选中最近更新的那个」直接取第一条，所以**降序**是契约的一部分，
    // 不是实现细节：控制面若改成升序，面板会静默选中一个最老的会话。
    const desc = ledger.sessions.every((s, i) => i === 0 || ledger.sessions[i - 1].updatedAt >= s.updatedAt)
    record('台账按 updatedAt 降序（面板的默认选中依赖它）', desc,
      ledger.sessions.map(s => s.updatedAt).join(','))
    // 点名一个会话时，events 才出现；不点名时它必须是 undefined（不是空数组）。
    if (ledger.sessions.length > 0) {
      const one = await client.agentSessions({ sessionId: ledger.sessions[0].sessionId })
      record('点名 sessionId 时返回该会话（且 events 键按约定出现）',
        one.sessions.length <= 1,
        `sessions=${one.sessions.length} events=${one.events === undefined ? 'undefined' : one.events.length}`)
      record('点名时 events 是数组（可能为空，但不能缺键）',
        Array.isArray(one.events),
        `events=${one.events === undefined ? 'undefined' : JSON.stringify(one.events.length)}`)
    }
  } catch (error) {
    record('agentSessions() 真实返回台账（形状正确）', false, `异常 ${String(error).slice(0, 160)}`)
  }

  // send() 给一个不可达地址：真实控制面应返 404 peer-unreachable（真实错误，非 500），
  // 这是「真实出站路径确实在跑」的最强证据——假壳只会回 {status:'sent'}。
  try {
    const receipt = await client.send({ to: '203.0.113.250', text: '真实链路探测' })
    record('send() 对不可达对端给出真实结果', receipt.status === 'queued' || receipt.status === 'sent',
      JSON.stringify(receipt))
  } catch (error) {
    const msg = String(error)
    // 期望：peer-unreachable（控制面真实握手失败），不是 500/连接被拒。
    const genuine = msg.includes('peer-unreachable') || msg.includes('握手')
      || msg.includes('404')
    record('send() 对不可达对端给出真实错误（非 500）', genuine, msg.slice(0, 160))
  }

  // 顺带验证 resolveConfig 的默认值没被改坏（生产路径也走它）。
  const cfg = resolveConfig({ baseUrl: BASE_URL })
  record('resolveConfig 默认值正确',
    cfg.baseUrl === BASE_URL && cfg.tokenCredentialRef === 'TIDINGS_AGENT_TOKEN'
      && cfg.defaultPort === 17878 && cfg.inboxLimit === 30,
    JSON.stringify({ baseUrl: cfg.baseUrl, ref: cfg.tokenCredentialRef, port: cfg.defaultPort, limit: cfg.inboxLimit }))

  finish()
}

const finish = () => {
  const bad = results.filter(r => !r.ok)
  console.log('')
  if (bad.length === 0) {
    console.log(`真实链路门禁全过：${results.length}/${results.length}`)
    process.exit(0)
  } else {
    console.log(`真实链路门禁失败：${bad.length}/${results.length}`)
    process.exit(1)
  }
}

run().catch((error) => {
  console.error('致命错误:', error)
  process.exit(1)
})
