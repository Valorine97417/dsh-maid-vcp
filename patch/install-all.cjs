#!/usr/bin/env node
/**
 * dsh-maid-vcp —— 一键安装器（v8.0 · 桌面端 / Web 端双形态）
 *
 * 依次把「HTML 渲染 + SVG/图表/公式 + 可信模式」装进 dsh 前端。
 *
 * 【形态自动分流】本脚本会先判断你在哪种 dsh 上：
 *
 *   桌面端（Electron · 前端 bundle 在 app.asar 内）
 *     → patch/patch-frontend-asar.cjs（v10 代际自适应补丁器）
 *       直接在 asar 内原地替换 bundle，自动重算 integrity、原地回写规避 EBUSY。
 *       这一步就把 A/B/C/E/F 五项能力一次装齐，无需其它子脚本。
 *
 *   Web 端 / 独立 bundle（前端是磁盘上的 index-*.js 文件）
 *     → install-v6.cjs（渲染能力）→ update-v6-inject.cjs（模块升级）
 *       → trusted-patch.cjs（可信模式条件放行）
 *
 * 为什么桌面端不再走 install-v6：老脚本的锚点是**写死的压缩后变量名**，
 * dsh 前端每次升级压缩器都会重新命名（jsx 从 f→l、React 从 R→j、vc(n,r)→vc(e,n)…），
 * 锚点一失效就全盘中止。v10 改成**先扫描 bundle 推导符号表、再生成锚点**，
 * 探测不到的增强能力自动跳过并告警，基础渲染照常安装。
 *
 * 幂等安全：所有补丁器都是幂等的（已装则跳过）；锚点不匹配时安全中止、不写入任何修改。
 * 每一步都带备份 + node --check 健康检查，失败自动回滚。
 *
 * 用法（人 & agent 通用）：
 *   node patch/install-all.cjs                    # 自动探测 app.asar / bundle
 *   node patch/install-all.cjs <app.asar>         # 指定桌面端 asar
 *   node patch/install-all.cjs <bundle.js>        # 指定 Web 端 bundle
 *   node patch/install-all.cjs --dry-run          # 只探测与体检，不写入
 *
 * 完成后：完全退出并重启 dsh → 强刷（Ctrl+F5）→ 打开「</>」开关。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const scriptDir = __dirname
const rawArgs = process.argv.slice(2)
const dryRun = rawArgs.includes('--dry-run')
const targetArg = rawArgs.find((a) => !a.startsWith('--')) || ''

console.log('==============================================')
console.log(' dsh-maid-vcp 一键安装器（v8.0）')
console.log('==============================================')

// ---------- 目标探测 ----------
function findAsar() {
  if (targetArg && targetArg.endsWith('.asar') && fs.existsSync(targetArg)) return targetArg
  const cands = [
    process.env.DSH_ASAR,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'dsh', 'resources', 'app.asar'),
    path.join(process.env.PROGRAMFILES || '', 'dsh', 'resources', 'app.asar'),
    'D:/DeepSeek Harness/resources/app.asar',
  ].filter(Boolean)
  return cands.find((p) => fs.existsSync(p)) || null
}

function findBundle() {
  if (targetArg && !targetArg.endsWith('.asar') && fs.existsSync(targetArg)) return targetArg
  if (process.env.DSH_WEB_FRONTEND_DIST && fs.existsSync(process.env.DSH_WEB_FRONTEND_DIST)) {
    return process.env.DSH_WEB_FRONTEND_DIST
  }
  const roots = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh-web-frontend'),
    path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-web-frontend'),
    path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-web-frontend'),
  ]
  for (const d of roots) {
    try {
      const assets = path.join(d, 'dist', 'assets')
      if (!fs.existsSync(assets)) continue
      const f = fs.readdirSync(assets).find((x) => /^index-[\w-]+\.js$/.test(x))
      if (f) return path.join(assets, f)
    } catch {}
  }
  return null
}

const asar = findAsar()
const bundle = asar ? null : findBundle()

let STEPS
if (asar) {
  console.log(' 形态: 桌面端（Electron）')
  console.log(' 目标: ' + asar)
  STEPS = [
    { name: '前端渲染补丁（v10 代际自适应 · asar 原地替换）', script: 'patch-frontend-asar.cjs', arg: asar },
  ]
} else if (bundle) {
  console.log(' 形态: Web 端 / 独立 bundle')
  console.log(' 目标: ' + bundle)
  STEPS = [
    { name: '渲染能力（v6 全量补丁 · HTML/SVG/图表/公式）', script: 'install-v6.cjs', arg: bundle },
    { name: '渲染模块升级（v6-inject 就地更新至最新，幂等）', script: 'update-v6-inject.cjs', arg: bundle },
    { name: '可信模式（vc/Xu 层条件放行 · 默认关闭保安全）', script: 'trusted-patch.cjs', arg: bundle },
  ]
} else {
  console.error('\n[install-all] ✗ 既没找到 app.asar，也没找到 dsh-web-frontend 的 dist bundle。')
  console.error('[install-all]   请手动指定：node patch/install-all.cjs <app.asar 或 bundle.js>')
  process.exit(1)
}

// ---------- 逐步骤执行 ----------
for (let i = 0; i < STEPS.length; i++) {
  const step = STEPS[i]
  console.log(`\n[install-all] 步骤 ${i + 1}/${STEPS.length}：${step.name}`)
  const args = [path.join(scriptDir, step.script), step.arg]
  if (dryRun) args.push('--dry-run')
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (r.error) {
    console.error(`[install-all] ✗ 步骤 ${i + 1} 执行异常：${r.error.message}`)
    console.error('[install-all] 请确认已安装 Node.js（node -v 可运行）。')
    process.exit(1)
  }
  if (r.status !== 0) {
    console.error(`[install-all] ✗ 步骤 ${i + 1} 失败（退出码 ${r.status}）。`)
    console.error('[install-all]   子脚本已安全中止、未写入损坏产物；请按上面日志排查后重试。')
    process.exit(r.status || 1)
  }
  console.log(`[install-all] ✓ 步骤 ${i + 1} 完成`)
}

console.log('\n==============================================')
if (dryRun) {
  console.log(' [install-all] --dry-run 完成：全部体检通过，未写入任何文件。')
} else {
  console.log(' [install-all] ✓ 全部补丁就位！')
  console.log(' 下一步：')
  console.log('   1. 完全退出并重启 dsh（桌面端必须重启：asar 头会被进程缓存）')
  console.log('   2. 强刷（Ctrl+F5）')
  console.log('   3. 打开「</>」开关（渲染/美学）')
  console.log('   4. 需要脚本能力时：localStorage.setItem("raw-html.trustedBadge","1") 唤出徽章')
  console.log(' 验证：DevTools console 可见 [vcp-stable] 日志；VCP 卡片正常渲染。')
}
console.log('==============================================')
