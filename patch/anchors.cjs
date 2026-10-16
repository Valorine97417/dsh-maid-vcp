/**
 * patch/anchors.cjs —— 安装器锚点 / 引擎文本单一来源（七仓体检 2026-11-06 抽取）。
 *
 * 背景：同一 bundle 形态锚点曾在 patch-frontend.cjs / install-v6.cjs / vcp-safe.cjs /
 * upgrade-patch.cjs / patch-frontend-asar.cjs 五处重复内嵌（各份仅分号或单条正则之差），
 * 前端一改全体失配——throw 保护只能 fail-loud 拦住，不能自动同步。本文件收拢
 * **逐字节相同**的真重复与 style 危险属性正则积木；各安装器 require 本文件。
 *
 * 有意差异（保留在各安装器本地，不并入本文件）：
 *   - vcp-safe.cjs V2_SAFE：v2 引擎「去增量」变体（与 V2_ENGINE 是替换对，不是重复）；
 *   - upgrade-patch.cjs OLD：v1 形态（升级起点锚点）；
 *   - patch-frontend.cjs CASE_HTML_BEFORE/AFTER、VC_LOOP_BEFORE/AFTER、CONTENT_RE_BEFORE/AFTER、
 *     STYLE_REF_BEFORE/AFTER、BC_BEFORE/AFTER：同文件内的历史形态演进锚点对，各只此一份、
 *     相邻可见，不构成跨文件漂移源；
 *   - install-v6.cjs CASE_ORIG/VC_ORIG/CASE_ENHANCED_START+END/VC_ENHANCED_START+END/VC_NEW_START+END/
 *     VC_DEF_NEW_BEFORE/SCRIPT_FILTER(_NEW)：install-v6 独有的区间替换锚点。
 *
 * 运行时前提：本文件与使用方同目录（patch/）。安装器均以磁盘绝对路径运行
 * （install-all.cjs 用 spawnSync(process.execPath, [path.join(scriptDir, ...)])），
 * CJS require('./anchors.cjs') 按 __dirname 解析、与 cwd 无关——与
 * patch-frontend-asar.cjs 既有的 require('./asar-io.cjs') 同模式。
 */
'use strict'

// ---- case"html" 分支形态演进链 ----
// 老前端代际参数 (n,r,i) 用 i.streaming；新前端 rc.8+ 代际参数 (n,i,l) 用 l.streaming。
const CASE_HTML_V6_LEGACY = String.raw`case"html":return function(){if(typeof localStorage!=="undefined"&&localStorage.getItem("dsh.rawHtml")==="1"){try{var vr=window.__vcpStable&&window.__vcpStable.render(n.value,i.streaming);if(vr!==null&&vr!==undefined)return vr}catch(e){}}return n.value}();`
const CASE_HTML_V6_NEW_LEGACY = String.raw`case"html":return function(){if(typeof localStorage!=="undefined"&&localStorage.getItem("dsh.rawHtml")==="1"){try{var vr=window.__vcpStable&&window.__vcpStable.render(n.value,l.streaming);if(vr!==null&&vr!==undefined)return vr}catch(e){}}return n.value}();`
const CASE_HTML_V7 = String.raw`case"html":return function(){if(typeof localStorage!=="undefined"&&localStorage.getItem("dsh.rawHtml")!=="0"){try{var vr=window.__vcpStable&&window.__vcpStable.render(n.value,i.streaming);if(vr!==null&&vr!==undefined)return vr}catch(e){if(typeof console!=="undefined")console.warn("[vcp] html 渲染异常，已回退源码",e)}}else if(typeof console!=="undefined")console.warn("[vcp] html 渲染已关闭（dsh.rawHtml===\"0\"，</> 按钮可重新开启）");return n.value}();`
const CASE_HTML_V7_NEW = String.raw`case"html":return function(){if(typeof localStorage!=="undefined"&&localStorage.getItem("dsh.rawHtml")!=="0"){try{var vr=window.__vcpStable&&window.__vcpStable.render(n.value,l.streaming);if(vr!==null&&vr!==undefined)return vr}catch(e){if(typeof console!=="undefined")console.warn("[vcp] html 渲染异常，已回退源码",e)}}else if(typeof console!=="undefined")console.warn("[vcp] html 渲染已关闭（dsh.rawHtml===\"0\"，</> 按钮可重新开启）");return n.value}();`

// ---- case"code" 围栏兜底四态（v6.30→v6.35 状态机）----
const CODE_CASE_RAW = String.raw`case"code":return wp(n,r,i);`
const CODE_CASE_V1 = String.raw`case"code":{try{const _v=(n.value||"").trim();if(/^<div\s+id=["']vcp-root["']/i.test(_v)){const _r=window.__vcpStable&&window.__vcpStable.render(n.value,i.streaming);if(_r!==null&&_r!==undefined)return _r}}catch(_e){}return wp(n,r,i)}`
const CODE_CASE_V2 = String.raw`case"code":{try{const _v=(n.value||"").trim();if(typeof localStorage!=="undefined"&&localStorage.getItem("dsh.rawHtml")==="1"&&/^<div\s+id=["']vcp-root["']/i.test(_v)){const _r=window.__vcpStable&&window.__vcpStable.render(n.value,i.streaming);if(_r!==null&&_r!==undefined)return _r}}catch(_e){}return wp(n,r,i)}`
const CODE_CASE_V3 = String.raw`case"code":{try{const _v=(n.value||"").trim();if(typeof localStorage!=="undefined"&&localStorage.getItem("dsh.rawHtml")!=="0"&&/^<div\s+id=["']vcp-root["']/i.test(_v)){const _r=window.__vcpStable&&window.__vcpStable.render(n.value,i.streaming);if(_r!==null&&_r!==undefined)return _r}}catch(_e){if(typeof console!=="undefined")console.warn("[vcp] code 围栏渲染异常，已回退代码块",_e)}return wp(n,r,i)}`

// ---- vc()/Xu() 定义前注入锚点（老代际）----
const VC_DEF_BEFORE = String.raw`}function vc(n,r){`

// ---- style 危险属性正则积木 ----
// 供 install-v6 的 VC_V6/VC_V6_NEW 与 patch-frontend-asar 的 buildGenShim stripStyle 拼接；
// 两代 VC_V6 均用词边界版 CONTENT_WB（旧版无边界 content 正则只存在于 patch-frontend.cjs
// 的本地历史锚点 CONTENT_RE_BEFORE，未抽积木）。
const STYLE_RE_FIXED = String.raw`position\s*:\s*fixed\s*;?`
const STYLE_RE_ZINDEX = String.raw`z-index\s*:\s*\d{4,}\s*;?`
const STYLE_RE_CONTENT_WB = String.raw`(?<![\w-])content\s*:[^;]*;?`

// ---- v2 加速引擎全文（upgrade-patch.NEW = vcp-safe.V2_OLD，逐字节同文）----
const V2_ENGINE = String.raw`case"html":return function(){if(!i.streaming&&typeof localStorage!=="undefined"&&localStorage.getItem("dsh.rawHtml")==="1"){try{const F=window.__vcpFast||(window.__vcpFast={c:new Map(),last:"",el:null,hits:0,builds:0,ms:0,lastLog:0}),t0=typeof performance!=="undefined"&&performance.now?performance.now():0;if(F.c.has(n.value)){F.hits++;if(t0&&performance.now()-F.lastLog>2000){F.lastLog=performance.now();console.debug("[vcp-fast] HIT size="+F.c.size+" hits="+F.hits+" builds="+F.builds)}return F.c.get(n.value)}let R=null;if(F.last!==""&&F.el!==null&&n.value.startsWith(F.last)&&(/<\/[a-zA-Z][^>]*>\s*$/.test(F.last)||/<[a-zA-Z][^>]*\/>\s*$/.test(F.last))){const tb=new DOMParser().parseFromString(n.value.slice(F.last.length),"text/html").body,to=[];for(let k=0;k<tb.childNodes.length;k++)to.push(vc(tb.childNodes[k],k));if(to.length===0)R=F.el;else R=f.jsx(f.Fragment,{children:[F.el,to.length===1?to[0]:f.jsx(f.Fragment,{children:to})]})}else{const b=new DOMParser().parseFromString(n.value,"text/html").body;if(!b.childNodes.length)return null;const o=[];for(let k=0;k<b.childNodes.length;k++)o.push(vc(b.childNodes[k],k));R=o.length===1?o[0]:f.jsx(f.Fragment,{children:o})}F.c.set(n.value,R);if(F.c.size>200)F.c.clear();F.last=n.value;F.el=R;F.builds++;if(t0){F.ms+=performance.now()-t0;if(performance.now()-F.lastLog>2000){F.lastLog=performance.now();console.debug("[vcp-fast] BUILD size="+F.c.size+" avg="+(F.ms/F.builds).toFixed(2)+"ms last="+n.value.length)}}return R}catch(e){}}return n.value}();`

module.exports = {
  CASE_HTML_V6_LEGACY, CASE_HTML_V6_NEW_LEGACY, CASE_HTML_V7, CASE_HTML_V7_NEW,
  CODE_CASE_RAW, CODE_CASE_V1, CODE_CASE_V2, CODE_CASE_V3,
  VC_DEF_BEFORE,
  STYLE_RE_FIXED, STYLE_RE_ZINDEX, STYLE_RE_CONTENT_WB,
  V2_ENGINE,
}
