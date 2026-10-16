#!/usr/bin/env node
/**
 * dsh-maid-vcp —— 前端渲染补丁器 v10（代际自适应 · 支持 app.asar 与独立 bundle）
 *
 * 为什么有这一版：
 *   dsh-web-frontend 的 dist bundle 是压缩过的，**每次 dsh 升级，压缩器都会重新
 *   命名符号**（jsx runtime 从 f→l、React 从 R→j、style 解析器从 hp→kb、DOM→React
 *   转换器从 vc(n,r)→vc(e,n) 换签名……）。老补丁器把锚点写死在脚本里，升级一次就
 *   全线失效，只能人工重新考古一遍符号表。
 *
 *   本脚本反过来做：**先扫描 bundle 自己推导符号表，再按符号表生成锚点**。
 *   探测不到的增强能力（code 围栏兜底 / markdown 空行修复）自动跳过并告警，
 *   基础渲染能力照常安装，不再"一处失配、全盘中止"。
 *
 * 安装内容（按能力分级）：
 *   [必需] A. case"html" 三态化 + window.__vcpStable.render
 *   [必需] B. 代际适配 shim（window.__vcpGen：jsx / DOM→React / style 解析）
 *   [必需] C. 注入 v6-inject 稳定区模块（SVG / Mermaid / KaTeX / 流式固化）
 *   [增强] E. case"code" 围栏兜底（模型把卡片包进 ```html 时仍渲染）
 *   [增强] F. markdown 组件空行修复（__vcpStable.fixBlank）
 *
 * 用法：
 *   node patch/patch-frontend-asar.cjs                        # 自动探测 app.asar
 *   node patch/patch-frontend-asar.cjs <app.asar>             # 指定 asar
 *   node patch/patch-frontend-asar.cjs <bundle.js> [out.js]   # 直接改独立 bundle
 *   node patch/patch-frontend-asar.cjs --dry-run              # 只探测不写入
 */
'use strict'

const anchors = require('./anchors.cjs')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const asarIO = require('./asar-io.cjs')

const INJECT_SRC = fs.readFileSync(path.join(__dirname, 'v6-inject.js'), 'utf8')
const V6_MARK = 'window.__vcpStable'
const ASAR_ENTRY_RE = /dsh-web-frontend[/\\]dist[/\\]assets[/\\]index-[\w-]+\.js$/

const log = (...a) => console.log('[v10]', ...a)
const warn = (...a) => console.warn('[v10]', ...a)

// ============ 一、符号表探测 ============
// 原则：全部从 bundle 自身推导，不写死任何压缩后变量名。
function topSymbol(text, re) {
  const m = new Map()
  let x
  while ((x = re.exec(text))) m.set(x[1], (m.get(x[1]) || 0) + 1)
  const s = [...m.entries()].sort((a, b) => b[1] - a[1])
  return s.length ? s[0] : null
}

function detectSymbols(t) {
  const sym = {}

  // jsx runtime：出现次数最多的 `.jsx(` 接收者（新代际 l / 老代际 f）
  const jsx = topSymbol(t, /([A-Za-z_$][\w$]*)\.jsx\(/g)
  sym.jsx = jsx && jsx[0]

  // React：`.useRef(` 出现最多的接收者（新代际 j / 老代际 R）
  const react = topSymbol(t, /([A-Za-z_$][\w$]*)\.useRef\(/g)
  sym.react = react && react[0]

  // style 解析器：`.style=<fn>(` 的接收者（新代际 kb / 老代际 hp）
  const style = topSymbol(t, /\.style=([A-Za-z_$][\w$]*)\(/g)
  sym.style = style && style[0]

  // case"html" 的 value 变量 + 紧邻的 case"code" 三参调用（第三个参数即渲染上下文）
  const html = /case"html":return ([A-Za-z_$][\w$]*)\.value;/.exec(t)
  sym.htmlValue = html && html[1]

  const code = /case"code":return ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\);/.exec(t)
  if (code) {
    sym.codeFn = code[1]
    sym.codeArgs = [code[2], code[3], code[4]]
  }

  // 渲染上下文变量（streaming 标记挂在它身上）——优先取 case"code" 的第三参
  sym.ctx = null
  if (sym.codeArgs && t.includes(sym.codeArgs[2] + '.streaming')) sym.ctx = sym.codeArgs[2]
  if (!sym.ctx) {
    for (const c of ['o', 'i', 'l', 'r']) {
      if (new RegExp(`\\b${c}\\.streaming\\b`).test(t)) { sym.ctx = c; break }
    }
  }

  // DOM→React 数组转换器（新代际签名换过：vc(n,r) 旧 → vc(e,n) 数组版）
  // 注意：新代际这个 vc 是 Uc 的数组包装，**不能直接当 DOM→React 用**，
  // 它只用来当注入锚点（保证注入点与 jsx/React 别名同作用域）。
  const injectCands = [
    /function ([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{return [A-Za-z_$][\w$]*\.map\([A-Za-z_$][\w$]*=>[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.node,[A-Za-z_$][\w$]*\.key,[A-Za-z_$][\w$]*\)\)\.filter\([A-Za-z_$][\w$]*=>[A-Za-z_$][\w$]*!==null\)\}/,
    /function ([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{/,
  ]
  sym.injectAnchor = null
  for (const re of injectCands) {
    const m = re.exec(t)
    if (m && t.split(m[0]).length - 1 === 1) { sym.injectAnchor = m[0]; break }
  }

  // markdown 组件（memo + useRef ×2）——增强能力 F 的锚点，15 个捕获组
  const memoRe = /const ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.useRef\(null\),([A-Za-z_$][\w$]*)=\2\.useRef\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=\2\.useMemo\(\(\)=>([A-Za-z_$][\w$]*)\?\(\(\1\.current===null\|\|\3\.current!==\4\)&&\(\1\.current=new ([A-Za-z_$][\w$]*)\(\4\),\3\.current=\4\),\1\.current\.render\(([A-Za-z_$][\w$]*)\)\):\(\1\.current=null,([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\4,([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\),\[([A-Za-z_$][\w$]*),\6,\4,([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\]\);/
  const memo = memoRe.exec(t)
  sym.memoAnchor = memo && t.split(memo[0]).length - 1 === 1 ? memo : null

  return sym
}

function describeSymbols(s) {
  const rows = [
    ['jsx runtime', s.jsx],
    ['React', s.react],
    ['style 解析器', s.style || '(无 · 老代际才有)'],
    ['case"html" value', s.htmlValue],
    ['case"code" 渲染', s.codeFn ? `${s.codeFn}(${(s.codeArgs || []).join(',')})` : '(未探测到)'],
    ['渲染上下文 ctx', s.ctx || '(未探测到 · streaming 标记将省略)'],
    ['注入锚点', s.injectAnchor ? s.injectAnchor.slice(0, 70) + '…' : '(未探测到)'],
    ['markdown 锚点', s.memoAnchor ? '已捕获 (' + s.memoAnchor[0].length + ' 字节)' : '(未探测到)'],
  ]
  for (const [k, v] of rows) log('  ' + k.padEnd(18, ' ') + ' = ' + v)
}

// ============ 二、按符号表生成补丁片段 ============
function buildGenShim(s) {
  // shim 内引用 bundle 的模块作用域变量（jsx / React / style），故必须注入在同作用域。
  const styleLine = s.style
    ? `var _style = ${s.style}`
    : `var _style = null`
  const styleFn = s.style
    ? `return _style(stripStyle(sv))`
    : `return {}`
  return String.raw`;(function(){
  try {
    var _jsx = ${s.jsx}, _R = ${s.react}
    ${styleLine}
    if (!_jsx || !_R) return
    function stripStyle(sv){
      return String(sv || '')
        .replace(/${anchors.STYLE_RE_FIXED}/gi, '')
        .replace(/${anchors.STYLE_RE_ZINDEX}/gi, '')
        .replace(/${anchors.STYLE_RE_CONTENT_WB}/gi, '')
    }
    var LOCK_RE = /^(color|font-family|font-size|font-weight|font-style|line-height|letter-spacing|text-align|text-shadow)$/
    function hp(sv){ ${styleFn} }
    function makeRef(sv){
      var raw = String(sv || '').split(';')
      return function(el){
        if (!el || !el.style || !el.style.setProperty) return
        for (var i = 0; i < raw.length; i++) {
          var d = raw[i], j2 = d.indexOf(':')
          if (j2 === -1) continue
          var p = d.slice(0, j2).trim(), v = d.slice(j2 + 1).trim()
          if (v && LOCK_RE.test(p)) el.style.setProperty(p, v, 'important')
        }
      }
    }
    function trusted(){
      try { return !!(window.__vcpTrusted && window.__vcpTrusted()) } catch (e) { return false }
    }
    function vc(node, key){
      if (!node) return null
      if (node.nodeType === 3) return node.textContent
      if (node.nodeType !== 1) return null
      var tag = node.localName
      if (tag === 'script' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
        if (!trusted()) return null
      }
      var props = { key: key }
      var attrs = node.attributes
      for (var i = 0; i < attrs.length; i++) {
        var c = attrs[i]
        if (c.name === 'onclick') {
          var m = /^input\s*\(\s*['"]([\s\S]*?)['"]\s*\)\s*;?\s*$/.exec(c.value)
          if (m) props.onClick = (function(cmd){ return function(){ var fn = window.__dshInput; fn && fn(cmd) } })(m[1])
          continue
        }
        if (/^on/i.test(c.name)) continue
        if (c.name === 'style') {
          props.style = hp(c.value)
          props.ref = makeRef(c.value)
          continue
        }
        if (c.name === 'class') { props.className = c.value; continue }
        if (c.name === 'href' && !/^(https?:|mailto:|\/|#)/i.test(c.value)) continue
        if (c.name === 'src' && !/^(https?:|data:image\/|\/|#)/i.test(c.value)) continue
        if ((c.name === 'action' || c.name === 'formaction' || c.name === 'xlink:href') && !/^(https?:|mailto:|\/|#)/i.test(c.value)) continue
        props[c.name] = c.value
      }
      var kids = []
      var cn = node.childNodes
      for (var k = 0; k < cn.length; k++) {
        var el = vc(cn[k], k)
        if (el !== null && el !== undefined) kids.push(el)
      }
      if (kids.length === 0) return _R.createElement(tag, props)
      return _R.createElement.apply(null, [tag, props].concat(kids))
    }
    window.__vcpGen = { jsx: _jsx, vc: vc, hp: hp, version: 'v10' }
  } catch (e) {
    try { if (typeof console !== 'undefined') console.warn('[vcp] 代际 shim 初始化失败', e) } catch (e2) {}
  }
})();
`
}

/** v6-inject 适配：__vcpVc/__vcpHp 改走 window.__vcpGen；jsx 别名经 shim 注入 */
function adaptInject(src, useShim) {
  let s = src
  if (useShim) {
    const before1 = `  function __vcpVc() {\n    var fn = typeof vc === 'function' ? vc : (typeof Xu === 'function' ? Xu : null)\n    return fn && fn.apply(null, arguments)\n  }`
    const after1 = `  function __vcpVc() {\n    var G = window.__vcpGen\n    return G && G.vc ? G.vc.apply(null, arguments) : null\n  }`
    const before2 = `  function __vcpHp(s) {\n    var fn = typeof hp === 'function' ? hp : (typeof jd === 'function' ? jd : (typeof Sd === 'function' ? Sd : null))\n    return fn ? fn(s) : {}\n  }`
    const after2 = `  function __vcpHp(s) {\n    var G = window.__vcpGen\n    return G && G.hp ? G.hp(s) : {}\n  }`
    if (s.indexOf(before1) === -1) throw new Error('v6-inject 未找到 __vcpVc 原文')
    if (s.indexOf(before2) === -1) throw new Error('v6-inject 未找到 __vcpHp 原文')
    s = s.replace(before1, after1).replace(before2, after2)
  }
  const open = ';(function () {\n'
  if (s.indexOf(open) === -1) throw new Error('v6-inject 未找到 IIFE 开头')
  s = s.replace(open, ';(function () {\n  var f = window.__vcpGen && window.__vcpGen.jsx\n  if (!f) return\n')
  return s
}

function buildHtmlCase(s) {
  const V = s.htmlValue
  const streamArg = s.ctx ? `!!(${s.ctx}&&${s.ctx}.streaming)` : 'false'
  return String.raw`case"html":{if(typeof localStorage!=="undefined"&&localStorage.getItem("dsh.rawHtml")!=="0"){try{var _vr=window.__vcpStable&&window.__vcpStable.render(${V}.value,${streamArg});if(_vr!==null&&_vr!==undefined)return _vr}catch(_ve){if(typeof console!=="undefined")console.warn("[vcp] html 渲染异常，已回退源码",_ve)}}else if(typeof console!=="undefined")console.warn("[vcp] html 渲染已关闭（dsh.rawHtml===\"0\"）");return ${V}.value}`
}

function buildCodeCase(s) {
  const V = s.htmlValue
  const streamArg = s.ctx ? `!!(${s.ctx}&&${s.ctx}.streaming)` : 'false'
  const call = `${s.codeFn}(${s.codeArgs.join(',')})`
  // v10.3：判据从「**以** <div id="vcp-root" 开头」放宽成「**含**」——原来那条 ^ 锚定
  // 只要围栏前面多一行说明（或一行 tts 朗读标记）就整卡失效、退回代码块显示源码。
  return String.raw`case"code":{try{var _cv=(${V}.value||"").trim();if(typeof localStorage!=="undefined"&&localStorage.getItem("dsh.rawHtml")!=="0"&&/<div\s+id=["']vcp-root["']/i.test(_cv)){var _cr=window.__vcpStable&&window.__vcpStable.render(${V}.value,${streamArg});if(_cr!==null&&_cr!==undefined)return _cr}}catch(_ce){if(typeof console!=="undefined")console.warn("[vcp] code 围栏渲染异常，已回退代码块",_ce)}return ${call}}`
}

/**
 * G. case"inlineCode" 注释兜底（v10.3 · 2026-10-16）。
 *
 * 事故：朗读标记被写成 **Markdown 行内代码**（反引号包裹 `<!--tts:…-->`）时，
 * CommonMark 把它交给 case"inlineCode" 分支渲染成 <code> —— 而注释剥离只挂在
 * 走 render() 的 case"html" / case"code" 两条分支上，inlineCode 没接补丁，
 * 于是尖括号注释原样显形（先生两次截图报障）。
 *
 * 修法：在 inlineCode 分支入口加一道**极窄**的守卫——只有「原文以 <!-- 开头，
 * 且把完整注释剥掉之后什么都不剩（或剩下的仍以 <!-- 开头，即残缺标记）」时才
 * 拦截，交给 render 剥成空 Fragment；普通行内代码一个字节都不碰。
 */
function buildInlineCodeGuard(tokenVar, ctxVar) {
  const streamArg = ctxVar ? `!!(${ctxVar}&&${ctxVar}.streaming)` : 'false'
  return String.raw`try{var _iv=${tokenVar}.value||"";if(typeof localStorage!=="undefined"&&localStorage.getItem("dsh.rawHtml")!=="0"&&/^\s*<!--/.test(_iv)){var _is=_iv.replace(/<!--[\s\S]*?-->/g,"");if(_is.trim()===""||/^\s*<!--/.test(_is)){var _ir=window.__vcpStable&&window.__vcpStable.render(_iv,${streamArg});if(_ir!==null&&_ir!==undefined)return _ir}}}catch(_ie){if(typeof console!=="undefined")console.warn("[vcp] inlineCode 注释兜底异常，已回退行内代码",_ie)}`
}

/** 渲染上下文变量名：优先用符号表探测结果，其次从**已打补丁**的分支里反推 */
function resolveCtxVar(t, sym) {
  if (sym && sym.ctx && t.includes(sym.ctx + '.streaming')) return sym.ctx
  const m = /\.value,!!\(([A-Za-z_$][\w$]*)&&\1\.streaming\)/.exec(t)
  if (m && t.includes(m[1] + '.streaming')) return m[1]
  for (const c of ['o', 'i', 'l', 'r']) {
    if (new RegExp(`\\b${c}\\.streaming\\b`).test(t)) return c
  }
  return null
}

/**
 * G 项的独立安装函数——设计成**可重复调用、可不依赖符号表**：
 * 主流程（首次安装）与「已是 v10 形态」的升级路径都要调它。原因见文件头
 * 「v10.1 模块整段升级」注释：A/E/F 三项锚点补丁在 v10 形态下无法二次定位，
 * 而 inlineCode 分支没被前几项动过，锚点仍在，所以 G 项可以随时补装。
 * 顺带把 E 项的旧判据（带 ^ 锚定）就地放宽。
 */
function patchInlineCode(t, ctxVar) {
  const applied = []
  const skipped = []

  // E′ 旧判据放宽（已装机上的老形态）
  const codeOldRe = '&&/^<div\\s+id=["\']vcp-root["\']/i.test(_cv)'
  const codeNewRe = '&&/<div\\s+id=["\']vcp-root["\']/i.test(_cv)'
  if (t.includes(codeOldRe)) {
    if (t.split(codeOldRe).length - 1 === 1) {
      t = t.replace(codeOldRe, codeNewRe)
      applied.push('E′ case"code" 判据放宽（去 ^ 锚定）')
    } else {
      skipped.push('E′ case"code" 判据出现多份，跳过放宽')
    }
  }

  // G 本体
  if (/case"inlineCode":\{try\{var _iv=/.test(t)) {
    skipped.push('G case"inlineCode" 已含注释兜底')
    return { text: t, applied, skipped, changed: applied.length > 0 }
  }
  const m = /case"inlineCode":\{const ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.value\.replace\(/.exec(t)
  if (!m) {
    skipped.push('G case"inlineCode" 形态未知，跳过（不影响基础渲染）')
    return { text: t, applied, skipped, changed: applied.length > 0 }
  }
  const before = `case"inlineCode":{const ${m[1]}=`
  if (t.split(before).length - 1 !== 1) {
    skipped.push('G case"inlineCode" 锚点不唯一，跳过')
    return { text: t, applied, skipped, changed: applied.length > 0 }
  }
  const guard = buildInlineCodeGuard(m[2], ctxVar)
  t = t.replace(before, `case"inlineCode":{${guard}const ${m[1]}=`)
  applied.push('G case"inlineCode" 注释兜底')
  return { text: t, applied, skipped, changed: true }
}

function buildMemoAfter(m) {
  const [, ref1, R, ref2, state, memoVar, cond, cls, src, fn2, a1, a2, a3, dep1, dep3, dep4] = m
  return `const ${ref1}=${R}.useRef(null),${ref2}=${R}.useRef(${state}),_t=(function(){try{return window.__vcpStable&&window.__vcpStable.fixBlank?window.__vcpStable.fixBlank(${src}):${src}}catch(_fe){return ${src}}})(),${memoVar}=${R}.useMemo(()=>${cond}?((${ref1}.current===null||${ref2}.current!==${state})&&(${ref1}.current=new ${cls}(${state}),${ref2}.current=${state}),${ref1}.current.render(_t)):(${ref1}.current=null,${fn2}(_t,${state},${a2},${a3})),[_t,${cond},${state},${dep3},${dep4}]);`
}

/**
 * 已是 v10 形态时的「模块整段升级」路径（v10.1 · 2026-10-13）。
 *
 * 背景：v10 一旦装上，bundle 里就同时有了 __vcpStable 与 __vcpGen，于是
 * 旧逻辑直接短路 return —— 之后 patch/v6-inject.js 再修 bug（如 v6.39 混排
 * 自愈），重跑 install-all 也永远打不进去，只能手动改 asar。
 *
 * 现在改为：用模块自身的 START/END 标记夹取旧模块，整段替换为磁盘最新版
 * （经 adaptInject 做同样的代际适配，保证与首次注入形态一致）；内容相同则
 * 视为幂等、不写入。
 *
 * 注意：此路径只更新 C 项（v6 稳定区模块）。A/E/F 三项锚点补丁在已是 v10
 * 形态时无法二次定位（原文已被替换），需要它们升级时必须先还原原始 bundle。
 */
function updateInjectModule(t) {
  const START = '/*__DSH_V6_INJECT_START__*/'
  const END = '/*__DSH_V6_INJECT_END__*/'
  const i = t.indexOf(START)
  if (i === -1) return null
  const j = t.indexOf(END, i)
  if (j === -1) return null
  const endIdx = j + END.length
  const oldMod = t.slice(i, endIdx)
  // v10.2 · 2026-10-15：INJECT_SRC 是整文件，尾部那个换行不属于模块本体。带上它
  // 比较会让 oldMod 永远 != newMod，于是每次 install 都在 END 后多插一个换行——
  // 非幂等（bundle 每次 +1 字符，dry-run 永远报「整段升级」）。按模块本体切出来比。
  const full = adaptInject(INJECT_SRC, true)
  const ni = full.indexOf(START)
  const nj = ni === -1 ? -1 : full.indexOf(END, ni)
  const newMod = ni === -1 || nj === -1 ? full : full.slice(ni, nj + END.length)
  if (oldMod === newMod) {
    return { text: t, applied: ['已是 v10 形态，v6 模块已是最新，无需重复安装'], skipped: [], changed: false }
  }
  return {
    text: t.slice(0, i) + newMod + t.slice(endIdx),
    applied: ['C v6 稳定区模块整段升级（' + oldMod.length + ' → ' + newMod.length + ' 字符）'],
    skipped: [],
    changed: true,
  }
}

// ============ 三、补丁主流程 ============
function patchBundle(text) {
  const applied = []
  const skipped = []
  let t = text

  if (t.includes(V6_MARK) && t.includes('window.__vcpGen')) {
    const up = updateInjectModule(t)
    const base = up || { text: t, applied: ['已是 v10 形态，无需重复安装（未找到模块标记）'], skipped: [], changed: false }
    // v10.3：v10 形态下 A/E/F 锚点无法二次定位，但 case"inlineCode" 分支没被前几项动过，
    // G 项（含 E′ 判据放宽）随时可补装——所以升级路径不能直接 return。
    const g = patchInlineCode(base.text, resolveCtxVar(base.text, null))
    if (g.changed) {
      return {
        text: g.text,
        applied: base.applied.concat(g.applied),
        skipped: base.skipped.concat(g.skipped),
        changed: true,
        upgradeOnly: true,
      }
    }
    if (g.skipped.length) base.skipped = base.skipped.concat(g.skipped)
    return base
  }

  const s = detectSymbols(t)
  log('探测到的代际符号表：')
  describeSymbols(s)

  // —— 必需项体检 ——
  const missing = []
  if (!s.jsx) missing.push('jsx runtime 别名')
  if (!s.react) missing.push('React 别名')
  if (!s.htmlValue) missing.push('case"html" 分支')
  if (!s.injectAnchor) missing.push('注入锚点')
  if (missing.length) {
    throw new Error('必需符号探测失败：' + missing.join('、') +
      '\n       可能 dsh 前端已换代到本脚本不认识的形态；请把上面「探测到的代际符号表」发给维护者。')
  }

  function replaceOnce(before, after, label) {
    const i = t.indexOf(before)
    if (i === -1) throw new Error('锚点缺失：' + label)
    if (t.indexOf(before, i + 1) !== -1) throw new Error('锚点不唯一：' + label)
    t = t.slice(0, i) + after + t.slice(i + before.length)
    applied.push(label + ' @' + i)
  }

  // A. case"html" 三态化
  const htmlBefore = `case"html":return ${s.htmlValue}.value;`
  if (t.includes(htmlBefore)) {
    replaceOnce(htmlBefore, buildHtmlCase(s), 'A case"html" 三态化')
  } else if (/case"html":\{if\(typeof localStorage/.test(t)) {
    skipped.push('A case"html" 已是三态化形态')
  } else {
    throw new Error('case"html" 分支形态未知，未做任何修改')
  }

  // E. case"code" 围栏兜底（增强）
  if (s.codeFn) {
    const codeBefore = `case"code":return ${s.codeFn}(${s.codeArgs.join(',')});`
    if (t.includes(codeBefore)) {
      replaceOnce(codeBefore, buildCodeCase(s), 'E case"code" 围栏兜底')
    } else if (/case"code":\{try\{var _cv=/.test(t)) {
      skipped.push('E case"code" 已含围栏兜底')
    } else {
      skipped.push('E case"code" 形态未知，跳过（不影响基础渲染）')
    }
  } else {
    skipped.push('E case"code" 未探测到渲染函数，跳过（不影响基础渲染）')
  }

  // F. markdown 空行修复（增强）
  if (s.memoAnchor) {
    replaceOnce(s.memoAnchor[0], buildMemoAfter(s.memoAnchor), 'F markdown 空行修复')
  } else {
    skipped.push('F markdown 组件锚点未探测到，跳过（不影响基础渲染）')
  }

  // G. case"inlineCode" 注释兜底（增强 · v10.3）
  {
    const g = patchInlineCode(t, s.ctx || resolveCtxVar(t, s))
    t = g.text
    for (const a of g.applied) applied.push(a)
    for (const a of g.skipped) skipped.push(a)
  }

  // B + C. 代际 shim + v6 稳定区模块
  const adapted = adaptInject(INJECT_SRC, true)
  replaceOnce(s.injectAnchor, buildGenShim(s) + adapted + '\n' + s.injectAnchor, 'B+C shim + v6 注入')

  return { text: t, applied, skipped, changed: true, symbols: s }
}

/** 健康检查：语法 + 关键特征 */
function healthCheck(bundleText, result, tmpDir) {
  const checks = [
    [bundleText.includes('window.__vcpStable'), 'v6 稳定区模块已注入'],
    [bundleText.includes('window.__vcpGen'), '代际 shim 已注入'],
    [bundleText.includes('__DSH_V6_INJECT_START__'), 'v6-inject 起始标记'],
    [bundleText.includes('__DSH_V6_INJECT_END__'), 'v6-inject 结束标记'],
    [bundleText.includes('window.__dshInput'), 'onclick 交互桥'],
    [bundleText.includes('case"inlineCode":{try{var _iv='), 'G inlineCode 注释兜底已注入'],
    [!bundleText.includes("/^<div\\s+id=[\"']vcp-root"), 'E case"code" 判据已放宽（无 ^ 锚定）'],
    [!/case"html":return [A-Za-z_$][\w$]*\.value;/.test(bundleText), '原始 case"html" 已消失'],
  ]
  // 关键：memo 替换后两个 useRef 声明必须仍在（v8 白屏事故就是这么来的）
  if (result.symbols && result.symbols.memoAnchor) {
    const m = result.symbols.memoAnchor
    checks.push([bundleText.includes(`const ${m[1]}=${m[2]}.useRef(null),${m[3]}=${m[2]}.useRef(${m[4]})`), 'memo 的 useRef 声明保留（防白屏）'])
  }
  let ok = true
  for (const [pass, label] of checks) {
    if (!pass) ok = false
    log((pass ? '  OK   ' : '  FAIL ') + label)
  }
  // 语法检查
  const tmp = path.join(tmpDir, '_v10check.mjs')
  fs.writeFileSync(tmp, bundleText, 'utf8')
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
    log('  OK   node --check')
  } catch (e) {
    ok = false
    console.error('  FAIL node --check\n' + String(e.stderr || e.stdout || e.message).split('\n').slice(0, 6).join('\n'))
  }
  try { fs.unlinkSync(tmp) } catch {}
  return ok
}

// ============ 四、目标定位 ============
function findAsar() {
  const arg = process.argv[2]
  if (arg && fs.existsSync(arg) && arg.endsWith('.asar')) return arg
  if (process.env.DSH_ASAR && fs.existsSync(process.env.DSH_ASAR)) return process.env.DSH_ASAR
  const cands = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'dsh', 'resources', 'app.asar'),
    path.join(process.env.PROGRAMFILES || '', 'dsh', 'resources', 'app.asar'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'dsh', 'resources', 'app.asar'),
    'D:/DeepSeek Harness/resources/app.asar',
  ]
  return cands.find((p) => p && fs.existsSync(p)) || null
}

function isBundleArg(a) {
  return !!a && fs.existsSync(a) && !a.endsWith('.asar') && /\.(js|mjs)$/i.test(a)
}

function main() {
  const dryRun = process.argv.includes('--dry-run')
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))

  console.log('==============================================')
  console.log(' dsh-maid-vcp 前端渲染补丁器 v10（代际自适应）')
  console.log('==============================================')

  // —— 模式一：独立 bundle 文件 ——
  if (isBundleArg(args[0])) {
    const src = args[0]
    const out = args[1] || src
    log('模式：独立 bundle')
    log('输入：' + src)
    const text = fs.readFileSync(src, 'utf8')
    const r = patchBundle(text)
    if (!r.changed) { log(r.applied[0]); return }
    if (!healthCheck(r.text, r, path.dirname(src))) { console.error('[v10] 健康检查未通过，未写入'); process.exit(1) }
    for (const a of r.applied) log('  ✓ ' + a)
    for (const a of r.skipped) warn('  - ' + a)
    if (dryRun) { log('--dry-run：不写入'); return }
    const bak = `${src}.bak-v10-${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(src, bak)
    log('备份：' + bak)
    fs.writeFileSync(out, r.text, 'utf8')
    log('已写入：' + out + '（' + text.length + ' → ' + r.text.length + '，+' + (r.text.length - text.length) + '）')
    return
  }

  // —— 模式二：app.asar ——
  const asarPath = findAsar()
  if (!asarPath) {
    console.error('[v10] 未找到 app.asar。用法：node patch/patch-frontend-asar.cjs <app.asar>')
    process.exit(1)
  }
  log('模式：app.asar')
  log('目标：' + asarPath)

  // 进程探测：补丁常在运行中的 DSH 里执行——v10.1 起 replaceEntry 为追加式+头部保长，
  // 运行中的进程不会因偏移平移而错位崩溃，但新内容必须重启后才生效。这里只提示不拦截。
  try {
    const tl = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { encoding: 'utf8', windowsHide: true })
    if (/DeepSeek Harness\.exe/i.test(tl)) {
      warn('检测到 DSH 正在运行：本次写入采用追加式（不会打崩当前进程），但补丁需完全退出并重启后生效。')
    }
  } catch { /* 探测失败不拦路 */ }

  const asar = asarIO.readAsar(asarPath)
  log('asar 大小 ' + asar.total + '，条目 ' + asarIO.listPacked(asar.header).length + ' 个')

  const entry = asarIO.findEntry(asar.header, ASAR_ENTRY_RE)
  if (!entry) {
    console.error('[v10] asar 内未找到 dsh-web-frontend 的 dist bundle（index-*.js）。')
    console.error('[v10] 若这是 web 版 dsh，请直接对 bundle 文件运行本脚本。')
    process.exit(1)
  }
  log('目标条目：' + entry)

  const cur = asarIO.readEntry(asar, entry)
  const curText = cur.toString('utf8')
  log('当前大小 ' + cur.length + ' 字节')
  const r = patchBundle(curText)
  if (!r.changed) { log(r.applied[0]); return }

  if (!healthCheck(r.text, r, require('node:os').tmpdir())) {
    console.error('[v10] 健康检查未通过，未写入（asar 未做任何修改）')
    process.exit(1)
  }
  for (const a of r.applied) log('  ✓ ' + a)
  for (const a of r.skipped) warn('  - ' + a)

  if (dryRun) { log('--dry-run：不写入'); return }

  // 备份（整份 asar 太大就只备份条目）：<安装根>\Works\_asar-backup
  const bakDir = path.join(path.dirname(asarPath), '..', 'Works', '_asar-backup')
  try {
    fs.mkdirSync(bakDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const bakFile = path.join(bakDir, 'bundle-' + path.basename(entry) + '.' + stamp)
    fs.writeFileSync(bakFile, cur)
    log('原条目已备份：' + bakFile)
  } catch (e) {
    warn('备份条目失败（继续）：' + e.message)
  }

  const newBuf = Buffer.from(r.text, 'utf8')
  log('重建 asar…')
  let whole
  try {
    whole = asarIO.replaceEntry(asar, entry, newBuf, { compactIntegrity: true })
    log('追加式写入（头部保长，运行中的进程不受影响）')
  } catch (e) {
    // 保长失败（header 超出旧 jsonLen）→ 只在 DSH 未运行时退回整段重建
    let running = false
    try {
      const tl = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], { encoding: 'utf8', windowsHide: true })
      running = /DeepSeek Harness\.exe/i.test(tl)
    } catch { /* 探测失败按未运行处理前先复核 */ }
    if (running) {
      console.error('[v10] ✗ ' + e.message)
      console.error('[v10]   且检测到 DSH 正在运行——整段重建会打崩运行中的进程，已中止，未写入。')
      console.error('[v10]   请完全退出 DSH 后重试。')
      process.exit(1)
    }
    warn('保长失败（' + e.message + '），DSH 未运行 → 退回整段重建（平移 offset）')
    // replaceEntry 失败前已把 header 改脏，重读一份干净的再重建
    const asar2 = asarIO.readAsar(asarPath)
    whole = asarIO.rebuildEntry(asar2, entry, newBuf)
  }
  log('新 asar 大小 ' + whole.length + '（' + (whole.length - asar.total >= 0 ? '+' : '') + (whole.length - asar.total) + '）')

  log('原地写回（规避 EBUSY）…')
  asarIO.writeInPlace(asarPath, whole)

  // 回读校验
  const back = fs.readFileSync(asarPath)
  const same = back.length === whole.length && asarIO.sha256(back) === asarIO.sha256(whole)
  log('回读校验：' + (same ? 'OK（大小与 sha256 一致）' : 'FAIL'))
  if (!same) {
    console.error('[v10] 回读不一致！请用备份恢复。')
    process.exit(1)
  }

  console.log('\n==============================================')
  console.log(' [v10] ✓ 完成')
  console.log(' 下一步：完全退出并重启 DSH（asar 头会被进程缓存，不重启看不到效果）')
  console.log('==============================================')
}

try {
  main()
} catch (e) {
  console.error('\n[v10] ✗ ' + e.message)
  console.error('[v10]   未写入任何损坏产物；若已备份可用备份恢复。')
  process.exit(1)
}
