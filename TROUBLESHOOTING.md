# dsh-maid-vcp · 问题与解决记录

> **用途**：把本插件从 0.3 到今天踩过的坑按「**症状 → 根因 → 解法 → 验证**」收成一册。
> 主要读者是**在新设备上安装/迁移这套插件的人和 agent**——先看一、六两章（怎么装、落了哪些东西），
> 出问题时按症状翻二~五章，第七章是排查手法。
> **最后更新：2026-10-18**（插件 `0.6.14` ＝ 桌面端补丁 `v10.3` ＝ Web 端补丁 `v6` 子版本 `v6.42`；版本号以 `package.json` 为唯一权威）
>
> 来源标注规则：每条末尾写清出处（`CHANGELOG.md` 版本条目 / `DESIGN.md §节` / `README.md` 章节 / `docs/审计-2026-08-26.md` 编号 / 记忆库 lesson）。
> 只写有据可查的；仓内文档提到的细节在仓库里找不到落点时标「（待核）」；确实没遇到过的写「暂未遇到」。

---

## 一、安装与部署

### 1.1 依赖用 `file:` / `github:` → `pnpm install` 把本地修复整包回滚

- **症状**：本地改好的插件代码，跑一次 `pnpm install` 之后**全部消失**，变回远端旧版（本插件历史上真实发生过一次「整包回滚」）。
- **根因**：`file:` 目录依赖会在 install 时把源目录内容**拷进** `node_modules`，之后跑的是复制品，改动被遮蔽；`github:` / `git+https:` 每次 install 都**重新拉 tarball**，本地改动必然被覆盖。
- **解法**：profile 里写 `link:`，或 `pnpm add "link:D:/DeepSeek Harness/Works/dsh-maid-vcp"`。`link:` 只在 `node_modules` 建符号链接指向源目录，install 时只重建链接、**永不复制或覆盖源目录内容**。lockfile 里删掉远程 tarball 的 resolution/integrity 段，对齐成 `link:` 记录（`pnpm install --lockfile-only`）。
- **验证**：install 后改一处源码，刷新页面即见改动；`pnpm-lock.yaml` 的 importers 段 specifier 是完整 `link:` 路径且无 tarball 条目。
- 来源：`README.md`「本仓库是本地维护分支」；`CHANGELOG.md` 0.6.4（依赖改 `link:` 协议）。

### 1.2 桌面端打补丁把运行中的 DSH 打崩——「幽灵 SyntaxError」

- **症状**：替换 asar 内 bundle 后 DSH 连续崩溃，控制台报 `Unexpected token 'else'` 或 `Cannot use 'import.meta' outside a module`，**但盘上的代码语法完全合法**（2026-10-14 实测：`else` 连崩 4 次、`import.meta` 两次）。
- **根因**：v10.1 及以前 `replaceEntry` 重建数据区时把目标条目之后**所有 offset 整体平移**、头部按实际 JSON 长度重写——`jsonLen` 一变 `dataStart` 就移动；运行中的 Electron 仍持启动时缓存的旧头，按旧偏移取字节 → 读到错位乱码。
- **解法**：v10.2 起改**追加式写入**——新内容写到数据区末尾，只改目标条目自己的 offset/size/integrity，其余条目不动；头部**保长**（JSON 尾部补 `0x20` 空格维持 `jsonLen` → `dataStart` 不变）。极端情况先丢被替换条目的冗余 `integrity.blocks` 瘦身，仍超则抛错；必须退回重建路径时**强制要求 DSH 已退出**，否则中止不写。补丁器开跑前用 `tasklist` 探测 DSH 是否在运行并提示。
- **验证**：`node patch/install-all.cjs --dry-run` 正常；写入后回读 sha256 与磁盘源一致；`tasklist` 检测到 DSH 在跑时提示「重启后生效」而非报错。
- 来源：`CHANGELOG.md` 0.6.8 / 补丁 v10.2；`patch/asar-io.cjs`、`patch/patch-frontend-asar.cjs`。

### 1.3 「已是 v10 形态」短路——改好的 `v6-inject.js` 打不进 asar

- **症状**：改完 `patch/v6-inject.js`（比如修了注释显形），重跑 `install-all.cjs` 却报「已是 v10 形态，无需重复安装」，asar 内还是旧逻辑；`--dry-run` 也骗人。
- **根因**：`patch-frontend-asar.cjs` 里的短路判据只看 `t.includes(V6_MARK) && t.includes('window.__vcpGen')`——只证明「补丁装过」，不证明「装的是最新版」。而 v10 形态下 A/E/F 三个锚点已无法二次定位，所以旧版干脆直接 return。
- **解法**：新增 `updateInjectModule(t)`——用模块自身的 `/*__DSH_V6_INJECT_START__*/` 与 `END` 标记夹出旧模块整段，替换为磁盘最新 `patch/v6-inject.js`（`adaptInject(INJECT_SRC, true)`）；内容相同则幂等跳过。**边界**：这条路径只升级 C 项（稳定区模块），A/E/F 在 v10 形态下无法二次定位。
- **验证**：改一行 `v6-inject.js` 后重跑，dry-run 报「C v6 稳定区模块整段升级（N → M 字符）」；`patchBackend.renderBranch` 类内容与磁盘逐字一致。
- 来源：`CHANGELOG.md` 0.6.8 / v10.2；记忆库 lesson（v10 补丁器短路）。

### 1.4 幂等判据「不同物相比」→ 每次 install 多插一个换行，并掩盖真差异

- **症状**：`--dry-run` 每次都说「✓ C v6 稳定区模块整段升级（86002 → 86003 字符）」，跑十次都这样——文件在缓慢长胖。
- **根因**：`updateInjectModule()` 拿 `adaptInject(INJECT_SRC, true)`（整文件，含尾换行）去比 bundle 里 `slice(i, endIdx)` 夹出的段（不含尾换行），**两者永远不等** → 每次都在 END 后多插一个 `\n`。**危害不在那个换行，而在它掩盖了真差异**：以后 `v6-inject.js` 真更新，报的还是同一句，人就会忽略。
- **解法**（v10.2，commit `96faa54`）：先 `full.indexOf(START)` / `indexOf(END, ni)` 切出**模块本体**再比，同物相比。
- **验证**：复跑报「已是 v10 形态，v6 模块已是最新，无需重复安装」；连跑两次字符数不再变化。
- 来源：记忆库 lesson（补丁器幂等，0mv9kcj9u）；`CHANGELOG.md` 0.6.15/v10.2 段。

### 1.5 `--dry-run` 的 `applied` 列表 ≠ 已装

- **症状**：`node patch/install-all.cjs --dry-run` 输出一串 `applied` 条目，看起来「装好了」，实际前端毫无变化。
- **根因**：dry-run 在未打补丁的 asar 上会**完整执行替换计算并列出 applied 列表**，只是不写盘。它验证的是「锚点找得到」，不是「已经装上」。
- **解法**：把 dry-run 当「体检/预演」，装没装要另找判据（见 7.3：`window.__vcpStable` + `window.__vcpGen` 双标记）。
- **验证**：dry-run 后重启 DSH 刷新页面，渲染仍不生效 = 没写盘；正式跑一次后 asar 文件大小/mtime 变化且回读 sha256 一致。
- **交付判据（补记 2026-10-18）**：只复原源码 + 接回 junction + 确认 `fiberPhase=active`，**不足以宣布「插件已恢复」**——这三步只证明加载链通了，不证明补丁装上了。曾据此交付「插件已恢复」，被老大一句「VCP补丁有弄上去吗？」当场打回。宣布恢复前必须实跑 `node patch/install-all.cjs` 并确认 asar 内 `window.__vcpStable` 为真；两条缺一条就只报「源码已复原，补丁未装」。
- 来源：记忆库 lesson（0mv6n9ers）。

### 1.6 打包白名单漏 `styles/`、`examples/` → 装到别的电脑美学库直接失效

- **症状**：从 GitHub 装到新电脑，插件能用但美学检索指向不存在的目录（面板「共 0 个风格」的同类现场）。P0 级风险。
- **根因**：`package.json` 的 `files` 数组漏了 `styles/`、`examples/`、`fonts-index.txt`、`LICENSE`（当时还漏 `PROGRESS.md`）——一旦走 `dsh plugin add` 打包分发，协议里注入的 `${stylesIndex}` 路径指向空目录。
- **解法**：补全 `files`（已修，commit `a4b1656`）；发布前用 `tools/check-package.cjs` 类校验把「白名单 ↔ release 快照」同步变成自动检查。
- **验证**：装到干净环境后 `styles/_INDEX.md`、`styles/abyss-maid.md`、`examples/` 都在；美学检索能读到索引。
- 来源：`docs/审计-2026-08-26.md` P0-打包缺口（P2/P3）；`package.json` `files` 段现状。

### 1.7 「改完没生效」——三层三种生效方式，最容易在 asar 层栽

- **症状**：改了代码、刷新页面，什么都没变。
- **根因**：本插件是三层结构，生效边界各不相同——① 提示词层 / 宿主路由（`lib/index.js`）改的是插件本体与协议文本；② DOM 层（`lib/client.js`）改的是浏览器半侧；③ 补丁层（`patch/*`）改的是 asar 里的前端 bundle，而 **asar 头会被 DSH 进程缓存**。
- **解法**：
  - 改 `lib/index.js`（提示词、路由） → **重启 DSH**；
  - 改 `lib/client.js` → **浏览器硬刷新**（Ctrl+F5，`client.js?rev=…` 会重新打包）；
  - 改 `patch/` 下任何东西 → 重跑 `node patch/install-all.cjs` 后**完全退出并重启 DSH**（仅刷新页面不够）。
- **验证**：改 `client.js` 里的按钮文案，硬刷新可见；改提示词后新消息的注入内容变化；改 `v6-inject.js` 后重启，卡片行为（如注释不再显形）变化。
- 来源：`README.md`「维护 / 升级」「安装」；项目记忆（生效边界）。

### 1.8 版本号五处漂移（历史问题，已治）

- **症状**：`package.json=0.4.0`、`README=0.3.0`、`PROGRESS=0.6.0`、`CHANGELOG=0.6.0`、git tag `v0.4.0/v7.0`——五个地方五个说法（2026-08-26 审计）。
- **根因**：没有单一权威版本源，各处手工维护。
- **解法**：以 `package.json` `version` 为唯一权威，其余文档挂指针（已修，commit `a4b1656` 统一到 0.6.0）。
- **验证**：`README.md`「版本」章节只描述「以 package.json 为准」，不再自带版本数字。
- 来源：`docs/审计-2026-08-26.md` P1（P0-版本漂移）。

### 1.9 测试在新机器上跑不起来（绝对路径 / 可选依赖）

- **症状**：`tests/` 里部分 e2e 脚本跨机器即碎。
- **根因**：早期 4 份测试硬依赖绝对路径 `G:/AI/AI 助手/VCPChat-main/node_modules/jsdom`；jsdom / puppeteer 属**可选开发期依赖**，插件本体零运行时依赖。审计另指出 `patch/vcp-fast-bench.cjs` 运行时会自动下载依赖（domino）——供应链/可复现性风险。
- **解法**：依赖定位改由 `tests/_deps.cjs` 自动查找（0.6.5 引入，含多级路径回退），jsdom / puppeteer 进 `devDependencies`；新机器上跑 DOM 测试前先 `pnpm i` 装开发依赖。
- **验证**：`node tests/bundle.test.mjs`（无 DOM 依赖）应直接通过；`node tests/smoke.test.mjs`、`stable.test.mjs` 在装好 jsdom 的机器上通过。
- 来源：`docs/EVOLUTION-2026-08-24.md` §六遗留 3；`docs/审计-2026-08-26.md` S4/S2；`CHANGELOG.md` 0.6.5。

### 1.10 Web 端补丁器与桌面端有意不同步（别照着改）

- **症状**：想在 Web 端复刻桌面端的能力集，发现 `install-v6.cjs` 与 `patch-frontend-asar.cjs` 版本号、锚点、能力项都不一样。
- **根因**：**有意为之**——本机只用桌面端（Electron），Web 端补丁器不随桌面端迭代；`install-all.cjs` 会自动分流：桌面端 → `patch-frontend-asar.cjs`（v10 代际自适应）；Web 端 → `install-v6.cjs` + `update-v6-inject.cjs` + `trusted-patch.cjs`。
- **解法**：桌面端只跑 `install-all.cjs`，不要手动混跑 Web 端脚本；探测失败时把目标路径作为参数传入（`node patch/install-all.cjs "D:\...\resources\app.asar"`）。
- **验证**：dry-run 输出显示走了「桌面端（asar）」分支而非 Web 分支。
- 来源：`README.md`「安装」；项目记忆（web 端补丁器有意不同步）。

### 1.11 新环境一切卡片显示源码 —— 这一条请先看第 2.1 节

- **症状**：装机后第一条带卡片的回复，卡片里的 HTML 原样显形成一堆标签源码。
- **原因**：**不是安装失败**——是渲染开关的历史默认值问题（v6.35 三态化修复前，开关状态在旧 bundle 里可能是「关」）。
- **解法**：按 **2.1** 的三态化说明把渲染开关开到「开」，或直接跑一次补丁器让开关回到默认三态。
- **验证**：新消息里的卡片正常渲染成图形，不再显示标签源码。

### 1.12 前缀锚点抢跑 → 打出的 bundle 报 `}();();` 语法错误（2026-10-17 修复）

- **症状**：`patch-frontend.cjs` 打一条**旧态（v4/v5，即 `case"html"` 里没有 `window.__vcpStable` 调用的那代）**bundle 时，产物末尾变成 `…return n.value}();();`，`node --check` 报 `SyntaxError`；脚本自身有健康检查会回滚，所以表现为「补丁打不上、文件没变」，而不是把前端打崩。
- **根因**：替换表里并存过两个 `case"html"` 旧态锚点——`CASE_HTML_BEFORE`（完整形态，以 `}();` 收尾）与 `CASE_HTML_AFTER`（**前者的残缺副本：正文逐字节相同、唯独漏掉尾部 `}();`**）。状态机的 `else if (t.indexOf(CASE_HTML_AFTER) !== -1)` 分支排在前面，而残缺锚点恰是完整锚点的**前缀**，于是任何旧态 bundle 都被它先命中：它只吃掉了 `…return n.value}`，原文尾部残留的 `();` 与替换文本 V7 自带的 `}();` 相接 → `}();();`。（同批体检报告里最初写成 `}();}();`，实测形态是 `}();();`，两种都是语法错误，以实测为准。）
- **解法**：删掉 `CASE_HTML_AFTER` 常量定义与该状态机分支（2026-10-17 七仓体检批次）。旧态统一由 `CASE_HTML_BEFORE` 承接；若某代际形态与它不符，则命中 0 次走既有 fail-loud 中止（`exit 1`，不写盘），不会静默产出坏文件。**通用教训：替换表里的锚点若互为前缀，短的那个必然抢跑——宁可让短锚点命中 0 次报错，也不要让它悄悄吃掉长锚点的一部分。**
- **验证**：`node Works/_probe/vcp-verify-case-html.cjs` → 7 组断言全过（含「旧逻辑复现 `}();();` 并抛 SyntaxError」与「新逻辑产物语法通过」两条对照）；`node patch/check-anchors.cjs` → 10 组断言全过；`node --test tests/security.test.mjs` → 54 项断言全过。
- 来源：七仓体检报告（2026-10-17，patch-frontend.cjs:102 注释与实际不符）；`patch/patch-frontend.cjs` 删除处注释。

### 1.13 替换式补丁写 AFTER 串时吞掉声明前缀，消息树整块白屏

- **症状**：补丁装完、健康检查也过，但消息列表整块白屏——组件一渲染就 `ReferenceError`，聊天区全空，刷新无效、重启无效。2026-10-13 16:34 至 2026-10-18 14:36 期间共出现 12 次。
- **原因**：替换式前端补丁在写 `AFTER` 串时，只写了「锚点之后要追加的内容」，漏掉了锚点里原有的变量声明前缀，导致 `h` / `m` 变成未声明的自由变量。锚点字符串本身匹配成功、补丁「打上了」，但产物在组件渲染期才炸——静态锚点检查抓不到。
- **解法**：铁律——**`AFTER` 串必须完整保留 `BEFORE` 里出现的所有声明**，替换是「整体换掉」，不是「在原锚点后追加」。改锚点时先在 `BEFORE` 里逐个点名所有 `const` / `let` / 解构声明，再逐字搬到 `AFTER` 开头。
- **验证**：**未验**：本轮取证未留存原始 `ReferenceError` 报错串，也未找到改法落地后的回归记录。落盘前须补一次「装补丁 → 打开消息列表 → 有卡有文的会话各一条」的真机复验，并把报错原文补进本条。
- 来源：会话取证 `_probe/_cand-session.md:25-31`（会话 `2c414941`、`3d3bfde6`）；同族规则已写入 `AGENTS.md` 的「AFTER 必须完整保留 BEFORE 中所有声明」。

### 1.14 `ELECTRON_RUN_AS_NODE=1` 下 asar 补丁器把 app.asar 当成 asar 内路径，读写全报 ENOENT

- **症状**：桌面端补丁器在 `ELECTRON_RUN_AS_NODE=1` 的 Electron 里跑时，所有对 `app.asar` 的读写都失败，报错形如 `Error: ENOENT: no such file or directory, open '…\resources\app.asar\…'` / `not found in …\resources\app.asar`。补丁程序「什么都没做」就退出。
- **原因**：`ELECTRON_RUN_AS_NODE=1` 只让 Electron 当 Node 用，但 `require('node:fs')` 仍被 Electron 的 asar 包装接管；该包装把「宿主自己的 `app.asar`」也当成「asar 内部路径」去解析，于是在真实文件系统里去找 `app.asar\...` 这样的子路径，必然 ENOENT。
- **解法**：补丁器统一走 `patch/asar-io.cjs` 取 fs——优先 `require('node:original-fs')`（绕过 asar 包装的真 fs），拿不到再退回 `node:fs`：

  ```js
  let fs
  try { fs = require('node:original-fs') } catch { fs = require('node:fs') }
  ```

  同轮旁证：字体口径由 20 款复核为 25 款。
- **验证**：`_probe/verify-v103-in-asar.mjs` 在 `ELECTRON_RUN_AS_NODE=1` 下 8/8 通过（仓内记录），另四支探针同轮通过（`vcp-inlinecode-v103` 14/14 等）。**未验**：真实 `install-all.cjs` 全流程在「asar 已被打过旧补丁」的机器上复测。
- 来源：git `fda5bbc`、`c7f5083`（2026-10-18，CHANGELOG 记 v0.6.15，版本号以仓内 CHANGELOG 为准）；改动文件 `patch/asar-io.cjs`。
- **与 preset 册 6.16 的关系**：同一根因（Electron 的 asar 包装把宿主 `app.asar` 当归档内路径），但证据不重叠——6.16 记的是**读取**这一侧、验证只到「阅读实现确认分支存在」；本条记的是**补丁器在 `ELECTRON_RUN_AS_NODE=1` 下的读写**，带提交号与 8/8 探针结果。两册读者各自在册内能查到手边那一半，故不合并成一条。

### 1.15 强制刷新触发 loader 把 fiber 卸载误判成「用户禁用」，此后 boot 审计弹 `import failed`

- **症状**：桌面端强制刷新（或在该页反复重载）后插件不再加载，启动阶段弹出审计错误，文案形如 `${id}: import failed`；重装/重启都不恢复，只能改回宿主原始 asar。2026-10-15 23:57 至 2026-10-18 15:05 共出现 10 次。
- **原因**：渲染侧 loader 的卸载监听把「fiber 卸载」误判成「用户手动禁用插件」，往 `entry.disabled` 写入禁用标记；重建闸门 `async refresh(){ this.fiber || this.disabled || await this.init() }` 因此永久短路，`init()` 再也不跑。boot 审计拿不到模块就抛错弹窗——弹窗文案只说 import 失败，指向不到 disabled 标记。
- **解法**：**根因未证实（待核：卸载事件与「用户禁用」的区分判据尚未定案）**。当前只做了绕过——用 asar 补丁把 boot 审计里的 `throw` 改成 `console.error`，让弹窗消失、页面能用；`entry.disabled` 被误写的机制仍在。
- **验证**：**未验**：绕过方式无回归记录（改完只是不再弹窗，插件是否恢复加载未实测）。复现判据：强制刷新数次 → 看 `entry.disabled` 是否变 true → 手动清零后能否恢复。
- 来源：会话取证 `_probe/_cand-session.md:273-279`（会话 `D-DeepSeek~0020Harness-Works/session-`、`2c414941`）。

### 1.16 本地仓没有 `.git` 就直接对远端：双向分叉 + 乱码文件名，两边同版本号却不是同一份

- **症状**：本地工作副本与远端都标 v0.6.14，但两边 MD5 不同；直接「本地覆盖远端」会丢掉远端独有文件，直接「远端覆盖本地」会丢掉本地 5 处领先改动。远端还多出 5 个文件名是乱码的字体文件，安装后字体菜单里显示成一串问号。
- **原因**：本地工作副本无 `.git`（一直靠文件拷贝同步），比对只能靠人眼/哈希，分叉无人记账；且文件曾经过 UTF-8 → GBK 二次解码，名字被破坏（编码问题本身见 §4.9）。被 `.gitignore` 的 `_probe/` 目录在真做 `git add` 时需要 `add -f` 才会被带上——这条也容易漏。
- **解法**：接手时先做三件事再动手——①`git -C <远端副本> log --oneline -1` 记下 HEAD（当时为 `4652fb8`）；②逐文件 MD5 比对，把「仅远端有」「仅本地有」「两份都有但不同」三类列成表；③乱码文件名的 5 个字体按原名重下，别在乱码名上改。
- **验证**：已核：远端 HEAD `4652fb8`、远端多 6 个文件（5 款字体共 14.76MB + `examples/情书·春水笺.html`）、本地多 5 处改动 + 5 个 `_probe`（需 `add -f`）、两边版本号同为 v0.6.14 但 MD5 不同。
- 来源：记忆 `0mvdv7157-c70256daf13b49f6ac43907684`（topic / dsh-maid-vcp）。

---

## 二、卡片渲染问题（HTML 不渲染 / 显示源码 / 样式丢失 / 流式中断）

### 2.1 一切 VCP 卡都显示成源码（新环境 / 换电脑 / 清过缓存后最常见）

- **症状**：卡片结构、配对、内容全部合规，却整块显示为代码文本或源码；`case"html"` 与 `case"code"` 两条分支都不渲染。
- **根因**：`dsh.rawHtml` 开关**只有读取端与写入端，从未被初始化**——渲染判定是 `=== '1'`，而 `undefined`（没点过按钮 / 新环境 / 清过 localStorage）被当成「关闭」。（这就是「AI 守规矩也掉格式」的真凶，2026-08-29 上架申请书卡实测翻 bundle 落网。）
- **解法**：补丁 v6.35 把两处判定从 `==="1"` 升级为 **`!=="0"` 三态化**（`undefined`=默认开、`"1"`=开、`"0"`=显式关闭）；`v6-inject.js` 启动自检在 `dsh.rawHtml` 为 `null` 时自动落盘 `"1"` 并 `console.debug` 提示（只补从未设置，绝不覆盖显式选择）；`lib/client.js` 的 `isRenderEnabled()` 同步三态化，按钮显示与渲染器判定一致。
- **验证**：DevTools 执行 `localStorage.getItem('dsh.rawHtml')`，未设置时应为 `null` 且卡片正常渲染；显式设 `'0'` 后刷新 → 显示源码且 console 有 `warn` 说明原因。
- 来源：`CHANGELOG.md` 0.6.0 / 补丁 v6.35。

### 2.2 卡片被 ```html 围栏包住时显示源码

- **症状**：模型把整个 `#vcp-root` 卡片塞进 ` ```html ` 代码围栏，页面显示成代码块。
- **根因**：围栏内容走 `case"code"` 分支，早期只认「内容**以** `<div id="vcp-root"` 开头」（`^` 锚定）。卡片前多一行说明或一行朗读标记，判据即失配 → 整卡退回源码。
- **解法**：补丁 v10.3 去掉 `^` 锚定，判据改为「**含** `<div id="vcp-root"`」；`install-v6.cjs` 侧同步补 v6.30→v6.35 状态机（`CODE_CASE_RAW/V1/V2→V3`，vcp-root 白名单 + 三态化），普通代码块不误伤。
- **验证**：写一条「说明文字 + 空行 + ```html 围栏卡片」，应正常渲染；写一条普通 ` ```js ` 代码块，应仍以代码块显示。
- 来源：`CHANGELOG.md` 0.6.14 / v10.3、0.6.2（围栏兜底）；`DESIGN.md §4` 第 13 条 v10.3 段。

### 2.3 卡片前面溢出大量代码 / 卡片整段当纯文本吐出

- **症状**：正文下方先吐出一堆 HTML 源码（背景色、标签全露），随后卡片才（或永不）成型。
- **根因**：卡片 HTML 与前文之间**只隔一个换行**——markdown 把「前置文字 + 超长开标签」并进同一段落，流式解析期整段按纯文本吐出。这是 `CommonMark` 块级标签不能打断段落的规则（type 6）。
- **解法**：**卡前必有空行、卡内绝无空行**。卡片 HTML 必须与前文之间留一个空行独立成块。
- **验证**：同款卡片，前面留空行 → 正常；前面只留单换行 → 复现溢出（2026-08-28 雨柬卡实测对照）。
- 来源：`DESIGN.md §4` 铁律 1（外空行、内无空行）；`README.md` 常见坑节。

### 2.4 深蓝背景只包顶部一条横框，下方内容没有背景

- **症状**：卡片背景只包住顶部一条，其余内容全部溢出到背景外面，看着像「一张小卡片 + 一堆散字」。
- **根因**：markdown 的 HTML 块**遇到空行（`\n\n`）即结束**——`#vcp-root` 内出现连续两个换行，卡片被解析成多个独立节点，开头部分被 DOMParser 自动补全成一个只有顶部背景的小卡。
- **解法**：vcp-root 内所有子元素用**单个换行或单行**排列；需要视觉分组用 `margin` 而不是空行；落盘后检查卡片字符串里 `\n\n` 出现次数为 0。渲染侧另有 `fixVcpBlank` 自愈（v6.37 补空行 / v6.38 压缩卡内空行），但**自己写对更稳**。
- **验证**：`node -e` 统计卡片字符串 `\n\n` 次数为 0；页面上背景完整包住内容。
- 来源：`README.md`「常见坑：vcp-root 内部禁止空行」（2026-08-19 实测）；`CHANGELOG.md` 0.6.0（v6.37/v6.38）。

### 2.5 卡片渲染正常，卡片后的 Markdown 变源码（表格成裸竖线、`**加粗**` 显示星号）

- **症状**：卡片本身没问题，紧跟其后的 Markdown 表格/加粗/列表全部按源码显示。
- **根因**：两层——① `fixVcpBlank` 旧正则 `(<div id="vcp-root"[^>]*>)([\s\S]*)$` **无右边界**，把「卡片 → 空行 → Markdown」的分界空行一并压掉，Markdown 被并进 HTML 块；② 宿主 Markdown 的 HTML 块内部本就不解析 Markdown。
- **解法**：补丁 **v6.39** 自愈——`findRootClose` 定位根容器闭合点，空行压缩**只在容器内生效**，闭合处补回分界空行。历史上因此下过的「一条消息只允许一种格式」戒严令随之**废除**。
- **验证**：混排用例（卡片 + 表格 + 加粗 + 列表）线上实测全绿（2026-10-14）；`tests/stable.test.mjs` 相关断言通过。
- **现行建议（非铁律）**：说明文字优先写进卡内（`<div>`/`<p>`/`<span>`）——流式中间帧容器未闭合时会退回旧行为、闭合那一帧会有一次重排；确需混排就保留分界空行。
- 来源：`DESIGN.md §4` 第 12 条；`README.md`「格式混排已解禁」。

### 2.6 卡片不流式，一次性整卡展开

- **症状**：别的消息一行行长出来，VCP 卡「唰」地整块出现，流式感全无。
- **根因**：渲染引擎的容器模式要求「`#vcp-root` 开标签后紧贴首元素」；开标签后换行（子块前出现裸文本）会把内容归入 tail、内层永不固化；`<style>` 若前置，tail 对未闭合 style 截断其后全部内容（2026-08-21 流式诊断）。
- **解法**（不动引擎，改写法）：① 开标签后**紧贴**首元素，勿换行/空格；② `<style>` 写在 `#vcp-root` 开标签后、内容之前（**注意**：这与「style 沉卡尾」的个别历史说法冲突，现行权威是 `DESIGN.md §4` 铁律 4——style 紧贴开标签）；③ 子块间少换行、不出现空行。
- **验证**：长卡在流式过程中应逐段出现，而非最后一帧整体展开。
- 来源：`CHANGELOG.md` 0.6.0 段（流式诊断 2026-08-21）；`DESIGN.md §4` 铁律 4。

### 2.7 卡片前溢出整段 CSS / 卡片反复闪动

- **症状**：卡片前方吐出一大坨 CSS 文本，或者卡片生成过程中反复闪动重画。
- **根因**：**把整个 `<style>` 压成几千字符的超长单行**——流式渲染期间超长行会被当纯文本吐出/解析错乱（2026-08-28 晚报卡实测）。
- **解法**：`<style>` 内**每条规则独立一行、规则短小**（`#vcp-root .note{display:inline-block;font-size:10px}`），行间无空行。「无空行」≠「压成超长单行」——这是两种完全不同的写法。
- **验证**：同日「混沌嵌套测试」卡内满是无限循环动画仍稳定渲染，反证动画无罪、病根在 style 单行；改回多行逐条后稳定。
- 来源：`DESIGN.md §4` 铁律 6 之补充分支；`DESIGN.md §3` 落盘勾选。

### 2.8 流式期间卡片位置长时间空白（开标签太长）

- **症状**：卡片刚开头的那一段先是空白，过一会儿才出现背景与内容。
- **根因**：**开标签长度 = 流式空窗期**——几百字符的 `background-image` 内联进开标签，流式早期整段空白，背景要等开标签写完才出现。
- **解法**：开标签只放**短关键值**（背景色 / 字色 / 字体族 / 字号），长样式（多层渐变、圆角、内边距、行高、字距、布局）全部进 `<style>` 的 `#vcp-root` 规则。
- **验证**：实测 700 字符开标签空窗 **29 帧**，压到 130 字符后仅 **6 帧**（2026-08-27 实测）。
- 来源：`DESIGN.md §4` 铁律 6。

### 2.9 写进 `<style>` 的渐变「写了也白写」

- **症状**：卡片里 `<style>` 明明写了 `background:linear-gradient(...)`，页面上却一直是平色底。
- **根因**：开标签内联了平色 `background`，以**内联优先级永远压住** `<style>` 里的渐变——「平色兜底」与「style 渐变」不可并存。
- **解法**：二选一——① 渐变**直接内联开标签**（多层渐变 + 天光叠加全内联，必显）；② 开标签**完全不写 background**，渐变全放 `<style>`（流式早期由 `finalizeRoot` 浅纸底兜底，style 输出后渐变接管）。**严禁「平色内联 + 渐变 style」组合**。
- **验证**：改完刷新，渐变应可见；DevTools 看元素 computed background 是渐变而非平色。
- 来源：`DESIGN.md §4` 铁律 6 勘误补充（2026-08-28 背景渐变排查三轮定位）。

### 2.10 HTML 注释显形（卡片下方挂一行 `<!--tts:…-->`）

- **症状**：卡片底下明晃晃一行 `<!--tts:老大，……-->`，尖括号都在。注释本是给工具读的（TTS 朗读摘要 / 渲染层指令）。
- **根因**：注释节点经 `DOMParser` 变成 comment，交给 vdom 转换时被转成**带尖括号的文本**渲染出来。而修复位置一错再错：
  - **v6.40（无效）**：`stripHtmlComments()` 挂在 `parseFrag`——但 `<!--tts:…-->` 前后有空行时，CommonMark 把它切成**独立的注释块**单独交给 `render`，处理链走完 `v` 已是空串，`if (!v) return null` **在 `parseFrag` 之前就短路**，剥注释轮不到，返 `null` → 宿主退回原文 → 照样显形。
  - **v6.41（生效）**：钩子提到 `render` **入口**（`var src = stripHtmlComments(raw || '')`），且**剥完为空时返回空 Fragment 而非 `null`**——`null` 语义是「我不渲染」（宿主退回原文），空 Fragment 是「渲染成空」。判据 `src.trim() === '' && (raw||'').trim() !== ''`，真空消息与「有内容但被清空」仍返 `null`，不吞内容。
  - **v10.3（补分支漏网）**：标记被反引号包成 `` `<!--tts:…-->` `` 时走 `case"inlineCode"` 分支渲染成 `<code>`，注释照旧显形——补 `buildInlineCodeGuard` 极窄守卫（只有「原文以 `<!--` 开头且剥完为空 / 仍以 `<!--` 开头」才拦截），普通行内代码零影响。
- **解法**：三层都装到（asar 重跑 `install-all.cjs`，重启 DSH）；正文侧仍建议标记**裸写、独占一行、绝不加反引号**。
- **验证**：`_probe/vcp-comment-v641-probe.mjs`（9 用例）、`_probe/vcp-comment-v642-probe.mjs`（13 用例）——从源码正则抠出**真实**的 `stripHtmlComments` 与 `render` 在 vm 里跑，不抄源码；重启后发一条带完整注释的消息，页面不留痕。**用例数与原记录不同**：`_probe/` 目录曾整目录丢失（文档里的引用一度全是悬空路径），2026-10-18 按原设计重建，v642 补了三条残缺标记边界用例，故 10 → 13。
- 来源：`DESIGN.md §4` 第 13 条；`README.md`「常见坑：HTML 注释会显形」。

### 2.11 正文与卡片一起消失，界面只剩「已完成，用时 N 秒」

- **症状**：整条回复几乎空白，卡片、正文全无；与此同时 TTS 照旧念原文。
- **根因**：朗读标记写残（结尾只剩 `--`，或写成 `了。>`）时，v6.41 对**未闭合** `<!--` 的处理是**无条件**截断到消息末尾（本意护住流式中间帧）——那一刀从残缺标记处切到结尾，正文与卡片一起被剥光，`render` 走「原文有东西、剥完没东西」分支返回空 Fragment → 界面空白（2026-10-15 先生连遇两次）。
- **解法**：v6.42 给 `stripHtmlComments` 加 `lenient` 参数，`render` 入口传 `true`——宽容模式遇到未闭合 `<!--` **只吃掉它所在的整行**（含行尾换行；标记协议上独占一行，删整行才不会把两侧正文粘成一行）再继续扫，行尾没换行时仍吃到末尾；`lenient !== true` 的老调用点（流式中间帧）保留原截断行为。配套 TTS 侧（`dsh-maid-tts-fix` 0.6.3）放宽认**行尾/文末**的 `--` 或 `>`。
- **验证**：v6.42 探针 10 用例（含三条残缺标记场景，直接用真实事故原文当输入）；发一条「正文 + 残缺标记」消息，正文必须完整留下。
- 来源：`CHANGELOG.md` 0.6.13 / v6.42；`DESIGN.md §4` 第 13 条 v6.42 段。

### 2.12 正文里写了字面标签名，正文从那里起整段消失

- **症状**：模型在正文里用反引号写 `` `<script>` `` 讲机制，输出后**正文从该处起全部消失**（2026-08-29 弹球演示实测）。
- **根因**：反引号被主 markdown 渲染器转成**字面开标签文本**（未闭合），VCP 扫描器把它当未闭合的 script 开标签，触发防御性截断（script 内容转 `\u0000` 丢弃 + 「其后没有闭合标签」防御）。安全机制宁可误伤不放过。
- **解法**：**消息正文（卡片 HTML 之外的所有文字）禁止出现字面标签名**——需要提及标签时写 HTML 实体 `` `&lt;script&gt;` ``（代码 span 内实体不解析、显示为字面）或中文描述（「script 标签」「脚本标签」）。与卡片内真实 `<script>`（可信模式演示）不冲突。
- **验证**：同一条消息改实体后正文完整显示。
- 来源：`CHANGELOG.md` 0.6.2.1 / 补丁 v7.2.1（正文标签名截断事故）。

### 2.13 卡片渲染成整块直角深蓝空块

- **症状**：卡片只剩一块直的深蓝色矩形，`border-radius` 与子元素全无，左上角一枚错位碎片。
- **根因（未定案）**：已排除 v6.39 `fixVcpBlank` 改坏（对真实卡片样本零操作、asar 内与磁盘逐函数全等）、asar 替换夹带污染（新旧段只差 `findRootClose` 与 v6.39 标记）、主题 CSS 抢类名（maid-atelier 全局 CSS 全以 `body[data-dsh-maid-atelier]` 打头，无裸类选择器）、素材 404 连锁。2026-10-13 23:57 **重启后不再复现**。
- **解法（若再冒头）**：切入 `vendor/maid-atelier/client.js` 的 `installMaidCustomization`（@:1272）与 `releaseClaimedStyles`（@:2129，apply 里挂在 disposer 上），怀疑点是「style 节点被回收 / HMR 重载时旧卡片样式被清」。
- **验证**：复现时先抓「同一 rev 的 bundle + 同一条消息」做对照，重启后是否消失是关键判据。**（待核）**
- 来源：记忆库 topic（深蓝空块，0mv6v6bqf）。

### 2.14 消息里的 HTML 根本不进渲染器（历史问题）

- **症状**：v6.37 之前，消息主体里的 HTML 一律被官方策略当**源码文本**显示。
- **根因**：真正渲染消息主体的是 primitives 层的 `MarkdownText`（bundle 内 `case"html": return node.value` 直接把值当文本），bundle 里另一个疑似渲染器只服务 web search 块；VCP 补丁此前够不着这条链。
- **解法**：0.6.0 起把消息主体渲染器接入 VCP（`case"html"` / `case"code"` / `case"inlineCode"` 三分支挂钩子）。
- **验证**：开启渲染后新消息里的 `#vcp-root` 直接成界面；`lib/client.js` 的 MutationObserver 只能管面板按钮，**够不着 Markdown→React 转换链**——出问题要去 asar 层找。
- 来源：`README.md`「近期更新 v0.6.0」；项目记忆（三层结构）。

### 2.15 代码块里的标签「露出来」

- **症状**：`<pre><code>` 里写示例标签，页面把它们当真实标签解析、布局错乱。
- **根因**：代码实体未先转义就进渲染链。
- **解法**：`protectCodeEntities`（v6.36 起）把 code 内实体转义成 `&lt;!--` 一类，代码块里照常显示示例文本——注释示例、SVG 示例都受它保护。
- **验证**：在卡片里写一段含 `<div>` 的示例代码，页面应显示字面文本。
- 来源：`DESIGN.md §4` 第 13 条附带说明；`CHANGELOG.md` 0.6.0（v6.36）。

### 2.16 卡片念出来是 CSS（渲染正常、语音念一堆样式）

- **症状**：卡片显示完全正常，一点朗读按钮却先念出 `#vcp-root{...}`、`background:linear-gradient(...)`、`display:flex` 一大段样式，正文被拖到很后面。
- **根因**：朗读侧取的是 `messageText` 原文，而 VCP 卡片的样式本来就写在 `<style>` 里（这是协议要求，不是错写）。渲染层按 HTML 解释它、不显示；朗读层把它当纯文本念。病根在朗读侧缺一个 `stripTtsStyleBlocks()` 步骤，不在卡片的写法。
- **解法**：卡片照常写 `<style>`，不要为了朗读去改写成内联或删样式（会踩 §2.8 长开标签空白）。真正的修复在 tts-fix 侧——见 `dsh-maid-tts-fix/TROUBLESHOOTING.md` **2.1**。VCP 侧能配合的只有一条：**可见正文别藏在 `<style>`、注释或 `display:none` 里**，否则剥完样式就什么都不剩。
- **验证**：一张带 `<style>` 的卡上点朗读，念出的第一句应是你写的第一句正文，不是 `{` 或 `#vcp-root`。
- 来源：跨仓接缝问题，记录于 tts-fix 事故单 2.1；本条只做指引。

### 2.17 只念重点：`<!--tts:要念的那段-->` 标记

- **症状**：整段正文太长，想只念其中一两句；或反过来，写了标记却照旧念全文（甚至标记本身被念出来）。
- **根因**：标记必须**裸写、独占一行、收尾写全 `-->`**。写进行内代码（反引号）会走宿主 `case "inlineCode"` 分支，尖括号原样显形（呼应 §2.10）；写残 `-->` 在渲染侧 v6.41 曾把整条正文剥光（见 §2.11），tts-fix 0.6.3 起虽能容错念对，渲染侧仍要写全。标记提取必须挂在 `messageText` 清洗**之前**，挂下游就等于没挂。
- **解法**：每条回复正文最前写一行 `<!--tts:要念的那段-->`，裸写不加任何包裹；不带标记时靠 profile 的 `readScope=first-segment` 只念首段（约 160 字），绝不念全文。完整机制见 `dsh-maid-tts-fix/TROUBLESHOOTING.md` **2.2 / 2.3 / 2.4**。
- **验证**：写一条带标记的卡片回复，点朗读只念标记内文字；页面上看不到标记本身（注释不渲染），正文也不该被吞。
- 来源：tts-fix 事故单 2.2–2.5；VCP 侧 v6.42+ 配套「注释不显形 + 未闭合注释不吞正文」。

### 2.18 忘了写标记也不该念卡片：`stripTtsCards()` 兜底

- **症状**：卡片在前、正文在后，漏写 `<!--tts:…-->`，一按朗读念出来的是卡片上的字（标题、按钮文字、装饰文案），而不是正文。
- **根因**：`readScope=first-segment` 的首段兜底取的是「清洗后文本的头 160 字」；卡片可见文字正好排在前面，于是首段＝卡片。这是兜底策略的必然结果，不是渲染错。
- **解法**：tts-fix **0.6.5** 起在 `removeTtsMarkup` 入口、`stripTtsStyleBlocks` 之前挂了 `stripTtsCards(value)`，把 `id="vcp-root"` 开标签到配平 `</div>` 的整块剥掉；三条边界是有意的——剥完 `trim()` 为空则原样返回、未闭合卡片（流式中间帧）不动、卡片在末尾时正文保留。`lib/selfcheck.js` 有 4 条 `APPLIED_MARKERS` 对应（`function stripTtsCards(value) {`、`let text = stripTtsCards(stripTtsStyleBlocks(` 各 @text/@client）。**但这是保险不是替代**：仍应正常写标记。
- **验证**：故意写一条「卡片 + 正文、无标记」，点朗读念出的应是正文首段，卡片文字一句都不该出现。
- 来源：tts-fix `lib/edits-v309.js:57-90`、`lib/selfcheck.js:62-65`；tts-fix 事故单 2.10。

---

## 三、样式作用域与皮肤冲突

### 3.1 离开页面再回来，卡片整卡掉格式（「离页重挂载后掉格式」）

- **症状**：刚渲染时一切正常，切走再切回（消息列表重挂载）后卡片样式全崩（掉底色、掉字号、掉圆角）。
- **根因**：根容器用了 `class="vcp-root"` 或自定义根类名（如 `.rain-card`）。渲染层 `scopeVcp` **只认 `id="vcp-root"`**，为每条消息分配唯一 id `vcp-msg-N` 并把消息内 `#vcp-root` 选择器替换为 `#vcp-msg-N`（v6.12 消息级隔离）。用类名等于样式是**全局规则、不锁定本消息**，重挂载时层叠/注入时序一变就整卡掉格式（2026-08-27 实测）。
- **解法**：根容器**必须** `<div id="vcp-root">`；所有样式选择器一律以 `#vcp-root` 前缀书写。
- **验证**：DevTools 里卡片根元素 id 应为 `vcp-msg-N` 形态；消息区滚出视口再滚回，样式不变。
- 来源：`DESIGN.md §4` 铁律 6；项目记忆（scopeVcp / v6.12）。

### 3.2 字号、字体被皮肤静默压回默认

- **症状**：卡片里写了字号/字体，页面上没生效或明显变小。
- **根因**：maid-atelier 一类皮肤注入带 `!important` 的全局字体/字号覆盖（特异性 **(0,2,0)**）。渲染器 boost 只给 `<style>` 里的文字声明**加 `!important`，不改选择器特异性**——裸类选择器（`.num{font-size:86px!important}`）特异性仍是 (0,1,0)，被皮肤 (0,2,0)!important 反压（`!important` 之间**比特异性**）。
- **解法**：① 所有类选择器带 `#vcp-root` 前缀（scopeVcp 替换后 (1,1,0) 胜出）；② 关键字号/字体**直接内联在元素 `style` 上**（`parseOpen` ref 锁定 → 内联 `!important`，最高优先级，任何皮肤都压不住）；③ 极端情况用 `transform:scale(1.3~1.5)` + `transform-origin:left center` 兜底，书法细体配 `text-shadow` 增重；④ 或给元素加 `data-skin-chrome` 属性绕开皮肤。
- **验证**：DevTools computed 面板看 `font-size` / `font-family` 是否被划掉（皮肤规则生效痕迹）；加前缀或内联后恢复正常。
- 来源：`DESIGN.md §0.3`（皮肤覆盖对抗）；`DESIGN.md §4` 铁律 7。

### 3.3 「强调词显小」——没声明字号的 span 被皮肤吃掉

- **症状**：卡里加粗/强调的短词比周围文字还小。
- **根因**（真根因，非字面率）：皮肤的 `textRule` 同时注入 `font-size` 与 `font-family`（均 `!important`）。自己声明了字号的元素（`.t{font-size:19px}`）boost 后 (1,1,0)!important 能保住；但**没写 `font-size` 的强调词只有继承值——继承输给直接作用在元素上的皮肤规则** → 被压成皮肤字号。
- **解法**：渲染器自愈层（v6.33d）把 `font-family` / `font-size` / `font-weight` / `font-style` / `line-height` / `letter-spacing` 按属性锁 `inherit`（仅覆盖未显式声明的属性；`color` / `text-align` 不锁——颜色是设计、对齐是布局）。**AI 侧铁律不变：关键文字属性尽量显式声明**（自己声明 → boost 保护 → 稳赢皮肤）。
- **验证**：卡片里强调词与正文字号一致；未声明字号的 span 在皮肤下不再缩小。
- 来源：`DESIGN.md §0.3` 实测补充（2026-08-25 晚报卡四连问）。

### 3.4 右下角悬浮徽章与别的插件撞位

- **症状**：换机器安装后，右下角那个位置变成「聊天背景面板按钮」，或两个按钮叠在一起。
- **根因**：可信模式盾锁徽章 `fixed right:14px;bottom:14px;z-index:900` 与 `dsh-video-skin` 的悬浮圆钮 `#dsvs-knobs-pill`（right:16px / bottom:16px / z-index:900）**几乎完全同位**。
- **解法**：v7.3 起徽章**默认不挂载**（`badgeRequested` 门控）——需要时在 DevTools 执行 `localStorage.setItem('raw-html.trustedBadge','1')` 再刷新唤出。可信模式本身默认开启，不需要徽章。
- **验证**：新装环境右下角无本插件徽章；`localStorage.getItem('raw-html.trustedBadge')` 为 `null`。
- 来源：`README.md`「可信模式」；`CHANGELOG.md` 0.6.3 / v7.3。

### 3.5 面板按钮 hover 变白底白字

- **症状**：鼠标移到「</>」面板按钮/开关上，按钮变成白底白字，一片糊。
- **根因**：上游用 `--dsw-alias-button-primary-fill` 做 hover 底色，**暗色主题下近白**，字色没跟着变。
- **解法**：本地修复把 7 处 hover 改为 `--dsw-alias-interactive-bg-hover-accent`，字色回 `--dsw-alias-label-primary`（上游没有此修复）。
- **验证**：深浅两套主题下 hover 都清晰可读。
- 来源：`README.md` 本地维护分支修复表；`lib/client.js`。

### 3.6 后一张卡片的样式污染前一张

- **症状**：新卡渲染后，之前的历史卡片样式被改（类名相同、规则泄漏）。
- **根因**：消息级样式未隔离，`#vcp-root` 规则作用到所有消息。
- **解法**：v6.12 起 `scopeVcp` 做**消息级作用域化**——每条消息分配 `vcp-msg-N`，消息内 `#vcp-root` 选择器全部替换为 `#vcp-msg-N`。
- **验证**：DevTools 检查两条卡片的样式规则选择器分别带不同 `#vcp-msg-N` 前缀。
- 来源：`DESIGN.md §4` 铁律 6；`docs/EVOLUTION-2026-08-24.md` §三.1。

---

## 四、字体与素材加载

### 4.1 `Lanxi-*` 字体始终不生效（一）：connection 未就绪 + 重试同一把坏钥匙

- **症状**：重启 DSH 后字体仍是黑体/正楷；puppeteer 实测 `fontHostExists=true` 但 `fontRuleCount=0`（容器在、`@font-face` 一条没注入）。
- **根因**：`ensureGlobalFonts` 在插件 `apply()` 瞬间被调用，此时 `ctx.get('connection')` 可能尚未注册 → `hostRpc` 为 `null` → `aesRpc` 一律 `resolve(null)`。v1 的重试逻辑**重试 5 次重试的是同一把坏钥匙**（每次都用那个 null 的模块级 `hostRpc`）。
- **解法**：v2 改为 `ensureGlobalFonts(ctx, attempts)` **每次尝试都重新 `makeHostRpc(ctx)`**，connection 一就绪即拿到真 RPC → `list-fonts` 成功 → 注入；并加 `console.debug` 输出注入条数/失败原因便于取证。
- **验证**：console 出现 `注入 @font-face N 条（已装 M/39）` 且 `M > 0`。
- 来源：`CHANGELOG.md` 0.6.0 段（2026-08-27 `ensureGlobalFonts` 重试修复）。

### 4.2 `Lanxi-*` 字体始终不生效（二）：「已装 0/39」

- **症状**：RPC 通了、拿到 39 个别名，但 `installed` 全 `false`，仍注入 0 条。
- **根因**：`fontExists`（`lib/index.js`）调 `fs.statSync(file)`，而该文件 `import { promises as fs } from 'node:fs'` **只有 promise API，`fs.statSync` 是 `undefined`** → `TypeError: fs.statSync is not a function` 被 try/catch 吞掉 → 遍历所有字体根都判「文件不存在」。与历史上 create-style 的 `fs.existsSync is not a function` 同款坑。
- **解法**：`import { promises as fs, statSync } from 'node:fs'`，`fontExists` 改用 `statSync(file)`；并 grep 全文件确认无其他同步 fs 调用残留。
- **验证**：console 日志 `已装 M/39` 且 `M > 0`；卡片里用 `Lanxi-朗宋` 标题正常显示。
- 来源：`CHANGELOG.md` 0.6.0 段（2026-08-27 `fontExists` 终案）。

### 4.3 某款字体装了却始终显示黑体（glyf 表长度异常）

- **症状**：`Lanxi-秀英体` 一直显示黑体，其余字体正常（先生实测「只有丫丫体正常」）。
- **根因**：字体文件**表目录声明的 `glyf`/`hmtx` 长度与实际数据不符**——fontTools 编译时报 `too much 'glyf' table data: expected 3841586, received 3841627 bytes`（多 41 字节）。Chrome 类浏览器对字体表长度校验极严，解析失败即拒收；fontTools 宽松加载故未发现。排查链：HTTP 200 ✓ → 文件内部名「汉仪秀英体」（HYy1gj）✓ → 三种 URL/family 变体隔离实验全黑、丫丫体基线正常 → 锁定文件本身。
- **解法**：用 fontTools 重建整份字体（保留全部字符，glyf 长度精确重建），部署为 `少女风/汉仪秀英体简-v2.ttf`（原文件保留）。**经验入档：外置字体入库前先用 fontTools 编译校验表长度，防「fontTools 能读、浏览器拒收」的暗雷。**
- **验证**：Edge headless 实测 `document.fonts` 里该字体 `status=loaded`。
- 来源：`CHANGELOG.md` 0.6.0 段（2026-08-29 秀英体）。

### 4.4 首屏白字几秒（FOIT）

- **症状**：首次用到 `Lanxi-*` 字体（TTF 0.5~6.5MB）时，文字不可见数秒后才出现。
- **根因**：`ensureGlobalFonts` / `aesEnsureFontFace` 注入的 `@font-face` 规则**缺 `font-display`**，浏览器走 FOIT（等下载期间文本不可见）。
- **解法**：注入时补 `font-display:swap`（先用系统字体、加载完切换）。
- **验证**：DevTools Network 节流到慢速，首次渲染应立刻可见文字（回退字体），字体下载完再切换。
- 来源：`CHANGELOG.md` 0.6.0 段（2026-08-27 修复 B）。

### 4.5 字体菜单打开就吃掉 200MB

- **症状**：打开字体选择面板后内存暴涨。
- **根因**：`aesFontCategory` 的 `buildMenu` 对 `I:\字体` 做**全量预加载**——实测 33 款已装字体共 **213.9MB**（狂派手书 42.8MB / 游龙篆书 22.9MB / 爱情手写 12MB 等，>3MB 的 24 款），且**内存驻留到页面刷新**。
- **解法**：去掉全量预加载，改 **IntersectionObserver 滚动懒加载**（root=菜单滚动容器 + `rootMargin` 60px 提前预载），内存降到「只看过的字体」；菜单每次重建 disconnect 旧观察器再重新 observe；无 IntersectionObserver 的旧浏览器降级为原行为。同页面会话内已加载字体驻留 `document.fonts`，再次打开零下载；刷新后走 HTTP 磁盘缓存。
- **验证**：打开菜单首屏 6~8 项，内存只涨几十 MB；滚动时才见新字体请求。
- 来源：`CHANGELOG.md` 0.6.0 段（2026-08-27 字体菜单懒加载）。

### 4.6 卡片图片只剩「碎图图标 + alt 文字」

- **症状**：卡片结构、文字、样式全正常，**每张图只剩一个碎图图标 + alt 文字**。
- **根因**：渲染层 `allowSrc` 白名单放行 `https?:` / `data:image/` / `/` / `#`——所以外链**不会被剥**；但桌面端 GUI 页面跑在自定义协议 `dsh-app://app/` 下、**完全禁网**，外链资源一律静默失败（不报 CSP，只是取不到）。两条死路：① `file:///D:/...` → 被 `allowSrc` 直接剥掉 `src`；② `http(s)://` 外链 → 白名单放行但壳内取不到。`data:image` base64 虽放行，几张 1024² 图就撑爆单条输出。
- **解法**：图片 `src` 只写**同源相对路径**，如 `/comfyui/media?file=<文件名>&subfolder=<子目录>&type=output|input`（由 `dsh-maid-comfyui` 提供，流式转发 ComfyUI `/view`，带 `accept-ranges`/206）。注意**本插件自身没有图片托管路由**——只注册 `/fonts` 与 `/vendor`，MIME 白名单都不含图片扩展名。
- **验证**：`/comfyui/media` 实测 6 张 1024² PNG 全 200、1.3–2.0 MB、`image/png`；排查套路＝先用 `node:http` 裸探 `127.0.0.1:19387` 上同一路由确认字节可达（根路径 `/` 返回 **401 是认证墙**，插件路由不需要认证，别被误导），再改卡片路径。
- 来源：`DESIGN.md §4` 第 11 条；`README.md`「卡片图片必须走同源相对路径」（0.6.10 / commit `2f38c96`）；记忆库 lesson（0mv881zhe）。

### 4.7 外置字体大库在新电脑上不存在

- **症状**：换机器后 `Lanxi-*` 部分字体（外置款）不显示，只有内置款正常。
- **根因**：外置大库是**用户自备**资源，默认根目录 `I:\字体`（`lib/index.js` 默认值）——新机器通常没有这个盘/目录，是**预期行为**。
- **解法**：① 用「设置 → 插件 → raw-html → fontsRoot」指向自己的字体库，或直接改 `lib/index.js` 默认值；② 留空/不配也完全可用——**内置精选字体随插件分发，任何电脑装上即可用**。
- **内置现状（2026-10-18 复核修正）**：`assets/fonts/` 下 **25 个 `.woff2`、合计 54.2MB** —— 开源 7 款（文楷/文楷细/马善政楷书/思源黑三档/GreatVibes，OFL，7.3MB）+ 自备 18 款（可宋/朗宋/品宋/颜宋/静黑超细/点黑/超粗黑/卡通/叮叮/喵喵/春兰茅坤/鱼尾行书/狂侠体/鱼尾行书繁/暗恋初夏/秀英体/初心少女/丫丫体，46.9MB）。**三处口径已统一**（DESIGN.md §0.0 / README 组成表 / 本节均按 25 款 54.2MB）。
  > **修正记录（2026-10-18 晚）**：本节上一版按「20 款 39.4MB」写，并断言 `超粗黑`/`卡通`/`狂侠体`/`丫丫体`/`鱼尾行书繁` 五款「从未真正入库」——**该断言错误**。五款自 2026-10-13 接管上游（commit `a21bb7a`）起即在仓库 `assets/fonts/` 中，是**本地工作副本只解出 20 个**被误读成「从未入库」。已从 `origin/main` 取回，本节据实修正。**教训：判定「某文件从未入库」前先跑 `git ls-tree origin/main`，别只看本地目录。**
- **验证**：断开外置目录后卡片仍能用内置字体渲染；`node tools/diag-fonts.cjs` / `tests/diag-fonts.cjs` 类诊断可看注入条数。
- 来源：`DESIGN.md §0.0 / §0.1`；`README.md`「内置精选字体」；实际目录列举。

### 4.8 下载的 HTML 换机器后字体变样

- **症状**：用卡片右上角「⤓ 下载 HTML」导出的存档，换台电脑打开字体不全。
- **根因（设计如此）**：下载会把**开源字体内嵌为 data URI**（内置 `/fonts/Lanxi-*.woff2` 中 OFL 授权的部分 + KaTeX `/vendor/fonts/*.woff2`），**但外置大库字体（`/fonts/<子目录>/*.ttf`，可能商业授权）保留相对路径**——本机打开正常，换机器则 fallback 系统字体（授权安全优先）。
- **解法**：需要跨机器还原装帧时，只用内置字体重做，或把外置字体一并随档分发（自行确认授权）。
- **验证**：下载文件里搜 `data:font/woff2;base64` 是否存在；断网打开，内置字体部分应完整还原。
- 来源：`VCP-INTERACTIONS.md` §8「卡片下载」。

### 4.9 中文字体全部 404，只剩 7 款英文名能显示（文件名 GBK/UTF-8 混淆）

- **症状**：`Lanxi-叮叮` / `Lanxi-可宋` / `Lanxi-秀英体` 等**中文字体名全部静默回落成黑体**，同卡片里 `Lanxi-HeiTi`、`Lanxi-WenKai`、`Lanxi-GreatVibes` 这类纯英文名却正常。不报错、不 console warn——只是「看起来千篇一律」。
- **根因**：`assets/fonts/` 里 13 个中文名文件的**文件名本身被存坏了**——原始 UTF-8 字节被某个工具按 GBK 解码成乱码字符，再以 UTF-8 写回文件系统。磁盘上实际是 `Lanxi-棰滃畫.woff2`，而 `DESIGN.md` 与 `ensureGlobalFonts` 都按 `Lanxi-颜宋.woff2` 去请求 → `/fonts/Lanxi-颜宋.woff2` 在 `lib/index.js:661` 的 `fs.readFile` 直接 ENOENT → 落到 `res.writeHead(404)` → 浏览器静默 fallback。**纯英文名不含非 ASCII，所以毫发无伤**，这就是「只有 7 款能用」的表象来源。实测：按 DESIGN.md 声明的 20 个内置名逐个 `existsSync`，只有 7 个命中（全部是英文名）。
- **解法**：把乱码文件名按 GBK 码位反查还原成原始字节、再以 UTF-8 解码回正确名字，然后 `renameSync`。脚本 `font-fix-names.cjs`（dry-run 默认，`--apply` 执行）——建 GBK 反查表遍历全部双字节码位，逐字符还原名。改前先核「乱码名是不是孤儿」：全仓 grep 一遍，确认没有任何代码/文档引用乱码名（实测 0 处引用）再动手。改后复跑 `font-serve-check.cjs`，按声明名可解析数应从 7 升到 20。
- **验证**：改名后本地副本 20/20 全部 `existsSync` 命中（20 ＝ 当时的 13 个乱码名 + 7 个纯英文名，修复面完整）；补回缺失的 5 款后 `assets/fonts` 实测 **25 个 `.woff2`、合计 54.2MB**，与 `origin/main` 逐字节一致。备份留在 `D:\Works By DSH\backup-font-names-20261018\`。
- **教训**：**「字体不生效」先查文件名能否被 HTTP 层解析，再查文件内容。** 之前 4.3 那条（glyf 表长度）是文件内部坏，这条是**文件名坏**——两者的症状几乎一样（都是静默回落黑体），但排查入口完全不同：4.3 要 fontTools 读表，这条只要 `existsSync` 一次就能定罪。另：中文名资源在任何「下载/解包/复制/打包」链路上都有被 GBK 化一遍的风险，入库后必须验名。
- 来源：2026-10-18 实测（老大反馈「字体好像不对」后定位）；`assets/fonts` 目录逐文件核对。

---

## 五、性能与缓存（vcp-fast）

### 5.1 长卡流式抖动 / 掉帧 / 动画重播

- **症状**：大卡（长文本 + 复杂 SVG + 动效）在流式生成时反复重画、抖动，动画每次重建都从头播。
- **根因**：每帧整串重解析 → React 元素引用每帧都变 → 整棵子树被 diff/重建。
- **解法**：**vcp-fast 加速引擎**（`window.__vcpFast`，在 `patch/v6-inject.js` 内）：① 精确缓存——HTML 字符串未变时直接返回缓存的 React 元素引用，引用相同则 React 跳过整棵子树 reconciliation；② 增量追加——内容＝旧内容 + 追加段且旧内容以闭合标签结尾时，稳定部分引用不变，只解析渲染新增段。安全边界：仅非流式 + 开关开启时生效；旧值未闭合或内容重写自动回退全量。
- **验证**：DevTools console 可见 `[vcp-fast] HIT/BUILD` 日志（每 2 秒节流）；基准 `node patch/vcp-fast-bench.cjs`（domino 真实 DOM 环境）——实测**缓存命中约 1200~6800 倍、增量约 12 倍提速**；逻辑仿真 `node patch/vcp-fast-sim.cjs`。
- 来源：`README.md`「vcp-fast 加速引擎」；`CHANGELOG.md` v2/v6。

### 5.2 缓存到顶时整表清空 → 周期性卡顿

- **症状**：缓存命中率突然归零，长会话里出现规律性的「一次全量重建」。
- **根因**：缓存到顶是**整表 clear 而非 LRU 逐出**——`F.c.clear()`（上限 200）与 Mermaid 缓存整体丢弃（上限 30），清空瞬间全量重建（审计 E1）。
- **解法**：改为**逐出最旧一条**（Map iterator 序），两处同理（已修）。
- **验证**：压满缓存后观察 `[vcp-fast]` 日志，应始终有 HIT、无整表重建。
- 来源：`docs/审计-2026-08-26.md` E1；`docs/审计-2026-08-26.md` 零·五整改追踪（已修）。

### 5.3 每帧全量正则扫描（大卡的一次性开销）

- **症状**：大卡在 600ms 防抖后有肉眼可感的停顿。
- **根因**：自愈层 `constrainImg` / `sanitizeStyle` / `boostTextImportant` / `scopeVcp` / `injectFontInherit` 全是**整串正则替换**，正则 30+ 条；`enforceFontChain` 还要对 21 个标签 × 7 属性做 `node.matches`（审计 E2/E3）。
- **解法（部分已做）**：给 `boostTextImportant` 等加「无 `<style>`/无目标特征提前返回」的快速守卫（部分已有 `indexOf` 预检）；`enforceFontChain` 只在 600ms 防抖跑。**完全根治未做**（审计建议继续扩守卫）。
- **验证**：大卡首帧与防抖帧耗时对比；DevTools Performance 录制看单帧曲线。
- 来源：`docs/审计-2026-08-26.md` E2/E3。

### 5.4 每帧 `setProperty` 风暴 / 数学占位残留

- **症状**：流式容器重建时属性被反复写入（性能），或多顶层块时前面块的数学占位徽标残留在卡上。
- **根因**：`attachMathRef` 的 ref 每帧都是新闭包 → React 每帧 old(null)/new(el) 重调；另 `attachMathRef` 只挂**最后一个顶层块**的 ref（协议规定单 `#vcp-root`，边角情形）。
- **解法**：重写为**缓存 ref 闭包**（`node.__vcpRefSetter` + `__vcpMathRef` 标记），容器流式重建时 ref 身份跨帧不变（已落地）；多顶层块的数学盲区属已知边角，未处理。
- **验证**：`tests/math.test.mjs`；流式长卡在 Performance 面板无重复 setProperty 峰值。
- 来源：`docs/EVOLUTION-2026-08-24.md` §二/§六遗留 4；`CHANGELOG.md` v6.17。

### 5.5 Mermaid 相关

- **症状**：开着插件聊久了越来越卡；或某条消息里的 Mermaid 图渲染失败时整块变成错误提示。
- **原因**：① 全局监听器没人摘，泄漏（已修，P1 性能项，协议文本同时瘦身约 74%）；② 渲染缓存原本无上限；③ 首载体积大——`assets/vendor/mermaid.min.js` 约 **2.6MB**、`katex.min.js` 约 **272KB**（本地秒加载可接受，慢盘/网络环境有感，审计 E4 记为 P3）。
- **解法**：全局监听器随消息卸载一并摘掉；SVG 缓存上限 **30**，失败自动回退为源码代码块、不会闪错误；两次渲染/重渲染的代价不额外优化（P3 待办）。
- **验证**：连开十几条含图消息，移除后监听器数量回落；渲染一条语法错误的 Mermaid，应显示源码块而不是错误提示。
- 来源：`README.md`「性能（P1）」；`VCP-INTERACTIONS.md` §7；`docs/审计-2026-08-26.md` E4。

### 5.6 协议注入的 token 成本

- **症状**：担心「开着插件每轮都很贵」。
- **原因**：协议靠**每轮注入一段文本**实现（`buildStructuralText` 结构铁律段 + `buildAestheticText` 美学工具包段 + 风格锁定段），注入多少直接等于每轮多花的 token；早期版本把三段当一坨，关掉渲染后仍整段注入。
- **实测**：render + 美学 + 风格锁定全开时每次对话约 **3.9K tokens**（`buildStructuralText` 2.6K + `buildAestheticText` 1.1K + 锁定段 170），约占 128K 上下文的 3%；**render 关闭时仅 55 tokens**（`DISABLED_TEXT`）——没有「关了还在大量注入」的问题。
- **解法**：双开关分层（`lib/index.js` 把状态拆 `render` + `aesthetic`，协议拆结构铁律段与美学工具包段）；只开渲染时美学整段零注入（实测 −4.6K token/轮、−¥0.056/轮）。
- **验证**：`node tests/diag-inject-size.mjs {width=full}` 量注入量；开关切换后新请求的注入段长度变化。
- 来源：`CHANGELOG.md` 0.6.0 段（2026-08-27 注入量自检）；`docs/EVOLUTION-2026-08-24.md` §二第二轮。
- **历史坑（别再犯）**：【风格锁定】段曾脱离 `aesthetic` 门控——美学关了却仍注入「锁定某风格」（语义矛盾），已修为锁定段移入 aesthetic 门控内。
- 来源：同上（修复 A）。

### 5.7 复杂计时链路难排查

- **症状**：`scheduleMath` 那套时序里某一环出问题（数学没渲染、字体链没生效、SVG 动画不跑、停止后还在跟），却看不出是哪一步。
- **原因**：`scheduleMath` 一个 600ms 计时器承载五件事（KaTeX 渲染 / `finalizeRoot` / `enforceFontChain` / `healSvgAnimation` / `followStop`），任一环节出问题都难独立定位（审计 L4）。
- **解法**：未重构，属已知技术债。排查时用分点 `console.debug` 打时序（五件事各打一行前后时间戳），别猜。
- **验证**：日志里五段的进出时间戳能对齐，出问题的那一段明显偏离其余四段。
- 来源：`docs/审计-2026-08-26.md` L4。

---

## 六、关键路径与配置落点

### 6.1 路径

| 类别 | 具体位置 |
|---|---|
| 插件源目录 | `D:\DeepSeek Harness\Works\dsh-maid-vcp`（目录名仍是旧名 `dsh-raw-html` 的历史遗留写法在早期记忆里；本仓为 `dsh-maid-vcp`） |
| 桌面端被改文件 | `resources\app.asar` 内 `dsh-web-frontend/dist/assets/index-*.js`（asar 内条目名形如 `bundle-index-5SrrfWpU.js`） |
| 补丁器 | `patch/install-all.cjs`（分流）→ `patch/patch-frontend-asar.cjs` + `patch/asar-io.cjs`（桌面端） |
| 渲染引擎正本 | `patch/v6-inject.js`（改 bug 后重跑 `install-all.cjs` 即生效） |
| 浏览器半侧 | `lib/client.js`（面板按钮 / `window.__dshInput`） |
| Host 半侧 | `lib/index.js`（开关状态 / 协议注入 / `/fonts` 服务） |
| 开关状态文件 | `~/.dsh/dsh-maid-vcp-state.json`（README「使用」）——`$DSH_HOME` 下同名文件 |
| 打字机状态（历史） | `~/.dsh/dsh-maid-vcp-gate.log`（思考门日志，已随思考门移除删除） |
| asar 条目备份 | `Works/_asar-backup/bundle-index-<id>.js.<ISO时间戳>`（如 `bundle-index-5SrrfWpU.js.2026-10-15T16-21-22-400Z`） |
| Web 端补丁备份 | `*.bak-installv6-<时间戳>` |
| 字体资产 | `assets/fonts/*.woff2`（内置，25 个）；外置大库默认 `I:\字体` |
| 第三方库 | `assets/vendor/`（`VCPColorEngine.js` / `mermaid.min.js` / `katex.min.js` / `katex*.css` / `fonts`） |
| 美学库 | `styles/`（`_INDEX.md` 索引 / `_FONTS.md` / `_BASELINE.md` 兜底 / `abyss-maid.md` 唯一风格 / `_inbox/` 采集暂存） |
| 成品档案 | `examples/`（`雨柬·山城酷热.html`、`情书·春水笺.html`、`今日八卦晚报.html`、`深夜女郎·顶栏装帧.html`、`warm-minimal-宋体体系定案.html`） |
| 测试 | `tests/`（`bundle` / `stable` / `security` / `trusted` / `smoke` / `math` / `mermaid` / `boost-fontface`，DOM 依赖由 `tests/_deps.cjs` 定位） |
| 主题配置 | `cordis.patch.yml`（把插件的 client 入口插入 web 插件花名册） |

### 6.2 路由与 MIME

- 本插件注册的路由：**只有 `/fonts` 与 `/vendor`**（MIME 白名单不含图片扩展名 → 插件本身不能托管图片）。
- 图片出口：`/comfyui/media?file=&subfolder=&type=output|input`（来自 `dsh-maid-comfyui`）。
- 认证提示：根路径 `/` 返回 **401**（认证墙），插件路由不需要认证。

### 6.3 配置键与开关（都写具体值）

| 键 | 位置 | 取值语义 |
|---|---|---|
| `dsh.rawHtml` | localStorage | 渲染开关。三态：`undefined`=默认开、`'1'`=开、`'0'`=显式关闭（v6.35 起） |
| `dsh.rawHtmlAesthetic` | localStorage | 美学注入开关（渲染关时美学强制关） |
| `raw-html.trusted` | localStorage | 可信模式。v7.3 起默认开；**仅显式 `'0'` 关闭**；localStorage 不可用时回落安全默认（关） |
| `raw-html.trustedBadge` | localStorage | `'1'` 唤出右下角盾锁徽章（默认不挂载，防撞位） |
| `raw-html.fontsRoot` | 设置 → 插件 → raw-html | 外置字体大库根目录（默认 `I:\字体`） |
| `window.__DSH_TRUSTED__` | 运行时 | 设 `false` 等效关闭可信模式 |
| `window.__dshInput(text)` | 运行时 | `onclick="input('...')"` 的桥接目标（填输入框并发送） |

### 6.4 补丁识别标记（排查时先看这个）

| 标记 | 含义 |
|---|---|
| `window.__vcpStable` + `window.__vcpGen` | **唯一可靠的「补丁已装」判据**（两者必须同时出现） |
| `/*__DSH_V6_INJECT_START__*/` … `END` | 稳定区模块的夹取标记（v10.2 起用于整段升级比对） |
| `case"html":{if(localStorage.getItem("dsh.rawHtml")!=="0"){var _vr=window.__vcpStable&&…` | 真正的渲染分支形态（三态化后） |
| `[vcp-fast] HIT/BUILD` | 运行时缓存命中日志（每 2 秒节流） |

### 6.5 生效边界（改哪儿、怎么生效）

| 改动位置 | 生效方式 |
|---|---|
| `lib/index.js`（提示词层 / 宿主路由 / `/fonts`） | **重启 DSH** |
| `lib/client.js`（DOM 层） | 浏览器**硬刷新**（Ctrl+F5） |
| `patch/*`（asar 补丁层） | 重跑 `node patch/install-all.cjs` 后**完全退出并重启 DSH**（asar 头被进程缓存） |
| `styles/*`、`DESIGN.md` 等知识层 | 下次 agent 读取时生效（无缓存），提示词里挂的是本机路径 |

### 6.6 常用命令

```bash
# 体检（不写盘；注意：applied 列表 ≠ 已装）
node patch/install-all.cjs --dry-run

# 正式打补丁
node patch/install-all.cjs
node patch/install-all.cjs "D:\...\resources\app.asar"   # 探测失败时手动指定

# 语法自检
node --check lib/client.js && node --check lib/index.js && node --check patch/v6-inject.js

# 依赖声明核对（2026-08-19 崩溃事件教训）
node tools/check-deps.cjs

# 测试
node tests/bundle.test.mjs && node tests/boost-fontface.test.cjs
node tests/smoke.test.mjs && node tests/stable.test.mjs && node tests/trusted.test.mjs && node tests/security.test.mjs

# 性能基准 / 仿真
node patch/vcp-fast-bench.cjs [bundle路径]
node patch/vcp-fast-sim.cjs  [bundle路径]

# 卸载插件
dsh plugin --profile web remove dsh-maid-vcp
```

### 6.7 面板图标类问题（本仓也适用，2026-10-16 记）

**症状**：插件面板里某个小困插件显示默认蓝蝴蝶，而不是统一的比耶小困头像——统一换图标那次，`dsh-maid-guard` 就被漏下（老大照截图逮住）。

**原因**：面板图标读各插件 `package.json` 的 `"icon"` 字段，**没声明就显示默认图标**。而漏的那只不住在仓根目录（住 `dsh-maid-patch-kit/guard/`，profile 侧走软链挂载），按「八仓目录」逐个加图标时天然不进枚举。

**解法**：换图标**三步一个都不能少**——① 图标文件落进仓 `assets/plugin-icon.png`（256px PNG）；② `package.json` 加 `"icon": "assets/plugin-icon.png"`；③ **`files` 白名单必须含该路径**，否则 npm 分发时被排除、换机器掉图。枚举小困插件**一律走文件系统真值**，别按目录印象数：`find . -maxdepth 3 -name package.json -not -path "*/node_modules/*"`，对每个结果查 `icon` 字段。

**验证方式**：`pnpm pack --dry-run --config.ignore-scripts=true` 的 Tarball Contents 里出现 `assets/plugin-icon.png`；**重启 DSH 后面板才刷新**——判据是「图标文件落盘时间早于进程启动时间」，实测法：`Get-Process | ? {$_.ProcessName -match 'DeepSeek Harness'} | select StartTime` 与文件 `stat` 时间比对。

---

## 七、排查手法

1. **先定位层次，再动手。** 提示词/宿主路由 → 重启 DSH；`client.js` → 硬刷新；`patch/` → 重跑补丁 + 完全重启。三层混着改，最后一定分不清是谁的锅（见 6.5）。
2. **补丁类型判定别搜 `case"html"`。** 该字面量在 bundle 里出现 **8 次**，其中一处是文件图标组件的 switch（与渲染无关）。唯一可靠判据＝ `window.__vcpStable` 与 `window.__vcpGen` **两个标记同时存在**。
3. **`--dry-run` 只当预演。** 它会完整执行替换计算并列出 `applied`，只是不写盘——「dry-run 全绿」既不等于已装，也不等于内容一致（见 1.4/1.5）。
4. **打完 asar 要逐函数比对，不是看标记在不在。** 写脚本从 `START`/`END` 之间取段、按大括号配平抽 `fixVcpBlank` / `findRootClose` / `nextTag` / `tagEndAt` 各函数与磁盘源逐字比对（实测 960/1065/931/269 字符全等）。**注意** `readEntry().toString('utf8').length` 是**字符数**（如 721281）不是字节数（如 741859），别把差值当损坏。
5. **拿运行中的 bundle 对账。** 浏览器直接取 `/plugins/dsh-maid-vcp/client.js?rev=…`，确认「代码到底进没进运行时」（`rev` 能证明页面拿到的是哪一版）。
6. **puppeteer 取证代替猜。** 字体那两轮（`fontHostExists=true` 但 `fontRuleCount=0`、`已装 0/39`）都是靠 puppeteer 抓 console 日志一锤定音的（`tests/diag-fonts.cjs`、`tests/diag-xiuying-browser.cjs`）。证据链写法：代码进 bundle ✓ → RPC 通 ✓ → 判定环节 ✗ → 定位真凶。
7. **同源路由先用 `node:http` 裸探。** 确认字节可达再改卡片路径——两边一致才能排除服务端问题。根路径 `/` 的 **401 是认证墙**，插件路由不需要认证，别被它误导。
8. **探针单测：从源码里抠真函数，不抄源码。** `_probe/vcp-comment-v641-probe.mjs`（9 用例）/ `vcp-comment-v642-probe.mjs`（13 用例）用正则从 `v6-inject.js` 抠出真实的 `stripHtmlComments` 与 `render`，在 `node:vm` 里用假 `window` 桩跑用例——改一行源码，探针跟着变，才能证明「修的是这份代码」。
   **现状（2026-10-18）**：`_probe/` 曾整目录丢失，已按原设计重建 4 个探针并全部实测通过：`vcp-comment-v641-probe.mjs` 9/9、`vcp-comment-v642-probe.mjs` 13/13、`vcp-verify-case-html.cjs` 8/8、`vcp-inlinecode-v103-probe.mjs` 14/14、`verify-v103-in-asar.mjs` 8/8（回读实机 asar）。重建时用例数与原 CHANGELOG 记录不同属正常——原记录是当时的用例集，重建按现有实现补齐了边界；**CHANGELOG 里的历史数字不追改**（那是历史事实）。跑法见各探针文件头注释，`verify-v103-in-asar.mjs` 必须用 `ELECTRON_RUN_AS_NODE=1` 跑（普通 node 读不了 app.asar）。
9. **对照组法。** 同款卡片「前面留空行 vs 只留单换行」「style 多行 vs 单行」并排跑一次，结论比读文档快（2.3/2.7 都是这么定案的）。
10. **症状先怀疑自己的输出。** 「回复空白」「标记显形」两次事故的共同点：渲染侧和 TTS 侧各打一半补丁就会残——先核对**标记是否裸写、独占一行、完整闭合**，再动引擎。
11. **测试兜底顺序**：先 `node --check`（语法）→ `tests/bundle.test.mjs`（无 DOM 依赖、可离线）→ 需要 DOM 的 `smoke`/`stable`/`security`/`trusted`（装 jsdom）→ Mermaid e2e（`e2e-mermaid*.cjs`，需 puppeteer）。改引擎后**必跑 bundle 完整性测试**。
12. **回滚**：把补丁自动生成的备份改回原名（`index-*.js.bak-xxx` → `index-*.js`，或 `Works/_asar-backup/` 里的条目），再移除插件。
13. **「深蓝直角空块」这类偶发**：先记录 rev 与消息内容，重启复测；不复现就不改引擎（见 2.13）。

---

## 暂未遇到（留白，供后续补记）

（暂无条目——遇到新问题按「症状 → 根因 → 解法 → 验证」四段式补记于此。）

---

## 待核

- Windows 之外的平台（macOS / Linux）安装与路径差异：**暂未遇到**，本册所有路径均为 Windows 形态。
- 插件在 Web 端（非 Electron）的实际渲染问题：**暂未遇到**（本机只用桌面端，Web 补丁器有意不随桌面端迭代）。
- 上游 `plolpl789/dsh-raw-html` 复活后的回并流程：**暂未遇到**（上游已停更，本仓为接管维护分支）。

---

*—— 小困整理 · 2026-10-16 · 症状照抄实测、解法附出处，禁止照搬没验证过的结论 ——*
