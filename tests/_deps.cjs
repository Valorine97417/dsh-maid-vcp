/**
 * tests/_deps.cjs —— 测试依赖定位器（去硬编码路径）
 *
 * 测试脚本需要 jsdom（DOM 仿真）与 puppeteer（真浏览器 e2e）。这两者都是
 * **可选**的开发期依赖，不进 package.json 的 dependencies（插件本体零运行时依赖）。
 * 本模块按下面顺序寻找它们，找到即用，找不到给出一条清晰的安装指引。
 *
 * 搜索顺序：
 *   1. 环境变量 DSH_RAW_HTML_DEPS      —— 指向任意含 node_modules 的目录
 *   2. 环境变量 NODE_PATH              —— Node 标准模块搜索路径（冒号/分号分隔）
 *   3. 本仓库自身的 node_modules        —— 从 tests/ 逐级向上找（支持 devDependency 安装）
 *   4. 本机已装的 dsh profile            —— $DSH_HOME/profiles/<name>/node_modules、
 *                                          $USERPROFILE/.dsh/profiles/<name>/node_modules
 *   5. npm 全局                          —— $APPDATA/npm/node_modules
 *   6. 历史遗留位置                      —— 早期开发机上的 VCPChat 项目（存在才用）
 *
 * 用法：
 *   const { jsdom, puppeteer } = require('./_deps.cjs')
 *   const { JSDOM } = jsdom()          // 未装时抛出带指引的错误
 *   const pptr = puppeteer({ optional: true })  // 未装时返回 null
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const here = __dirname

/** 收集候选 node_modules 根目录 */
function searchRoots() {
  const roots = []

  // 1) 显式环境变量
  const env = process.env.DSH_RAW_HTML_DEPS
  if (env) {
    roots.push(env)
    roots.push(path.join(env, 'node_modules'))
  }

  // 2) NODE_PATH
  const np = process.env.NODE_PATH || ''
  for (const p of np.split(path.delimiter)) if (p) roots.push(p)

  // 3) 本仓库自身：从 tests/ 逐级向上找 node_modules
  let dir = here
  for (let i = 0; i < 6; i++) {
    roots.push(path.join(dir, 'node_modules'))
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }

  // 4) 本机 dsh profile
  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
  const profiles = path.join(dshHome, 'profiles')
  try {
    for (const name of fs.readdirSync(profiles)) {
      roots.push(path.join(profiles, name, 'node_modules'))
    }
  } catch {}
  roots.push(path.join(profiles, 'node_modules'))

  // 5) npm 全局
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'))
  if (process.env.PREFIX) roots.push(path.join(process.env.PREFIX, 'lib', 'node_modules'))

  // 6) 历史遗留（早期开发机）
  roots.push('G:/AI/AI 助手/VCPChat-main/node_modules')

  return roots
}

/** 在候选根里找某个包，返回包目录或 null */
function findPackage(name) {
  for (const root of searchRoots()) {
    try {
      const pkgDir = path.join(root, ...name.split('/'))
      if (fs.existsSync(path.join(pkgDir, 'package.json'))) return pkgDir
    } catch {}
  }
  return null
}

/** 载入某个包；找不到时可选抛错或返回 null */
function load(name, opts = {}) {
  const pkgDir = findPackage(name)
  if (!pkgDir) {
    if (opts.optional) return null
    throw new Error(
      `[tests/_deps] 找不到可选测试依赖 "${name}"。\n` +
        `  它是开发期依赖，不属于插件运行时。安装任选其一：\n` +
        `    · 在本仓库装：  npm i -D ${name}\n` +
        `    · 或指向已有副本：set DSH_RAW_HTML_DEPS=<含 node_modules 的目录>\n` +
        `  搜索过的位置（前若干）：\n` +
        searchRoots()
          .slice(0, 6)
          .map((r) => '    ' + r)
          .join('\n')
    )
  }
  const req = createRequire(path.join(pkgDir, 'noop.js'))
  return req(pkgDir)
}

module.exports = {
  /** jsdom 模块（未装抛错） */
  jsdom: (opts) => load('jsdom', opts),
  /** puppeteer 模块（未装返回 null 或抛错） */
  puppeteer: (opts) => load('puppeteer', opts),
  /** 通用载入 */
  load,
  findPackage,
  /** 仓库根目录（tests/ 的上一级） */
  repoRoot: path.resolve(here, '..'),
}
