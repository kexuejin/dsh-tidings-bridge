# 贡献指南 (Contributing)

感谢参与 dsh-tidings。这个插件的全部风险面集中在一个事实上：**它把 DSH 会话台账的一角，经本机回环交给一个会向局域网发包的常驻进程**。因此这里的门禁比一般插件严。改代码前请读完本文。

## 1. 开发环境

- Node `^22.19.0 || >=24.0.0`（与 DSH 宿主一致）
- pnpm `>= 10`（锁文件为 pnpm 格式）
- 一个**活的 agentNode**（捎话桌面端，或源码构建的无头节点）——只有跑 `pnpm run check:real` 时需要
- Google Chrome —— 只有重拍 `docs/prototype/` 参考图时需要

```sh
pnpm install
pnpm run check     # typecheck + 七条门禁 + build，与 CI 完全一致
```

## 2. 仓库结构

见 [README.zh.md §仓库结构](README.zh.md#仓库结构)。一句话版：`src/` 是 host 半（Node），`src/client/` 是 browser 半（设置页卡片），两者只经 `model.ts` 声明的回环 RPC 频道对话；`scripts/` 是门禁，`docs/` 是设计沿革与原型稿。

## 3. 门禁：每条都钉着一次真实故障

`scripts/check-*.mjs` 的头部注释里写着它各自钉住的那次事故（症状、错误判据、为什么静默）。**加新门禁请沿用这个格式** —— 一条没有故障故事的门禁，半年后只会被当成噪音删掉。

七条门禁覆盖的判据速查见 [README.zh.md §开发](README.zh.md#开发)。

## 4. 代码规范

- TypeScript `strict` + `exactOptionalPropertyTypes`。可选属性一律 `T | undefined` 显式声明，条件展开用 `...x === undefined ? {} : { x }`，不要塞 `undefined` 进对象字面量。
- 每个源文件顶部有 `@module` 级注释，说明**它为什么存在**；函数与类型用 JSDoc。注释解释判据与事故，不复述代码。
- 对宿主服务的取值走 `ctx.get(...)` 运行时可选读取；`inject` 只允许出现宿主一定提供的基线服务（`check:inject` 会拦，且拦的原因是一次静默不加载的事故）。
- 界面文案不进组件：全部走 `src/client/locales.ts` 的 zh/en 双词典，漏译是编译错误。
- 注释与提交信息里不要写死行号引用（`X.ts:NN` 会随重构腐烂）、本机绝对路径、真实设备昵称。门禁脚本里保留事故叙事，但请去掉可识别到个人的措辞。

## 5. 提交与 Pull Request

- 分支自 `main`；一个 PR 一件事。
- 提交信息用 Conventional Commits（`fix(announce):` / `feat(client):` / `docs:` / `chore:`），正文写**为什么**，引用关联 issue。
- PR 必须 `pnpm run check` 全绿（CI 会再跑一遍）。动了宣告/分页/排序逻辑的，附 `tidings_announce_status` 的输出或真机说明。
- 改动会扩大宣告暴露面（受众、字段、频率）的，PR 里必须写明隐私影响，并同步更新 README 的「隐私说明」一节。

## 6. 原型稿与参考图

`docs/prototype/` 是信息架构的论证现场，不是死资产：

```sh
cd docs/prototype
python3 -m http.server 4181 --bind 127.0.0.1 &
python3 shoot-tidings-panel.py        # 重拍 21 张参考图
python3 probe-tidings-panel.py        # 几何探针：裁切 / 溢出 / 出界
bash check-tidings-panel.sh           # 稿内 JS 语法体检
```

改稿必须重拍图，图和稿一起提交。探针报告写 `/tmp`，不落仓库。

## 7. 发布形态

本包的 `prepare` 脚本让 `dsh plugin add github:...` 现场构建可用；tarball / npm 路径由 `pnpm pack` 走 `files` 白名单。发布新版本请同步 `CHANGELOG.md` 并打 `vX.Y.Z` tag。
