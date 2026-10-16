'use strict'
/**
 * patch/check-anchors.cjs —— 安装器锚点单一来源一致性自检（挂 npm test 链）。
 *
 * 背景（七仓体检 2026-10-17）：同一批 bundle 锚点曾 patch-frontend.cjs / install-v6.cjs /
 * vcp-safe.cjs / upgrade-patch.cjs / patch-frontend-asar.cjs 五处重复内嵌，前端一改全体失配。
 * 现已抽到 patch/anchors.cjs 单一来源。本脚本持久保障：
 *   1) anchors.cjs 可加载、导出齐全且非空、style 正则积木可编译；
 *   2) 五个安装器引用的每个 anchors.REF 都真实存在（防拼写漂移 / 误删导出）；
 *   3) 关键值代际特征正确（老前端代际参数 i.streaming / 新前端 rc.8+ 代际 l.streaming 等）；
 *   4) install-v6.cjs 的 VC_V6/VC_V6_NEW 模板插值求值结果包含全部 style 正则积木；
 *   5) patch-frontend-asar.cjs 的 stripStyle 函数体包含三处正则积木插值。
 * 任何一项失败退出码 1（fail-loud，安装器自身还有 throw 保护）。
 */
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert')
const A = require(path.join(__dirname, 'anchors.cjs'))

let n = 0
const ok = (msg) => { n++; console.log('  ok  ' + msg) }

// ---- 1. 导出齐全、非空 ----
const EXPECT_KEYS = [
  'CASE_HTML_V6_LEGACY', 'CASE_HTML_V6_NEW_LEGACY', 'CASE_HTML_V7', 'CASE_HTML_V7_NEW',
  'CODE_CASE_RAW', 'CODE_CASE_V1', 'CODE_CASE_V2', 'CODE_CASE_V3',
  'VC_DEF_BEFORE',
  'STYLE_RE_FIXED', 'STYLE_RE_ZINDEX', 'STYLE_RE_CONTENT_WB',
  'V2_ENGINE',
]
assert.deepStrictEqual(Object.keys(A).sort(), [...EXPECT_KEYS].sort(), 'anchors.cjs 导出清单漂移')
for (const k of EXPECT_KEYS) {
  assert.strictEqual(typeof A[k], 'string', k + ' 应为 string')
  assert.ok(A[k].length > 0, k + ' 不应为空')
}
ok('导出齐全且非空（' + EXPECT_KEYS.length + ' 项）')

// ---- 2. style 正则积木可编译且值精确 ----
assert.strictEqual(A.STYLE_RE_FIXED, 'position\\s*:\\s*fixed\\s*;?')
assert.strictEqual(A.STYLE_RE_ZINDEX, 'z-index\\s*:\\s*\\d{4,}\\s*;?')
assert.strictEqual(A.STYLE_RE_CONTENT_WB, '(?<![\\w-])content\\s*:[^;]*;?')
new RegExp(A.STYLE_RE_FIXED); new RegExp(A.STYLE_RE_ZINDEX); new RegExp(A.STYLE_RE_CONTENT_WB)
ok('STYLE_RE_* 三条积木精确且可编译')

// ---- 3. 代际特征 ----
assert.strictEqual(A.VC_DEF_BEFORE, '}function vc(n,r){')
assert.strictEqual(A.CODE_CASE_RAW, 'case"code":return wp(n,r,i);')
assert.ok(A.CODE_CASE_V1.includes('/^<div\\s+id'), 'CODE_CASE_V1 应为正则判定形态')
assert.ok(A.CODE_CASE_V2.includes('typeof loca') && A.CODE_CASE_V3.includes('typeof loca'), 'CODE_CASE_V2/V3 应为 localStorage 形态')
assert.ok(A.CODE_CASE_V1.length < A.CODE_CASE_V2.length && A.CODE_CASE_V2.length < A.CODE_CASE_V3.length, 'CODE_CASE 演进链长度序被破坏')
// 老前端代际参数 (n,r,i) 用 i.streaming；新前端 rc.8+ 代际参数 (n,i,l) 用 l.streaming
assert.ok(A.CASE_HTML_V6_LEGACY.includes('i.streaming'), 'CASE_HTML_V6_LEGACY 应为老代际 i.streaming')
assert.ok(A.CASE_HTML_V7.includes('i.streaming') && A.CASE_HTML_V7.includes('console.warn'), 'CASE_HTML_V7 应为老代际三态化形态')
assert.ok(A.CASE_HTML_V6_NEW_LEGACY.includes('l.streaming'), 'CASE_HTML_V6_NEW_LEGACY 应为新代际 l.streaming')
assert.ok(A.CASE_HTML_V7_NEW.includes('l.streaming'), 'CASE_HTML_V7_NEW 应为新代际 l.streaming')
assert.ok(A.CASE_HTML_V6_LEGACY.length < A.CASE_HTML_V7.length, 'case"html" 演进链长度序被破坏')
assert.ok(A.V2_ENGINE.includes('case"html"') && A.V2_ENGINE.includes('streaming') && A.V2_ENGINE.length > 1000, 'V2_ENGINE 特征不符')
ok('代际特征（i/l.streaming、演进链、引擎文本）')

// ---- 4. 五安装器引用完整性 ----
const INSTALLERS = ['patch-frontend.cjs', 'install-v6.cjs', 'vcp-safe.cjs', 'upgrade-patch.cjs', 'patch-frontend-asar.cjs']
const exportKeys = new Set(EXPECT_KEYS)
for (const f of INSTALLERS) {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8')
  assert.ok(src.includes("require('./anchors.cjs')"), f + ' 未引入 anchors 单一来源')
  const body = src.split("require('./anchors.cjs')").join('')
  const refs = new Set()
  for (const m of body.matchAll(/anchors\.(\w+)/g)) refs.add(m[1])
  for (const ref of refs) assert.ok(exportKeys.has(ref), f + ' 引用了不存在的 anchors.' + ref)
  ok(f + ' 引用完整性（' + refs.size + ' 个引用）')
}

// ---- 5. install-v6 模板插值求值含全部积木 ----
{
  const src = fs.readFileSync(path.join(__dirname, 'install-v6.cjs'), 'utf8')
  const evalTpl = (name) => {
    const m = new RegExp('const\\s+' + name + '\\s*=\\s*String\\.raw`').exec(src)
    assert.ok(m, 'install-v6.cjs 缺少 ' + name + ' 模板定义')
    const close = src.indexOf('`', m.index + m[0].length)
    return vm.runInNewContext(src.slice(m.index + m[0].length - 11, close + 1), { anchors: A })
  }
  for (const [name, head, helper, notHelper] of [
    ['VC_V6', 'for(const c of i.attributes)', 'hp(', 'so='],
    ['VC_V6_NEW', 'for(const d of l.attributes)', 'so=', 'hp('],
  ]) {
    const v = evalTpl(name)
    assert.ok(v.includes(A.STYLE_RE_FIXED) && v.includes(A.STYLE_RE_ZINDEX) && v.includes(A.STYLE_RE_CONTENT_WB), name + ' 插值后缺 style 正则积木')
    assert.ok(v.includes(head), name + ' 代际变量应为 ' + head)
    assert.ok(v.includes(helper) && !v.includes(notHelper), name + ' 内联 style 解析应为 ' + helper + ' 形态')
  }
  ok('install-v6 VC_V6 / VC_V6_NEW 插值求值含全部积木且代际正确')
}

// ---- 6. asar stripStyle 积木化 ----
{
  const src = fs.readFileSync(path.join(__dirname, 'patch-frontend-asar.cjs'), 'utf8')
  const m = /function stripStyle\(sv\)\{[\s\S]*?\n {4}\}/.exec(src)
  assert.ok(m, 'patch-frontend-asar.cjs 的 stripStyle 函数体未定位到')
  assert.ok(m[0].includes('${anchors.STYLE_RE_FIXED}') && m[0].includes('${anchors.STYLE_RE_ZINDEX}') && m[0].includes('${anchors.STYLE_RE_CONTENT_WB}'), 'stripStyle 应包含三处正则积木插值')
  ok('patch-frontend-asar stripStyle 积木化')
}

console.log('check-anchors: ' + n + ' 组断言全部通过')
