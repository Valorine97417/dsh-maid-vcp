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

- **本机实测（2026-10-18）**：本条症状再来一例，来源会话 `session-adce7769` 第 1205 条（同批 `334edf38` 第 33 条独立复核，结论一致）。现象与上面描述同型：补丁装完、静态锚点检查通过，打开消息列表整块空白，控制台抛 `ReferenceError`；根因仍是 `AFTER` 串吞掉了锚点里原有的 `const` / 解构声明前缀，使 `h` / `m` 成为未声明自由变量。**不要把本条与 §1.12 合并**：1.12 是前缀锚点抢跑打出 `}();();` 语法错误（打包期即暴露），本条是打包成功、渲染期才炸——两个根因、两样现象。
- **落地纪律补一句**：改这类锚点时，先 `Select-String` 出 `BEFORE` 里所有 `const` / `let` / 解构行，逐字搬进 `AFTER` 开头，再比对行数；`node --check` 只查语法，抓不到自由变量。

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

### 1.17 combo URL 把所有插件 client.js 拼成一条 bundle script：一个入口失败，整链全不激活（含 artifactRevision 失配这一具体触发源）

- **症状**：装完 / 重装 / 更新过插件之后，**一批插件同时不激活**——面板里它们的按钮、路由、面板项全体消失或报错，而**不是**单独某一个插件坏掉。浏览器日志里的原文是这两行（先失败、随后整链被跳过）：

  ```text
  bundle script … failed to load
  skipped after an earlier failure of this bundle
  ```

  出问题的请求形态是**一条 combo URL 把多个插件的 `client.js` 拼在一起**：

  ```text
  plugins/??a/client.js,b/client.js,…&rev=<hash>
  ```

  也就是说：一个入口失败 → 整条 bundle 被跳过 → **同一条链上的所有插件都不激活**。本机实测（2026-10-15 12:47 ~ 2026-10-17 10:03）共出现 **8 次**；同族报错另计——`bundle script failed to load / rev 失配 / failedBundleUrls` 11 次、`import failed / entry did not activate` 10 次。

- **原因**：两层，缺一不可。
  1. **combo 拼接 = 共享失败域**。宿主把带 `dsh.client` 的包的 `client.js` 用 `plugins/??a/client.js,b/client.js,…` 这种 combo 形式**合并成同一个 script 请求**送进页面。既然是同一个 `<script>`，任何一个入口 404 / 抛错 / 语法错，整条脚本即判失败，宿主记下这条 URL 后对同链其余入口一律 `skipped after an earlier failure of this bundle`——所以现象永远是「成批不激活」，不是「单个坏」。
  2. **`artifactRevision` 失配是这条链最常见的具体触发源**。`rev` 不由源码内容派生，而是由 `client.js` 的 **`mtimeMs` / `ctimeMs` / `size`** 三个文件元数据算出来的 `artifactRevision`。`pnpm install` 重写 `node_modules` 后这三个字段全变 → 页面手上那条**旧 combo URL 里的 `rev` 已作废** → 请求直接 404 → 依然走到「整链失败」这条路。这就是为什么它总在 install / 重装之后发作。

- **解法**：
  1. **定位口是 `failedBundleUrls`**（日志与宿主运行时都能拿到）：先看**是哪一条 URL** 失败，再从那条 URL 的 `plugins/??a/client.js,b/client.js,…` 里反查**是哪个包**的入口把它拖挂的。**分流判据**：`failedBundleUrls` 有内容 → 是本条；为空、且宿主档案里有 `entry.disabled` 被置真 → 去查 **1.15**（那是另一个病）。
  2. **重启宿主自愈**：重启后 `rev` 按当前文件元数据重算，combo URL 换新，链即可正常加载。这是**应急手段**，不是根治——下次 `pnpm install` 还会重演。
  3. **千万别点「禁用第三方插件」**：它会把**同链上本来正常的插件一起停用**——本条的病根是「一条链共享失败域」，而「禁用第三方插件」正手按在这个失败域上，属**二次伤害**（越点坏得越多，且恢复时要一个个重新启用）。
  4. **排查单插件时不要裸 `curl` `/plugins/??<pkg>/client.js`**：不带 `rev` 参数必然回 404，会把你引到「这个插件包坏了」的错误结论上。要带上**页面实际使用的那条 `rev`**（从 Network 面板里复制整条 combo URL，或去掉其余项只留目标包、其余参数照抄）。

- **验证方式**：**未验**——「重启自愈」在本机只被记为临时手段（`bundle script failed to load` 的同族记录），**没有留存「重启前后 `failedBundleUrls` 由非空变空、同链插件全部恢复激活」的回归现场**，落盘前须补一次完整复验并把日志原文补进本条。可操作的判据（按顺序）：
  1. 复现态：日志/运行时 `failedBundleUrls` 非空，且里面是一条 `plugins/??…&rev=…` 形态的 URL；
  2. 重启后：`failedBundleUrls` 为空（或不再新增同一条 URL），同链上**所有**插件在面板里恢复；
  3. 单插件复核：`curl -sI "http://127.0.0.1:<port>/plugins/??dsh-maid-vcp/client.js&rev=<页面实际 rev>"` 回 **200**；把 `rev` 改成一个假值重试，应回 404——这一步证明 `rev` 确实是失配点，而不是包本身坏；
  4. 反向确认没有踩 1.15：宿主档案里该插件的 `entry.disabled` 为假/不存在。

> 证据：记忆 lesson 0mv88yxvl、会话候选 C33（出现 8 次，2026-10-15 12:47 ~ 2026-10-17 10:03）· 2026-10-18 补录

---

### 1.18 刷新报「Desktop Host is unavailable」＋点更新报「未能安全停止任务」：一场 HMR 竞态把 Host 打死，连累更新器安全阀

- **症状**：桌面端刷新页面，界面弹「Desktop Host is unavailable」，此后**所有**刷新都同样报不可用；重启应用（Restart）可恢复。连带后遗症：这场崩溃之后点「应用更新」会弹「未能安全停止任务，更新尚未安装」，更新整次作废。
- **原因**：不是 profile manifest 坏、不是 BOM、不是文件损坏——是 **HMR 热重载竞态把 Host 进程打死**。宿主崩溃日志里两组原文同时出现（`main` 侧报外壳收到的致命错，`host diagnostic` 侧报 Host 进程自己的栈）：

  ```text
  DesktopHostFatalError: cannot create effect on inactive context
      at ChildProcess.<anonymous> (file:///…/resources/app.asar/lib/main.js:3711:49)
  --- host diagnostic (as reported by the Host process) ---
  CordisError: cannot create effect on inactive context
      at Fiber.assertActive (…/@deepseek-ai/cordis/lib/index.js:1133:9)
      at Proxy.plugin (…/@deepseek-ai/cordis/lib/index.js:1622:18)
      at Object.apply [as callback] (…/@deepseek-ai/dsh-desktop-host/lib/index.js:80:12)
      at async Fiber._reload (…/@deepseek-ai/cordis/lib/index.js:1356:5) {
    code: 'INACTIVE_EFFECT'
  }
  ```

  读法：`Fiber._reload` 已经在卸载/重载途中，`dsh-desktop-host` 的 `ctx.plugin` 回调此时才被调用，`Fiber.assertActive` 判定 context 已 inactive → 抛 `INACTIVE_EFFECT`。Host 进程一死，渲染侧取不到 Host，就统一报 unavailable。
  **`web-boot.log` 只是受害者**：同一次崩溃里 `web-boot` 那几行是外壳连不上 Host 之后的次生报错，照着它排查会一路查错方向。
  **连带更新失败**：这样崩过一次的宿主，shutdown 应答不完整。更新器 `stop(requireGraceful)` 的安全阀先叫宿主 shutdown（等 10s），不干净就 SIGTERM 强杀；一旦退出码非 0 / 未确认 shutdown / 超时，就抛 `DesktopHostUncleanExitError`（文案键 `updateStopFailed`），**整次安装作废、本地文件一点不动**。所以「未能安全停止任务」≠ 更新包坏了、≠ 装坏了。
  三个字面量 `DesktopHostUncleanExitError` / `updateStopFailed` / `requireGraceful` 在本机 `resources\app.asar` 二进制里均可直接搜到（2026-10-18 实测）。记忆另记 `stop()` 约在 `lib/main.js:3812`、stop-failed 分支约在 11507 行——**这两个行号本轮未逐行复核（未取证到具体行号）**，只作定位线索用。
- **解法**：
  - 报 unavailable → **点 Restart 即可恢复**。别点「禁用第三方插件」（最右那颗）：这崩跟插件无关，禁了只会让排查面更大。
  - 已经弹过「未能安全停止任务」→ 挑一个**没有任务在跑**的时机，把**整个应用退出重开**再点更新，让 Host 有一次干净的 shutdown 可应答。
  - 更新包本身没坏：已下好的包躺在 `%LOCALAPPDATA%\@deepseek-ai\dsh-desktop-updater\pending\`（`updaterCacheDirName=@deepseek-ai/dsh-desktop-updater`，feed channel 为 nightly），可手动跑，但要另开安装窗口、装完应用会退出。
  - 崩溃现场必看 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\` 下的 `crash-<时间戳>-main.log`：按**时间戳相邻配对** `main.log` 与 `web-boot.log`，`INACTIVE_EFFECT` + `Fiber._reload` 这两个词同时出现在 main 侧，就是本条。
- **验证**：**部分未验证**——「Restart 后恢复正常」本机成立（崩溃后重启可继续用）；「先整个应用退出重开、更新即可装成功」这条**未实测**（本轮没有可复现的待装更新）。可复现判据：反复强制刷新 / 反复重载触发 HMR → 看是否新落一个 `crash-*-main.log` 且含 `code: 'INACTIVE_EFFECT'` → Restart 后复测更新按钮。
- **教训**：**「Desktop Host is unavailable」先读 Host 的栈，别读 web-boot。** 崩一次就沾上更新安全阀的账，处置顺序是「先 Restart 恢复可用，再整个退出重开去更新」，不是「反复点重试」。
> 证据：记忆 lesson `0mvcif0xf`（崩溃与 web-boot 假象）、记忆 lesson `0mvcik7lt`（更新安全阀 `updateStopFailed`）；本机崩溃原文 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-2026-10-17T14-36-00-198Z-main.log`（5104 B，header：`app: @deepseek-ai/dsh-desktop 0.2.0-rc.2` / `electron: 44.0.0` / `node: 24.18.1` / `phase: startup`）与 `crash-2026-10-17T14-42-32-870Z-main.log`（同一组栈第二次）；asar 字面量实测 · 2026-10-18 补录

### 1.19 桌面端升级一次，前端补丁整体归零：插件「看着没坏」，卡片却渲染不出来

- **症状**：DSH 桌面端升级之后，什么都没动，卡片突然渲染不出来、HTML 整段变源码。去 profile 里看插件本体——文件都在、版本没变、软链没断，「看着没坏」。重装插件、改配置、开关渲染开关，全都不管用。
- **原因**：桌面端升级会**整体重写 `resources\app.asar`**。本插件的卡片渲染能力有一半是**补丁层**——写进 asar 内前端 bundle（`dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js`）的替换内容；asar 一被重写，这些补丁**全部抹掉**，而插件本体留在 profile 里毫发无伤。所以现象是「插件在、能力没」。这跟 §1.7 的三层生效边界是同一张地图的另一半：1.7 讲「改哪一层怎么生效」，本条讲「**其中一层会被宿主升级整体归零**」。
  判据：看 `resources\app.asar` 的 mtime 是否与这次 DSH 升级时间吻合——吻合就是本条的现场。（本机 2026-10-18 实测：`app.asar` Length 183849802、LastWriteTime `2026/10/18 0:40:31`，即已打过补丁的状态。）
  **升级还会顺手换 bundle 的文件名**：记忆与 §1.17 记的代际是 `index-5SrrfWpU.js`，而本机 `Works/_asar-backup/` 现存备份是 `bundle-index-CN7NIWNw.js.2026-10-17T16-40-31-801Z`（939867 B）——id 已经不同代。所以任何「按文件名硬编码去找落点」的脚本/笔记，升级后都会先扑空。
- **解法**：**先探 asar，别先怀疑插件或配置**。顺序固定为：① `node patch/install-all.cjs --dry-run` 看探测与替换计算；② 直接在 asar 内搜补丁标记（`window.__vcpStable` 与 `window.__vcpGen` 必须**同时**存在，见七·2）；③ 标记缺失 → 重跑 `node patch/install-all.cjs`（桌面端分支会走 `patch/patch-frontend-asar.cjs`），然后**完全退出并重启 DSH**（仅刷新页面不够，见 §1.7）。
- **验证**：**部分未验证**——本条讲的是机制与排查顺序，「升级后重跑补丁即恢复」这条**本轮未做真机升级复验**。现有可用的判据是正向的：本机 asar 内 `window.__vcpStable` 实测出现 10 次、`window.__vcpGen` 5 次、`vcp-root` 27 次、`stripHtmlComments` 7 次（2026-10-18 二进制直搜），说明当前这份 asar 是**打过补丁**的状态；升级之后同一组搜索应归零，重跑补丁后应回到非零。
- **教训**：**「插件没坏」和「能力还在」是两件事。** 卡片类故障的第一判断不是重装插件，而是确认 asar 里补丁标记还在不在；升级后的第一件事就是重跑补丁器。
> 证据：记忆 lesson `0mvcmi9j0`（升级整体重写 app.asar、补丁被抹）；本机 `resources\app.asar` 时间戳与二进制标记直搜；`Works/_asar-backup/bundle-index-CN7NIWNw.js.2026-10-17T16-40-31-801Z` · 2026-10-18 补录

### 1.20 前端补丁的代际账与「改动面审计」：整份 asar 里只该有一个文件不同

- **症状**：补丁装上了、`--dry-run` 全绿、健康检查也过，前端行为却不对（消息区整块白屏 / 注释仍显形）。另一种症状是反过来：**不知道该改哪份 asar**——手里攒了好几个 `app.asar.bak-*`，分不清哪个是「干净基准」、哪个是「坏版本」，重打补丁时基准选错，越修越乱。
- **原因**：前端补丁是**在同一份 asar 里一层层叠上去的**，而每一代补丁都必须以**原始未打补丁的 asar** 为基准；一旦拿错基准（比如拿已经打过坏补丁的那份当基准），补丁会「成功」，产物却是坏的。本仓的历史脉络如下（**两支早期脚本已不在仓内**——`patch/` 下现只有 `install-v6.cjs`、`patch-frontend.cjs`、`patch-frontend-asar.cjs`、`anchors.cjs`、`asar-io.cjs` 等共 16 个文件，无 `patch-webui-v8.cjs`、无 `fix-v9.mjs`，本条只作代际沿革记录，不作为可执行步骤）：
  - **v8（已弃用）**：F 补丁写 AFTER 串时吞掉了 `h` / `m` 声明，组件一渲染就 `ReferenceError`，**整个消息区白屏**。这份坏版本曾留过备份 `app.asar.bak-bad-v8`。这条正是 §1.13「替换式补丁写 AFTER 串时吞掉声明前缀」的历史事故原型——**§1.13 记规则，本条记它当年长什么样、为什么整套弃用**。
  - **v9（2026-10-13 修好）**：目标 bundle `index-5SrrfWpU.js`，633282 → 738882 B，sha `45116a3f…e81dd`；asar 内 11470 条 integrity **零不匹配**（证明改完还自洽）；基准是 `app.asar.bak-before-v8`（**打补丁前的那份**）。
  - **此后**：前端补丁演进到 v10.3（vcp 0.6.14 时期），asar 尺寸换过代；本机 2026-10-18 实测 183849802 B。
  - **备份体积账**：asar 备份曾累计占用约 **825 MB**（每个 `app.asar.bak-*` 都是一份完整副本）。**现已清理**——本机 `Works/_asar-backup/` 只剩 1 个 bundle 级备份 `bundle-index-CN7NIWNw.js.2026-10-17T16-40-31-801Z`（939867 B），不再有整包 `.bak` 副本。**这条账要记住：备份策略从「整包留一份」改成「留 bundle 那一份文件」，否则磁盘会被吃穿。**
- **解法**：
  - **改动面审计**（这一节最值钱的一条判据）：打完补丁后，把当前 asar 与**原始未打补丁的 asar** 逐个 packed 条目比对——**整份 asar 里应当只有 1 个文件内容不同**：`dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js`。2026-10-13 那次审计实测：11470 条 packed 条目，差异文件数 = 1。**只要比出第二个不同的文件，就是补丁改错了范围**，当场回滚，别往下走。
  - 同一份 bundle 上叠的几个补丁应当**同时在场**并逐一验明：① **boot 审计补丁**（`if(o.length>0)throw new Error(` → `console.error(`，修「强制刷新页面」的启动崩溃，见 §1.15）；② **raw HTML 渲染补丁**（`window.__vcpStable` 那一族）。少一个就表现为「一部分功能好、一部分不对」。
  - 基准选错的自救：用 `Works/_asar-backup/` 里的 bundle 级备份 + 宿主安装包重新落地，**不要**拿任何一个 `app.asar.bak-<坏代际>` 当基准。
- **验证**：本机可复算的版本——在 asar 二进制里直搜补丁标记：`window.__vcpStable` 10 次、`window.__vcpGen` 5 次、`vcp-root` 27 次、`stripHtmlComments` 7 次（2026-10-18 实测），四个都非零＝补丁在场。改动面条目比对脚本**本轮未重建**（原审计脚本随 `_probe/` 一起丢过，见七·8），**审计数字沿用 2026-10-13 实测值，未做本轮复算**。
- **教训**：**补丁装「成功」不等于产物「对」**——锚点匹配成功、健康检查通过、integrity 自洽，产物照样能在渲染期炸（v8 就是这么白屏的）。所以每代补丁都要过一遍**改动面审计**：只有 1 个文件不同，才算真装对了。
> 证据：记忆 fact `0mv60mo1p`（v8 弃用 / v9 修好 / 改动面审计 1 个文件 / 备份 825 MB）；本机 `patch/` 目录实测 16 个脚本、`Works/_asar-backup/` 现存条目、asar 二进制标记计数 · 2026-10-18 补录

### 1.21 插件页的「异常」与「包不可用」不是一回事，也不是「没加载」——三个状态各指各的

- **症状**：插件页上某个插件挂着「异常」或「包不可用」标签，但聊天区里它的功能看着又能用；反过来，有的插件标签是干净的，实际却根本没跑起来。于是「它到底加载了没」这个问题，靠标签根本判断不了。
- **原因**：插件页把**四个互不相同的东西**都塞进了一张卡片，中文文案又撞车——本机 asar 内前端词典实测：
  - **包级**：`statusProblem: "异常"`（这个包自身的**包记录 error**：元信息解析失败一类，页面会给出「原因」一行 `reasonLabel`）；`statusMissingFiles: "包不可用"`（**依赖已登记、但磁盘上文件不可得**，即包解析不出可用文件）；`statusBeta: "实验性"`。
  - **组件级**（同一个包里可以有很多个部件，各自独立跑）：`rowPhaseFailed: "异常"`（**fiber 相位失败**——组件真的起不来）；另有 `rowPhasePending: "等待依赖"` / `rowPhaseLoading: "加载中"` / `rowPhaseActive: "运行中"` / `rowPhaseUnloading: "卸载中"`；汇总行是 `partsCountFailed: "{count} 异常"`。
  所以**「异常」有两个来源**：包级 `statusProblem` 与组件级 `rowPhaseFailed`。看到「异常」二字先分它是哪一层——包级异常常常只是元信息读不到，组件其实照跑；组件级异常才是真起不来。记忆里「『异常』＝包记录 error，非 fiber 失败」这句**只能覆盖包级一半**，实测词典里组件级同样写「异常」（`rowPhaseFailed`），落笔以词典为准。
  「**包不可用**」的原文键是 `statusMissingFiles`——字面就是**文件缺失**，不要读成「manifest 解析不可得」这类语义猜测；它指向的是「依赖登记了、文件找不到」，排查入口是磁盘而不是代码。
- **解法**：
  - 判定「到底加载了没」，**别读标签，读三层证据**：① 组件级相位是不是 `rowPhaseActive`（这是`运行中`，但它只是**当前**相位快照）；② 宿主进程 `StartTime` 与插件 `package.json` / 补丁文件的 mtime 比对——**进程比文件早 = 文件改完之后进程还没重载，等于没加载**（判据同 §6.7）；③ 崩溃/启动日志里有没有这一轮的条目（见 §1.22「日志缺席也是证据」）。
  - 「包不可用」→ 直接查那几条依赖在 profile 的 `node_modules` 里在不在、软链断没断。本机是 `link:` 形态挂载（`%USERPROFILE%\.dsh\profiles\desktop\package.json` 里 `dsh-maid-vcp` 等多条为 `link:D:/…`），源目录被改名/移走就整条断。
  - 「异常」→ 点进详情看 `reasonLabel`（原因）那一行；包级异常且有 `metadataError: "包元信息错误：{error}"` 时，问题在 `package.json` 而不在运行时。
- **验证**：**未验证**——本条是「读对标签含义」的判据条目，没有对应的一次实测回归。可复算的部分已做过：上面每个中文串对应的**键名**都在本机 `resources\app.asar` 内直接取证到（`statusProblem` / `statusMissingFiles` / `statusBeta` / `rowPhaseFailed` / `rowPhasePending` / `rowPhaseLoading` / `rowPhaseActive` / `rowPhaseUnloading` / `partsCountFailed` / `reasonLabel` / `metadataError`，2026-10-18 实测）。
- **教训**：**同一个中文词在同一页面上指两件事的时候，去词典里找键名，别在界面上猜。** 排查插件「起了没」，标签只作线索，真判据是「进程 vs 文件时间」加「这一轮日志有没有它」。
> 证据：记忆 lesson `0mvcn9q2k`（异常＝包记录 error / 包不可用＝依赖已登记但文件不可得）；本机 asar 词典键名实测（修正了记忆里「异常只指包级」的表述）· 2026-10-18 补录

### 1.22 `bundle.test.mjs` 报「未找到 dsh-web-frontend bundle」——测试环境里没有那块 bundle，不是补丁坏了

- **症状**：跑 `node tests/bundle.test.mjs` 直接崩在断言上：`AssertionError [ERR_ASSERTION]: 未找到 dsh-web-frontend bundle`，随后是一串栈。补丁本身装得上、页面也正常，唯独离线测试红。——注意：现行 `tests/bundle.test.mjs:34` 已经是 `ok('渲染开关 dsh.rawHtml', …)`，**原始那行 assert 已随修复重写，未取证到当时原文**。
- **原因**：这个测试要读的是**桌面端 asar 里**那份前端产物（`resources\app.asar` 内 `dsh-web-frontend/dist/assets/index-*.js`，asar 内条目名形如 `bundle-index-5SrrfWpU.js`），不是仓里的源码。裸跑时既没给目标路径、也没替用户去猜安装位置，于是用来断言的对象本身是 `undefined` —— 报出来像「补丁坏了」，其实是**被检对象不在场**。补丁器本体在没有这块 bundle 时也会打一行同类提示（`patch/patch-frontend-asar.cjs:556`：`'[v10] asar 内未找到 dsh-web-frontend 的 dist bundle（index-*.js）。'`）。
- **解法**：把「找 bundle」这件事从各个测试里抽出来，做成一个只读模块——
  1. 新增 `tests/_bundle.mjs`：`loadBundle(target)` 优先吃显式参数，其次读环境变量 `DSH_ASAR`，再走 `patch/asar-io.cjs` 的 asar 读取（`readAsar` + `listPacked`），最后回落到目录分支；匹配用 `const entryRE = /\/dsh-web-frontend\/dist\/assets\/index-[\w-]+\.js$/`。文件内注释明写**只读，绝不解包到安装目录**。
  2. `tests/bundle.test.mjs` 改为 `import { loadBundle } from './_bundle.mjs'`，从 `loadBundle(process.argv[2])` 拿 `{ source, text }`。
  3. 新增 `tests/bundle-location.test.mjs`：只测「定位逻辑」本身（传目录、传 app.asar、传 env 三种入参），与渲染断言解耦——定位一旦坏了，不会再伪装成「补丁坏了」。
  4. `tests/README.md` 写清跑法：`node tests/bundle.test.mjs <bundle 或 app.asar 路径>`，或先 `set DSH_ASAR=…`。定位不到时抛的是明确文案：`未找到 dsh-web-frontend bundle；请传 bundle/app.asar 路径或设置 DSH_ASAR`（`tests/_bundle.mjs:42`）。
- **验证**：修复提交 `309628a`（`test: support read-only desktop bundle validation`）。收尾实测口径：bundle 39 项通过 / 定位回归 10 项通过 / anchors 10 组通过 / fontface 5 用例通过 / diff 检查通过。
- 与 §1.9 不是一回事：1.9 是**测试自身依赖**缺（绝对路径 / 可选依赖），本条是**被检对象**缺。
> 证据：`tests/_bundle.mjs:6`、`:42`；`tests/bundle.test.mjs:13`、`:15`；`tests/bundle-location.test.mjs`；`patch/patch-frontend-asar.cjs:556`；提交 `309628a`；会话 `ff303029` #12、`session-adce7769` #1168（候选 `_r3-session.md` S8）

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

### 2.18 【已证伪·存档】忘了写标记也不该念卡片：`stripTtsCards()` 兜底

> ⚠️ **历史勘误与证伪归档（2026-10-19 真机实跑复现）**：
> 本节原先记录的「卡片在前漏写标记会念出卡片文字」因果关系**已被证伪**。
> 2026-10-19 拿真实插件产物（`lib/text-B7NACAYZ.js`）跑端到端断言证明：`removeTtsMarkup` 早在切段（`firstTtsSegment`）前就已经剥除了卡片根节点，**卡片文字根本不可能进入朗读切段**。
> 之前报障「没念重点」的真实根因是：回复者连续 22 条漏写标记，导致系统退回 `first-segment` 念出了开场白（如「收到，维持1.2」），而非念了卡片。
> 此节保留仅作历史排查防踩坑存档；具体兜底机制与事故复现见 `dsh-maid-tts-fix` TROUBLESHOOTING §2.10 与 §2.11。

- **症状（历史记录）**：卡片在前、正文在后，漏写 `<!--tts:…-->`，一按朗读念出来的是卡片上的字（标题、按钮文字、装饰文案），而不是正文。
- **根因（历史认知）**：`readScope=first-segment` 的首段兜底取的是「清洗后文本的头 160 字」；卡片可见文字正好排在前面，于是首段＝卡片。这是兜底策略的必然结果，不是渲染错。
- **解法**：tts-fix **0.6.5** 起在 `removeTtsMarkup` 入口、`stripTtsStyleBlocks` 之前挂了 `stripTtsCards(value)`，把 `id="vcp-root"` 开标签到配平 `</div>` 的整块剥掉；三条边界是有意的——剥完 `trim()` 为空则原样返回、未闭合卡片（流式中间帧）不动、卡片在末尾时正文保留。`lib/selfcheck.js` 有 4 条 `APPLIED_MARKERS` 对应（`function stripTtsCards(value) {`、`let text = stripTtsCards(stripTtsStyleBlocks(` 各 @text/@client）。**但这是保险不是替代**：仍应正常写标记。
- **验证**：故意写一条「卡片 + 正文、无标记」，点朗读念出的应是正文首段，卡片文字一句都不该出现。
- 来源：tts-fix `lib/edits-v309.js:57-90`、`lib/selfcheck.js:62-65`；tts-fix 事故单 2.10 / 2.11。

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

### 4.10 第三方插件自带渲染视图，会整条绕过宿主渲染补丁——装的插件没错，是它没走这条链

- **症状**：宿主渲染补丁明明在场（标记搜得到、计数正常、ASAR 也认），卡片却跟没打补丁一模一样：`<div id="vcp-root">` 整段当源码印出来、`<!--tts:-->` 这类标记也显形。而且**不是每次对话都这样**——切到某个视图/某段时间之后才出问题，或者换个会话就正常。
- **原因**：宿主渲染补丁改的是**宿主自己的消息渲染函数**（见 §1.13 / §1.20 改的那一处）。**第三方插件如果注册了一个独立会话视图、并在里面自建整条 markdown 渲染链，那条链上根本没有宿主补丁。** 2026-10-17 的判例是 `dsh-better-display`（已卸载，**现已不在本机，包的源码不可复核，以下结构引自当时取证**）：
  - 它注册 `conversation.view`，`id: "reader"`，`order: -5`（排在宿主默认视图前面）；
  - 进入策略 `(requested || view == null) && view !== "reader" ? "reader" : null`——**只要没显式选过视图，就默认进 reader**；
  - 正文渲染 `case "text"` 分支里，只有 `source === "user"` 走官方 `MarkdownText`，**助手消息一律走它自建的 `ReadingMarkdown`**（`mdast-util-from-markdown` + `micromark` + `katex` 整条独立链）；
  - 在它的整包里搜 `vcp-root`、`stripHtmlComments` **零命中**——即它压根不认识本插件注入的 HTML 与注释标记，于是卡片成了纯文本、注释成了可见文字。
  这解释了「**为什么有的地方好、有的地方坏**」：用户消息走宿主官方渲染（有补丁），助手消息走自建渲染（无补丁）。所以看到「只有我的卡片坏、引用块/表格都正常」时，别只怀疑本插件。
- **解法**：**先分它是「插槽装饰」还是「独立视图 / 替换渲染器」**——这是本节唯一的判断动作，一次就能定生死：
  - **插槽装饰型**（往宿主已渲染的内容里追加东西、或在边栏加面板）：它不接管正文渲染，**与宿主渲染补丁共存**，放心装。
  - **独立视图 / 替换渲染器型**（注册 `conversation.view`、或自己 span 掉 `case "text"` 的 render）：**宿主补丁不在链上，必冲突**。要么别装，要么让它认本插件的标记（它的包里得有 `vcp-root` / `stripHtmlComments` 这两个识别点，缺一个就等于不认识）。
  实操判据：**拿插件的整包 grep 一遍 `vcp-root` 与 `stripHtmlComments`，零命中就是它了**——这比读它的源码逻辑快得多。卸掉之后如果卡片立刻恢复，判据闭环。
- **验证**：**未验证（本条无法在本机闭环）**——判例插件已卸载，本机 `%USERPROFILE%\.dsh\profiles\desktop\` 下已无 better-display 残留（`package.json` / 备份件 / `node_modules` 均查过），**无法重放该故障**。能复算的是**现象的反面**：本机当前环境（无该插件）下 asar 内 `vcp-root` 命中 27 次、`stripHtmlComments` 命中 7 次，卡片渲染正常——与「链上有没有补丁」这一解释一致。诊断顺序仍以 §1.19 为先（先查 asar 升级有没有把补丁抹掉），两条都排除了再怀疑第三方视图。
- **教训**：**「补丁在」和「补丁生效」之间还隔着一个「谁在渲染」**。渲染入口被换掉时，盘上、下发、甚至 integrity 全都正常，怪象只在运行时出现——这类故障不要往补丁本身查，往「渲染链的入口是谁」查。
> 证据：记忆 fact `0mvbe3kxo`（`dsh-better-display` 判例，源码结构引自已卸载包）；本机 asar 标记计数与 profile 残留反查 · 2026-10-18 补录

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

### 6.8 宿主日志只在崩溃时写文件——「找不到日志」本身就是一条证据（附进程时间判据）

- **症状**：出过崩溃之后去翻日志，找不到「常驻日志」这种东西，目录里全是一堆 `crash-<时间戳>-<source>.log`，于是没法判断「这一轮到底有没有问题」；另一种表现是反过来——刚改完插件，行为一点没变，看着像是改动没生效，但文件明明保存了。
- **原因**：**宿主不写常驻日志，只在崩溃时落一个文件。** 文件名形如 `crash-2026-10-17T14-36-00-198Z-main.log`，`<source>` 有三种：`main`（壳进程崩溃，文件里带 `--- error ---` 与 `--- host diagnostic ---` 两段）、`web-boot`（boot 阶段的渲染侧）、`host`（Host 进程）。本机实测（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\`，10 个文件）**全部**是 crash-* 形态，最早的 `crash-2026-10-13T21-39-30-833Z-web-boot.log` 也只有 1863 B——这份目录没有「历史全量日志」，只有「事故快照」。于是有两条判读规则：
  - **规则一（日志缺席＝间接证据）**：新启动之后如果**没有出现新的** `crash-*-web-boot.log`，说明这一轮没有条目在 boot 阶段未激活，可以作为「已经修好」的**间接**证据。注意是间接——它只证明「没崩」，不证明「功能对」。
  - **规则二（进程比文件早＝还没加载）**：插件/补丁文件改完之后，宿主进程如果不重启就还在跑旧代码。判据是**宿主进程 `StartTime` 与 `package.json` / 补丁文件的 mtime 比对**：进程时间早于文件时间＝这一轮没加载到新代码。**不能拿 fiber 相位 active 当「已加载」的证据**——那只是内存里当前相位的快照，读不出它跑的是哪一版文件。
- **解法**：
  - 崩溃取证：**按时间戳配对**。同一时刻的 `crash-…-main.log` 与 `crash-…-web-boot.log` 是**同一次事故的两端**，先读 `main.log`（根因通常在 `--- host diagnostic ---` 段里，带 cordis 的调用栈与 `code` 字段），`web-boot.log` 往往只是受害者（另见 §1.18）。
  - 判断「修好没」：重启后看 `logs\` 有没有新增文件；同时按 §6.7 的判据比对 `Get-Process | ? {$_.ProcessName -match 'DeepSeek Harness'} | select StartTime` 与文件 `stat`——**两个都过，才算这一轮真的加载了新东西**。
  - 空文件也算记录：`crash-2026-10-16T00-57-11-466Z-host.log` 是 **0 字节**，它不是损坏，是「崩了但没来得及写内容」。别因为它是空的就删掉或跳过。
  - 配对不上就别硬凑：只有一个 `web-boot.log` 而没有同时刻 `main.log` 时，多半是 boot 阶段的问题（对应 §1.13 / §1.15），先按那两条查。
- **验证**：已复算——本机 `logs\` 目录 10 个文件的完整清单与字节数（`crash-2026-10-13T21-39-30-833Z-web-boot.log` 1863、`2026-10-14T13-15-19-613Z-web-boot.log` 1603、`2026-10-14T14-46-32-272Z-web-boot.log` 14054、`2026-10-16T00-57-11-466Z-host.log` 0、`2026-10-17T14-36-00-198Z-main.log` 5104、`2026-10-17T14-42-19-976Z-web-boot.log` 665、`2026-10-17T14-42-32-870Z-main.log` 1419、`2026-10-17T14-43-25-746Z-web-boot.log` 666、`2026-10-17T18-51-07-544Z-web-boot.log` 20612、`2026-10-17T22-28-24-706Z-host.log` 2562），且**目录里不存在非 crash-* 的日志文件**——直接印证「只在崩溃时写」。进程时间判据的用法同 §6.7 实测命令。
- **教训**：**日志系统的「没有」也是一种读数。** 排查时先说清「这个系统什么情况下会写、什么情况下不会写」，再谈「没找到＝没发生」成不成立；否则会把「没记录」误读成「没出事」。
> 证据：记忆 lesson `0mvcsgcak`（日志只在崩溃时写 / 日志缺席作间接证据 / 进程 StartTime vs 文件 mtime）；本机 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\` 目录实测 · 2026-10-18 补录

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

### 7.14 补丁验证必须分三层，「运行时层」现在还剩哪条通路（2026-10-18 修订）

- **症状**：补丁「装好了」——盘上字节变了、`curl` 下发的 bundle 里也搜得到特征串，可打开界面一看，现象一点没变。于是又开始怀疑补丁写错了、缓存没清、或者插件没加载，来回折腾几轮才发现补丁确实打对了，是**更下游的地方**出的问题。
- **原因**：**「代码在那儿」和「行为变了」是两件事，中间隔着两层。** 只验前两层，等于只证明文件写对了。三层是：
  - **① 盘上**：asar 条目字节确实变了（或改的是仓里的源文件）。证明「写进去了」。
  - **② 服务端下发**：宿主从 asar 读出来、经 HTTP 发出去的那份，与盘上一致。取法 `curl http://127.0.0.1:19387/assets/index-<id>.js`（**注意 bundle 文件名会换代**，当前实际 id 去 asar 里 `/dist/assets/` 看一眼，别照抄历史 id），比对里面有没有特征串、字节数与 asar 条目是否相等。证明「发出去的是改过的那份」。
  - **③ 运行时行为**：真人操作一遍看现象。**只有这一层能证明补丁真的生效。**
  2026-10-15 的实例就是这个坑：注释剥离补丁**盘上对、下发对，运行时照显形**——真因挂在更下游（`render` 开头有一句 `if (!v) return null`，先短路了，根本没走到剥离那一步）。当时正是因为第三层验不了，才误判了好几轮。
- **解法**：
  - **本层判据**：改完补丁先问自己「我现在验的是第几层」，第①②层过了**不许宣布修好**，必须有人真跑一遍第③层。
  - **曾经能自验第三层的通路（现已失效，别再找）**：2026-10-15 曾用「自签 cookie + 无头浏览器」绕过认证直接进 `19387` 看运行时——取 `%USERPROFILE%\.dsh\.credentials.yaml` 里 `client-connection / browser-session` 的 secret，按 cookie 签名算法自签（名 = `dsh-auth-` + base64url(sha256(authority))，值 = `v1.<base64url(payload)>.<base64url(hmacSha256(secret, body))>`，payload = `{version:1, authority, issuedAt, expiresAt}`），再用 `ego_cdp` 的 `Network.setCookie` 写入后 `location.reload()` 进 `19387`。**2026-10-16 起 ego-browser 已卸载，`ego_cdp` 通路不再可用**（本机 profile 里已无残留），签名实现所在的 `conn.js:284-305` 也**未能在本机取证到**（`profiles\*\node_modules` 下没有该文件），所以这条通路**只能作为历史记录**，不要照着做。
  - **现在第三层怎么验**：桌面壳是 `dsh-app://app/`，**壳内渲染只能肉眼**——没有可用的自动化通道。所以本仓的实践是：能自动化的用探针（§七·8，直接从源码抠真函数跑用例），**验不到的运行时现象老实标「未验证」**，等真人操作复测，不要用①②层的结果冒充。
  - **顺手排除 HTTP 缓存**：`curl -sI <bundle URL>`，响应头里**没有** `Cache-Control` / `ETag` / `Last-Modified` 时，Chromium 不做启发式缓存，可以直接排除缓存这条嫌疑（本机实测这三个头都没有）。有这三个头才需要谈清缓存。
- **验证**：**未验证（本机无运行时自验通路）**——① ② 层可复算：asar 内标记 `window.__vcpStable` 10 次、`window.__vcpGen` 5 次、`stripHtmlComments` 7 次、`vcp-root` 27 次（2026-10-18 实测）；`curl -sI` 无三个缓存头也已实测。③ 层（运行时）**本轮没有可用通路复测**，故本条只作方法论，不作「已修好」的依据。
- **教训**：**验证层级写进排查流程，别写进脑子。** 每次宣布修好之前先指认「我验的是第几层」，这一句能省掉后面半数返工。
> 证据：记忆 lesson `0mv8en07g`（三层验证 / 自签 cookie 通路 / ego-browser 已卸载 / v6.40→v6.41 三层全对但运行时错的实例 / `curl -sI` 缓存判据）；本机 asar 标记计数、`curl -sI` 响应头实测 · 2026-10-18 补录

## 附录 A、宿主版本兼容性盘点（0.2.1-rc.2，2026-10-18）

> 这份附录只记「装得上装不上」这一层，不替代正文里的排查条目。**状态一律以实测为准，没补的写「未补」，不许写成已完成。**

### A.1 这件事为什么值得单独记一节

- **症状**：升级后常见的就这几种——宿主升到新的 rc 之后，插件页里某个包直接装不上、或者装上了标「异常」；另一种是**全都装上了、也全都跑着，看着一切正常**——但宿主下一版按新规则判兼容时，这批包会被一并拒掉。前者当场能发现，后者要等下一次升级才炸。
- **原因**：宿主判兼容**优先看 `engines.dsh`，其次才看 peer 依赖**。本仓这一批插件（含 vcp 自己）历史上**只声明了 peer**（`@deepseek-ai/cordis` ＋ `react`），**没有 `engines.dsh` 字段**——所以「现在能装」靠的是 peer 恰好宽松，而不是声明了兼容范围。真正的兼容性事故样本已经出现过一次：`@nanmicoder/dsh-agent-teams` **0.1.23 因为漏列 rc.2 被宿主拒绝安装**，作者补出 0.1.25（精确 peer 到 rc.2）之后才装回去。也就是说，**peer 里少写一个版本号，就是「装不上」**——这个失败模式是实测过的，不是推测。
- **解法**：
  - 给每个自维护插件补 `engines.dsh`，值按「确实测过的那一段」写（别图省事写 `*`，那是把判定权扔了）。
  - 升级宿主之后的固定动作（本仓至少这两条）：① vcp 的 **asar 前端补丁必然失配**（落点仍是 `dsh-web-frontend/dist/assets/index-*.js`，bundle 名会换代），**须重跑 `node patch/install-all.cjs`（先 `--dry-run` 体检）**，重启后按 §1.19 / §1.20 验标记与改动面；② `19387` 相关的**端口硬编码**要改成从配置/宿主读，别再写字面量——本仓现存 `lib/index.js:1055` 一处代码（三个 origin 字面量 `http://127.0.0.1:19387` / `http://localhost:19387` / `http://[::1]:19387`）与 `README.md:205`、`README.en.md:188`、`DESIGN.md:170` 三处文档；**「四处硬编码」这一说法在代码侧只对得上一处**，其余在文档里。
- **验证**：**未补**——本节盘点项本身没有回归用例，只能靠「升级后重装一遍」验。

### A.2 本机实测盘点矩阵（清单表，2026-10-18，宿主机 0.2.1-rc.2）

**判定口径**：`engines.dsh` 有无只看 `package.json` 字面字段；peer 只列与宿主版本判定相关的那几条（`@deepseek-ai/cordis` 不进这条判定）。

| 插件 | 版本 | `engines.dsh` | 与宿主版相关的 peer | 状态 |
| --- | --- | --- | --- | --- |
| `dsh-maid-vcp` | 0.6.15 | 无 | `@deepseek-ai/cordis@^4.0.1`、`react@^18.3.1` | 未补 |
| `dsh-maid-tts-fix` | 0.6.6 | 无 | 同上（cordis / react） | 未补 |
| `dsh-maid-comfyui` | 0.5.5 | 无 | 含 `@deepseek-ai/dsh-settings@… \|\| ^0.2.0-rc.2` | 未补 |
| `dsh-maid-delegation` | 0.2.1 | 无 | cordis / react | 未补 |
| `dsh-maid-guard` | 0.3.2-fork.2 | 无 | 无 peer 声明 | 未补 |
| `dsh-maid-jasna` | 0.2.0 | 无 | cordis / react | 未补 |
| `dsh-maid-lane-fix` | 0.3.2 | 无 | cordis / react | 未补 |
| `dsh-maid-patch-kit` | 0.1.0 | 无 | cordis / react | 未补 |
| `dsh-maid-preset` | 0.7.11 | 无 | cordis / react | 未补 |
| `dsh-maid-scenery` | 0.2.3 | 无 | cordis / react | 未补 |
| `dsh-bili-scroll` | 0.1.8 | **有**：`>=0.1.7-rc.1` | `@deepseek-ai/dsh-tools@*`、`schemastery@*` | 已声明 |
| `dsh-our-free-model` | 2.5.1 | 无（只有 `engines.node`：`^22.19.0 \|\| >=24.0.0`） | 4 条 `^0.1.2-rc.1 \|\| ^0.1.7-rc.2 \|\| ^0.2.0-rc.1` ＋ `cordis@^4.0.2` ＋ `schemastery@^3.18.4` | 未补 |
| `@nanmicoder/dsh-agent-teams` | 0.1.25 | 无 | 精确 peer 到 rc.2（0.1.23 曾因漏列被拒） | 已装回 |
| `@michengai/archive-manager` | 1.1.0 | 无 | 作者已补 peer 至 rc.1 / rc.2 双 PASS | 已可用 |
| `@michengai/automation` | 1.0.0 | 无 | 同上 | 已可用 |
| `@michengai/im-connect` | 1.0.0 | 无 | 同上 | 已可用 |
| `@michengai/btw` | 1.0.0 | 无 | 同上 | 已可用 |
| `@michengai/simplify` | 1.0.1 | 无 | 同上 | 已可用 |
| `@michengai/skills-manager` | 1.2.5 | 无 | 同上 | 已可用 |

**读法**：**「已可用」和「已声明」是两件事**——`@michengai` 系与 agent-teams 靠 peer 补到位解决了眼前的装不上；**10 个 `dsh-maid-*` 与 `dsh-our-free-model` 仍是「靠 peer 宽松蒙过去」的状态，`engines.dsh` 一个都没补**。唯一的正面样本是 `dsh-bili-scroll`（`engines.dsh: ">=0.1.7-rc.1"`），照它的写法补齐即可。

**确认无影响的部分**：`invariant`、`stats`、`both`（b 站双写）、`dshHome`、`azure` 这几个此前逐个核过，升到 0.2.1-rc.2 前后行为一致，**没有待办**。

- **教训**：**兼容性不是「能装上」那一刻的状态，是「下一版还认不认你」的问题。** `engines.dsh` 缺着不会立刻出事，等宿主收紧判定时全体一起爆——所以这栏必须在平时补齐，而不是等升级当天补。

> 证据：记忆 topic `0mvc50k49`（0.2.1-rc.2 升级盘点 / agent-teams 0.1.23→0.1.25 / 9 插件缺 engines.dsh / 升级后必重跑 asar 补丁 / 19387 硬编码 / 零影响名单）；本机 `%USERPROFILE%\.dsh\profiles\desktop\package.json`（34 个依赖）与各插件 `package.json` 实测 · 2026-10-18 补录

## 暂未遇到（留白，供后续补记）

（暂无条目——遇到新问题按「症状 → 根因 → 解法 → 验证」四段式补记于此。）

---

## 待核

- Windows 之外的平台（macOS / Linux）安装与路径差异：**暂未遇到**，本册所有路径均为 Windows 形态。
- 插件在 Web 端（非 Electron）的实际渲染问题：**暂未遇到**（本机只用桌面端，Web 补丁器有意不随桌面端迭代）。
- 上游 `plolpl789/dsh-raw-html` 复活后的回并流程：**暂未遇到**（上游已停更，本仓为接管维护分支）。

---

*—— 小困整理 · 2026-10-16 · 症状照抄实测、解法附出处，禁止照搬没验证过的结论 ——*
