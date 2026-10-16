# dsh-tidings 面板原型稿

**一句话**：把现在三个页签（邻居 / 消息 / 设置）并成**一条按时间排序的最近会话流**，
设备和设置分别收进右上角「更多」菜单。

这份稿子只回答一件事：**信息架构该长什么样**。它不生成代码，也不要求是像素级可实现 ——
但稿子里每一处用户可见的文案、每一个字段名，都对应真实代码里存在的东西，没有自造的 API。

---

## 1. 目录

```
docs/prototype/
  tidings-panel.html          ← 原型本体（单文件，HTML + CSS + JS + 内联 SVG，无外部依赖）
  shoot-tidings-panel.py      ← Chrome headless 截图脚本，21 张
  probe-tidings-panel.py      ← 几何探针：39 个「屏 × 形态」组合量盒模型
  check-tidings-panel.sh      ← 语法体检（抽出 <script> 交给 node --check）
  screenshots/              ← 21 张成图
  README.md                 ← 本文
```

`tidings-panel.html` 分三段，读的时候可以各取所需：

| 段 | 位置 | 说明 |
|---|---|---|
| 样式 | 第 1 ~ 486 行 | 前面一大段是 **ui-theme 的 verbatim 拷贝**（见 §3）；第 488 行起才是稿子自己的骨架与组件类 |
| 数据 + 屏 | 中段 | 假数据、13 个屏函数、设计注释（`.annot` 块） |
| 渲染入口 | 尾部 | 带 `?screen=` 走单屏（截图用），否则出控制条 + 画廊 |

**设计注释都在 HTML 里。** 每个屏底下有一条竖线标注的「设计注释」块，写清了这一屏
相对现状改了什么、为什么、以及代价。改稿时不要把它当成装饰 —— 它和画面对应。

---

## 2. 怎么看

```sh
cd docs/prototype
python3 -m http.server 4181 --bind 127.0.0.1
```

然后浏览器开 `http://127.0.0.1:4181/tidings-panel.html`：

- 默认出**画廊**：20 格（13 屏 × 宽深 / 宽浅 / 窄深）。点任一格进单屏。
- 顶部两条控制条：**形态**（宽窗 1440×900 / 窄窗 600×760，各自深浅）与 **屏**。
  切形态时落点自动挪到语义最接近的一屏。

直接跳某一屏：

```
?screen=p-thread&size=wide-dark&theme=dark
?screen=p-home&size=narrow-dark&theme=dark
```

**为什么必须走 HTTP 而不是双击打开**：本机 `--headless` 在 `file://` + 查询串下会挂住不返回；
而且本机配了 HTTP_PROXY，`--no-proxy-server` 不加的话 127.0.0.1 也会被丢给代理，拿到一张空白页。

---

## 3. 颜色不是我调的

样式的前 **486** 行是 `deepseek-harness` 仓库里 **verbatim 拷贝**的真实 token 表：

```
packages/client/ui-theme/src/styles/design-platform.css   ← 静态色阶 + 语义别名
packages/client/ui-theme/src/styles/base.css              ← 字体栈 / 圆角阶 / 缓动
packages/client/ui-theme/src/styles/focus.css             ← 焦点环
```

**唯一改动**：把里面的 `body` 选择器改写成 `.win`。原因是要在一页里并排画多个「窗口」，
深浅两套必须按窗口切，挂到真 `body` 上就全串了。

真实实现里这些规则归 `ui-theme` / `ui-primitives` 所有，面板一行都不该自己写 color。
读这份稿子时这一段可以整段跳过。

侧栏那一项是 `ui-sidebar` 的示意，不是本插件的内容，稿子里只画出「本插件挂在外壳侧栏的一个槽位里」。

---

## 4. 形态分档

稿子只做三档，不是随便挑的，对应 DSH 外壳真实的侧栏宽度：

| 档 | 画布 | 侧栏 | 说明 |
|---|---|---|---|
| `wide-dark` / `wide-light` | 1440×900 | 280 | 侧栏展开 |
| `narrow-dark` / `narrow-light` | 600×760 | 56 | 侧栏收到 rail |

侧栏宽度取 `packages/client/ui-layout/src/client/columns.ts` 里的常量（280 展开 / 56 收起），
与宽窗 &lt;1024 时自动收起的行为一致。窄窗档里侧栏只留图标（`.win[data-collapsed]`）。

---

## 5. 提案：一条最近会话流

### 5.1 现状

三个页签（`已删除的原 TidingsPanel.tsx`）：

| 现状 | 问题 |
|---|---|
| **邻居** `tab === 'peers'`（`:353`） | 同一个对端在这里出现一次 |
| **消息** `tab === 'messages'`（`:398`） | 同一个对端在「消息」里**又**出现一次 |
| **设置** `tab === 'settings'`（`:472`） | 既是三页签之一，又是所有异常态的兜底去处 |

**同一个对端拆在两个页签里**，于是「和 Pixel 6 到底聊到哪了」这个问题，
要切回去切过去才能答。而这两个页签回答的其实是同一个问题的两面。

### 5.2 合并之后

**一条会话 = 一个 `TidingsPeerView`（`model.ts:73-84`）加上按 `peerId` 归到它名下的
`TidingsMessageView`（`model.ts:87-98`）。** 取数没有新增来源，`conversations()` 就是
`PEERS × inbox`，一行合成代码。

三条规则：

1. **没消息的邻居也占一行**（第 5 行 iPad Air）。「这个人现在在线」本身就是信息，
   藏进另一个页签就是丢了。
2. **排序键是「最近活动」**：有消息取最后一条的 `at`，没消息退到 `lastSeen`。
3. **设置 / 令牌 / 刷新进右上角「更多」菜单。** 菜单里的东西是看不见的，
   而「现在看的是不是全部会话」必须一眼可见 —— 所以过滤做成常驻的一排药丸，
   计数写在药丸里。

### 5.3 四处需要拍板的取舍（写在稿子里，这里列出来）

| # | 取舍 | 稿子的画法 | 反方意见 |
|---|---|---|---|
| 1 | **在线的人会不会被压下去** | 会。排序只看最近活动，在线不作为同权条件 | 在线本来就在 `peers` 页当过主排序键，并掉之后可能反而不容易被看到 |
| 2 | **没握过手的对端没有 `nick`** | 画成「未知（没握过手）」 | 现状直接渲染 `peer.nick`（`已删除的原 TidingsPanel.tsx`），空串就是一片空白 |
| 3 | **「待发 N」徽标画不画** | 不画。`pending` 是节点级全局队列长度（`model.ts:68`），不是每条会话各一个；画到行上就是假数据 | —— |
| 4 | **手动填收件人的入口** | 搬到「更多 → 新建消息」，只在没有会话时用 | 有会话时用户还得先想起来去菜单里找 |

---

## 6. 屏清单

13 屏 / 20 画廊格。每一屏下面的「设计注释」块写了对应的真实代码位置。

### 列表

| 屏 | 画的是 | 现状对照 |
|---|---|---|
| `p-home` | 最近会话（**默认落点**） | 三页签里的「邻居」+「消息」合并 |
| `p-home-empty` | 一条邻居都没有 | 复用 `peers.empty` / `peers.emptyHint`，补一个「去设置」入口 |
| `p-home-filter` | 搜索 + 三种药丸过滤 | 现状既没有搜索也没有过滤 |
| `p-more` | 右上角更多菜单 | 「新建消息 / 复制节点 ID / 控制面设置 / 访问令牌」 |

### 对话

| 屏 | 画的是 |
|---|---|
| `p-thread` | 有消息的会话。收件人固定，不再出现「发给」输入框 |
| `p-thread-empty` | 从没聊过的邻居点进来就是这一屏 |
| `p-thread-queued` | **全稿最重要的一屏**：`queued ≠ 已读`，用一条常驻横幅钉住 |
| `p-compose` | 手动填收件人（只在没有会话时用） |

### 异常

| 屏 | 画的是 | 代码依据 |
|---|---|---|
| `p-unreachable` | 连不上控制面 | `error.unreachable`（`locales.ts:100`） |
| `p-unauthorized` | 需要令牌，且**就地**给出录入框 | 状态值在 `model.ts:157`；校验在 `已删除的原 TidingsPanel.tsx` |
| `p-loading` | 骨架屏 | `refresh()` 是串行两跳（`已删除的原 TidingsPanel.tsx`） |

### 设置

| 屏 | 画的是 |
|---|---|
| `p-settings` | 「控制面设置」+ 一个通往「访问令牌」的入口 + 状态徽标 |
| `p-credential` | 令牌录入，三个状态各自可见（已配置 / 不可写 / 只读来源） |

---

## 7. 文案：哪些照抄、哪些新造

`tidings-panel.html` 里 `const T = {...}` 共 **74 项**：68 项逐字照抄 `src/client/locales.ts`
（一个字没改，例如 `panel` / `state.online` / `peers.emptyHint` / `messages.in` /
`compose.queued` / `credential.readonly` …），4 项带占位符的模板，2 项不逐字等长
（`errPeerUnreachable` 已按 `error.peer-unreachable` 对齐；`bannerUnreadUnknown` 见 §8）。

**新造的键已经按现有命名风格补进 zh / en 两本字典了**（`locales.ts` 现在 97 键，两本一一对齐）：

| 键 | 值（zh） | 用在哪 |
|---|---|---|
| `filter.all` / `filter.online` / `filter.hasMsg` / `filter.unknown` | 全部 / 在线 / 有消息 / 未知对端 | 一排过滤药丸（现状既没有搜索也没有过滤） |
| `peer.unknown` | 未知（没握过手） | 没握过手的会话行（第 4 行） |
| `action.back` / `action.copyNodeId` / `action.controlPlane` | 返回 / 复制节点 ID / 控制面设置 | 详情页返回、更多菜单 |
| `menu.more` / `menu.new` | 更多 / 新建消息 | 右上更多按钮、手动填收件人的入口 |
| `send.result` | 发送结果 | `p-thread-queued` 那屏的横幅标题 |
| `banner.pending` | 有 {count} 条消息还在等对方上线，会自动补发。 | 节点级待发队列的常驻横幅 |
| `banner.queued` / `banner.sent` | 发给 {to} …已入队… / {to} 已收到（ACK）。 | 单条会话的发送态横幅（措辞沿用 `compose.queued` / `compose.sent`，只多一个收件人前缀） |
| `banner.unreadUnknown` | 本机 {count} 个邻居从没握过手… | 列表横幅（提案里画过但**已移除**，见 §8） |

字典里的占位符沿用 `{…}` 写法（和 `health.counts` / `settings.path` 一致），靠调用方代入，
**字典里不放函数** —— `en` 的签名是 `Record<TidingsKey, string>`，塞函数会直接过不了编译。

> `action.openSettings`（`locales.ts:28`）**定义了但全仓 0 处渲染过**。
> 空态那张「去设置」按钮就是为它准备的 —— 空态里最可能的下一步是去改控制面地址。

---

## 8. 一处刻意没画的

`banner.unreadUnknown` 那句「本机 1 个邻居从没握过手」曾经挂在列表顶部。
**现在它只在 `T` 里留着一项，没有任何地方渲染它** —— 稿子留的是这个讨论的凭据，
不是要实现的画法。实现时**不要**把它加回去：

- 它描述的是一个**数据状态的成因**，属于解释性文案；
- 「未知（没握过手）」这个行本身已经在自解释，再顶上一条横幅是重复；
- 横幅位置应该是**动态信息**（排队中、发送失败这类），不是静态数据说明。

稿子保留它，是为了让「为什么第 4 行是这个名字」这个讨论有据可查。

---

## 9. 时间字段的单位（实现时最容易踩）

**`at` 和 `lastSeen` 是绝对 epoch 毫秒，不是「距今多少毫秒」。**

真代码 `relativeTime(t, at)`（`已删除的原 TidingsPanel.tsx`）算的是
`(Date.now() - at) / 1000`。稿子因为要截图可复现，把基准钉成
`NOW = Date.parse('2026-10-07T23:20:00+08:00')`，数据写成 `NOW - 2 * MIN` 这种形式，
渲染时一律 `relTime(NOW - x)`。

> 稿子的**第一版把 `at` 当成「距今偏移」存**，结果气泡里全是「2 天前」、
> 列表排序还是反的。这个错已经修掉了，但改稿时别把两边的约定搞混。

---

## 10. 验证

外加一条**真渲染体检**，验的是面板本体不是稿子（先 `pnpm run build`）：

```sh
# 把 build 产出的 client/client.js 装进 jsdom，走真实 apply() 注册链路挂起来，
# 48 项断言：会话流排序 / 药丸计数 / 搜索 / 详情 / 常驻 queued 横幅 / 加载更早 /
# 更多菜单 / 复制回执 / 新建消息 / 设置 / 令牌 / unauthorized 就地录入 / 重试恢复 /
# 输入区那排（表情按钮 / 面板开关 / 插一枚收起 / 光标按 UTF-16 前进）
pnpm run check:render
```

```sh
# 语法体检（不需要服务器）
./check-tidings-panel.sh

# 截图（21 张）
python3 -m http.server 4181 --bind 127.0.0.1 &
CODEBUDDY_SAFE_DELETE_ENABLED=0 python3 shoot-tidings-panel.py

# 几何探针：39 个「屏 × 形态」组合，查横向溢出 / 纵向被切 / 元素出框
python3 probe-tidings-panel.py
```

探针退出码非 0 = 有发现，报告写到 `/tmp/tidings-panel-probe.json`，生成物不落仓库。

**截图的坑**：`shoot-tidings-panel.py` 里 `BASE` 结尾必须带 `?`。少了它，
`&size=…&screen=…` 会被当成路径的一部分，Chrome 拿到 404，
于是 21 张图**字节数一模一样**（全是同一张空白页），脚本还报 0 失败。

---

## 11. 这个稿子不覆盖什么

- **不是真实渲染的 React。** 稿子是静态 HTML，交互是假的（点会话不跳转、菜单不开关）。
  这三条命令验的是稿子；**面板本体已经按这份稿子重写了，真渲染走 `pnpm run check:render`** ——
  见 §12。
- **没有 MicroUI 组件 library 的落地细节**： focus 循环、虚拟滚动、`aria-expanded` 的
  真实切换，这些要照 `ui-primitives` 现有组件来做，不能照稿子抄 DOM。
- **字典补了键，现在基本都接上了。** `locales.ts` 两本字典各 **103 键**（zh/en 完全对齐）。
  这 15 个新键已经接进 `已删除的原 TidingsPanel.tsx`，103 个键里**只剩 9 个 0 渲染**（§11 底下那段）。
  重写后两本字典各 **97 键**（3 个是输入区那排表情用的，见 §12 第 5 条），0 渲染项见 §12。
  - `action.back` / `action.controlPlane` / `action.openSettings` / `menu.more` / `menu.new`
    —— 这 5 个是**移动导航壳**的构成件（返回箭头、控制面跳转、溢出菜单、新建消息）。
    面板本体是桌面侧栏形态的单页 section，长出这套导航等于改外壳，不是「接文案」能做的，
    等导航形态拍板。
  - `action.copy` / `action.copyNodeId` —— 要「复制节点 ID」按钮，但字典里**没有「已复制」
    反馈文案**。做了按钮没反馈就是半成品，所以先不接；补一个 `action.copied` 就能落。
  - `compose.sent` / `compose.queued` —— **孤儿键**。`send()` 改用带收件人名字的
    `banner.sent` / `banner.queued`（「发给 {to} 的消息已入队」比中性句更能防「已读」误读），
    这俩旧文案就没人引用了。**删不删由你定**，删了字典会从 103 降到 101。
- **已接的那批怎么接的**（判据都来自 `model.ts`，没有凭空造语义）：
  - `banner.pending` ← `TidingsHealthView.pending`（`model.ts:68`），> 0 时挂在邻居列表顶部。
  - `banner.unreadUnknown` / `filter.unknown` / `peer.unknown` ← `nick` 为空即「从没握过手」。
  - `banner.sent` / `banner.queued` ← `TidingsSendReceiptView.to`（`model.ts:109-112`）。
  - `send.result` ← 作为 `Notice.label`（只给发送结果带，其他反馈不带标签）。
  - `filter.all/online/hasMsg/unknown` ← peers 筛选条 4 个 chip。
    **`filter.hasMsg` 是近似判据**：`TidingsPeerView`（`model.ts:73-83`）**没有未读数字段**，
    所以「有消息」降级成「这个对端出现在 inbox 里」（`inbox[].peerId`），代码注释里写明的是
    这个取舍，不是未读。
  - `peers.host` / `peers.selected` / `messages.more` / `credential.needValue` 同上，
    分页走 `inbox.nextSince`（左开右闭游标，`model.ts:100`）。
- **静态扫描怎么算的。** 面板里 103 个键里 94 个已渲染，扫描要区分三种写法，否则误判：
  字面 `t('a.b')`、模板 `` t(`error.${code}`) ``（`error.*` 7 个键由 `TidingsErrorCode`
  枚举驱动，属于「会渲染但扫不到具体键名」）、变量 `t(filter.label)`（筛选条那 4 个）。
  键拼写受 tsc 约束 —— 把 `t('peers.host')` 改成 `t('peers.hostX')` 会报
  `TS2345: '"peers.hostX"' is not assignable to parameter of type 'LocaleKeysOf<"tidings">'`。
- **没有英文态。** 两本字典现在一一对齐（103 键），稿子的 `T` 是中文单语。
- **令牌输入框的可写判定**照的是现状（`writable`，`已删除的原 TidingsPanel.tsx`，
  行号随改动漂移），稿子只画三种脸，不讨论数据来源。

---

## 12. 落地之后：稿子变成了什么

`已删除的原 TidingsPanel.tsx` 已经按上面这些屏重写完并通过 `pnpm run check:render`（48/48，0 React 警告）。
这一节记的是**实现里和稿子不完全一样的地方**，以及为什么那样做 —— §5~§9 是设计记录，
照抄会踩的实现细节在这里。

**照稿落地的部分。** 三页签并成一条 `peers × inbox` 的会话流（`buildConversations()` 是唯一的
取数动作）；行排序键是最后一条消息、没消息退 `lastSeen`；没有消息的邻居也占一行；`nick` 为空的
画「未知（没握过手）」；搜索与药丸两条正交的轴；更多菜单四项目前都接上了真实动作；
`queued ≠ 已读` 用一条钉在会话里的横幅，而不是飘完就没的那句 `compose.queued`；
`unauthorized` 就地给令牌录入框；空态给「去设置」。

**五处有意的实现选择。**

1. **`unknown` 的判据从 `nick.length === 0` 换成了 `nodeId === host`。**
   稿子写的是"没握过手"，第二条注释（§5.2 `p-home`）也提到 `model.ts:74` 的注释说明
   没握过手的对端 `nodeId` 就是它的 host authority。`nodeId === host` 是那个事实的直接表达，
   而 `nick` 为空只是当前数据的巧合 —— 控制面哪天补上了昵称，判据就翻了。

2. **药丸的计数按"搜索剩下的那批"算，不是全局。** 稿子的 `p-home-filter` 把搜索框和
   全局 `COUNTS` 画在一起（搜「打印机」时药丸上还是 5 / 2 / 4 / 1）。这里按当前搜索结果算，
   药丸回答的是"你正在看的这批里有几个在线"。

3. **排队横幅的解除条件是 `health.pending === 0`。** 「钉到对方上线 ACK」这句话里，
   `TidingsHealthView.pending` 是模型唯一能给的队列信号，且它是节点级的 —— 所以清的是全部
   横幅，不是逐条清。模型没有 per-peer 的已送达回执（§5.3 取舍 3 已经说过行内徽标是假数据）。

4. **更多菜单按普通流内布局画，不做绝对定位。** 稿子是 `style="top:78px;right:20px"`；
   面板本体的 `.root` 是可滚的 flex 列，绝对定位的浮层会被裁掉。菜单是 `role="menu"` +
   `aria-haspopup`，点外面 / 按 Esc 关。
5. **输入区那排实现成"一个按钮 + 向上开的面板"，且整排只有这一颗。** 稿子 `p-thread` 画的
   也是这一颗，理由是那五颗画了都没用（§12 下面的补充）；这里补的是**它怎么长出来**：
   `.toolbar` 自己 `position:relative`，面板 `bottom:calc(100% + 6px); left:0` 往上开，
   不会因为 `.root` 可滚被裁。三处实现细节都不是随手写的：
   - **光标位置从活的 textarea 上读**（`composerRef.current.selectionStart/End`），不存 state ——
     `draft` 是会话详情和「新建消息」两屏共用的，selection 一旦进了 state，切屏回来就是旧值。
   - **前进量是 `emoji.length` 不是 `+1`**：😀 是代理对，`setSelectionRange` 按 UTF-16 单位数。
     `check-render.mjs` 里有一条断言专门锁这个（+1 会 FAIL）。
   - **插一枚就自己收起来**，不然连点两下会插两枚 —— 这是表情面板最常见的"没人告诉我"。

**输入区那排为什么只有表情**（稿子 `p-thread` 的 `annot` 已经写了，实现里 `已删除的原 TidingsPanel.tsx`
的 toolbar 注释又挂了一次，两处都不许再往这排加图标）：
控制面 `/v1/send` 只收 `{to, text}`，图片/文件没有落点，画出来就是"按下去没反应"，
比不画更糟（这条判据来自捎话 `MessageComposer.kt` 的 KDoc）；截图要碰屏幕、图片要读本地
路径，面板在浏览器半边两头都够不着；PK / 猜拳 / 骰子 / 窗口震动是**人与人**之间的事，
而这里收件方是 agent。

**这一稿从头到尾不画消息投递态。** 茶话间那稿把「已送达 / 已排队 / 发送失败 / 重发」
那一整套撤掉了（理由见 `teahouse-mobile/prototype/README.md` §10.6），这里不是漏跟，
是从头就没有：面板的消息列表只有气泡本身，没有气泡下的状态行，也没有气泡按态染色。
整份稿里唯一还沾"在飞的路上"的是发送按钮那句 `sending: '发送中…'` —— 那是按钮的点后
反馈（200ms 量级），不是一条消息停在哪儿，跟要撤掉的那类不是一回事。
`p-thread-queued` 那屏保留「已入队」，它是**说明**不是状态指示：它讲的是
"queued 不等于已读"这个最容易被误读的点，画的是一个结论，不是一条消息正在排队。

**文案上的两处。**

- 加了 `credential.readonlyTitle`（`credential.readonly` 是那句「该凭据由外部来源提供…」）。
  稿子的 `p-credential` 用 `T.credReadonly.split('，')[0]` 当第二张卡的标题 —— 切一刀本地化的
  整句当别处用的标题，英文态下逗号不一样、切出来未必是个名词，所以单开一个键。
- 加了 `action.copied` / `action.copyFailed` / `search.placeholder` / `search.empty`。
  前两个就是 §11 说"补一个 `action.copied` 就能落"的那个。`search.*` 是稿子内嵌的
  「搜索邻居或消息」，进字典才好做 en。

**字典从 103 键变 97 键（zh/en 各 97，完全对齐）。** 删掉 8 个、加了 3 个
（`compose.emoji` / `compose.emojiInsert` / `compose.emojiHint` 那排表情用的）：

- `tab.peers` / `tab.messages` / `tab.settings` —— 页签没了。
- `peers.select` / `peers.selected` —— 会话行整个就是按钮，不再有"选中收件人"这一步。
- `peers.host` / `peers.platform` —— 详情顶部是按稿子画成 `地址 · 平台 · 最后活跃` 的裸串，
  不再挂标签。
- `compose.needTo` —— 收件人空时直接置灰按钮（稿子 `p-compose` 明确要求"发送按钮下方出错误"，
  但那是 `peer-unreachable` 这类，收件人为空属于前置校验）。
- `compose.sent` / `compose.queued` —— §11 说的那两个孤儿键，删了。

**现在 0 渲染的键只剩两个，两个都对：**

- `filter.online` / `filter.hasMsg` / `filter.unknown` —— 由 `PEER_FILTERS` 的 `label` 变量
  经 `t(pill.label)` 渲染，静态扫描扫不到，实际在画。
- `banner.unreadUnknown` —— §8 明确要求**不要**加回去。

**窄栏已经量过。** 上面那条"要真浏览器看"现在有了着落 —— `check-layout.mjs`
（`pnpm run check:layout`）把每一屏的真实 DOM 塞进 360 / 420 / 500 / 900 四种定宽容器，
  交给 Chrome 真的排一遍，报告哪些元素的矩形越过了容器边界：**9 屏 × 4 宽度共 36 组，
一个都没顶出去**（第九屏是 `表情面板（展开）` —— 浮层不在任何 view 里，
不单独量一轮就没人看它）（节点信息那行在最窄处自然换成两行，药丸那一排不换行）。
探针自带金丝雀自检 —— 一个故意 9999px 宽的元素，抓不到它就把整份报告当成不可信。
跑出来是干净的，但这条命令是给人看的，不进 `pnpm run check`：它没有断言，只出报告。

两个绕过去的坑，写在这里省得重踩：Chrome headless 的 `--window-size` 有下限
（给 420 会被拉到 500，测不到真手机宽度），要走 CDP 的 `Emulation.setDeviceMetricsOverride`；
而 Node 的 WebSocket 在派发 `open` 时会拿一个跨 realm 的 `Event` 去调 `dispatchEvent`
并抛 `ERR_INVALID_ARG_TYPE`（22 和 25 都一样），CDP 那年在 Node 里连不上。
最后是用定宽容器代替改视口 —— 容器被压到 360 之后，弹性子项收缩不了就自己顶出去，
和视口真是 360 是同一件事。

**还没验到的部分。** 面板没有自动轮询，状态刷新是手动的 —— 这也是 §5.2 那条
「待发 1」横幅会一直挂着的另一个原因。另外 `check-layout.mjs` 只看得见布局，
看不见字体渲染差异（CJK 字形、字重）和滚动手感；`probe-tidings-panel.py` 也仍然只验稿子。
