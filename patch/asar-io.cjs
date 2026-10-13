#!/usr/bin/env node
/**
 * dsh-raw-html —— app.asar 读写工具（原地替换内部文件）
 *
 * Electron 的 asar 格式：
 *   偏移 0    u32 = 4                      （pickle 头）
 *   偏移 4    u32 = jsonLen + 8
 *   偏移 8    u32 = jsonLen + 4
 *   偏移 12   u32 = jsonLen
 *   偏移 16   JSON 目录树（UTF-8）
 *   偏移 16+jsonLen  数据区（所有 packed 条目首尾相接）
 *
 * 要点（血泪教训）：
 *   - 条目的 offset / size 是**字符串**，必须 Number() 后再算。
 *   - packed 区是**紧排**的，中间没有空隙：改任何一个条目的 size，
 *     它之后所有条目的 offset 都要整体平移 → 只能整段重建数据区。
 *   - 每个条目带 integrity（sha256 + blockSize + blocks），改内容后必须
 *     重算 hash 与 blocks，否则 Electron 校验不过。
 *   - 正在运行的 Electron 会**把 asar 头缓存到内存**，磁盘改了也要重启才生效；
 *     且 jsonLen 变化会让 HTTP 层按旧偏移取字节 → 前端读到错位的 JS → 白屏。
 *   - 直接 rename 覆盖会 EBUSY（文件被进程持有）→ 必须原地 ftruncate + 分块回写。
 */
'use strict'

const fs = require('node:fs')
const crypto = require('node:crypto')

const HEADER_SIZE = 16
const DEFAULT_BLOCK_SIZE = 4194304

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')

/** 读入 asar：返回 { header, jsonLen, dataStart, data, total } */
function readAsar(file) {
  const total = fs.statSync(file).size
  const fd = fs.openSync(file, 'r')
  try {
    const hb = Buffer.alloc(HEADER_SIZE)
    fs.readSync(fd, hb, 0, HEADER_SIZE, 0)
    const jsonLen = hb.readUInt32LE(12)
    if (jsonLen <= 0 || HEADER_SIZE + jsonLen > total) {
      throw new Error('asar 头解析失败：jsonLen=' + jsonLen + '，文件大小=' + total)
    }
    const raw = Buffer.alloc(jsonLen)
    fs.readSync(fd, raw, 0, jsonLen, HEADER_SIZE)
    const header = JSON.parse(raw.toString('utf8'))
    const dataStart = HEADER_SIZE + jsonLen
    const data = Buffer.alloc(total - dataStart)
    if (data.length) fs.readSync(fd, data, 0, data.length, dataStart)
    return { header, jsonLen, dataStart, data, total }
  } finally {
    fs.closeSync(fd)
  }
}

/** 列出所有 packed 条目（按 offset 升序） */
function listPacked(header) {
  const out = []
  const walk = (node, prefix) => {
    for (const [name, v] of Object.entries(node.files || {})) {
      const p = prefix + '/' + name
      if (v.files) { walk(v, p); continue }
      out.push({ path: p, node: v })
    }
  }
  walk(header, '')
  return out
    .filter((e) => !e.node.unpacked)
    .sort((a, b) => Number(a.node.offset) - Number(b.node.offset))
}

/** 按正则找条目路径（返回第一个匹配） */
function findEntry(header, re) {
  const hit = listPacked(header).find((e) => re.test(e.path))
  return hit ? hit.path : null
}

/** 读取某条目的内容 */
function readEntry(asar, entryPath) {
  const e = listPacked(asar.header).find((x) => x.path === entryPath)
  if (!e) throw new Error('asar 内未找到条目：' + entryPath)
  const off = Number(e.node.offset)
  const size = Number(e.node.size)
  return asar.data.subarray(off, off + size)
}

/**
 * 替换某条目内容，返回**整个新 asar 的 Buffer**（不落盘）。
 * 会重建数据区、平移后续 offset、重算 integrity。
 */
function replaceEntry(asar, entryPath, newBuf) {
  const all = listPacked(asar.header)
  const idx = all.findIndex((x) => x.path === entryPath)
  if (idx < 0) throw new Error('asar 内未找到条目：' + entryPath)
  const T = all[idx]
  const off = Number(T.node.offset)
  const oldSize = Number(T.node.size)

  // 紧排校验：从目标到末尾必须首尾相接，且末尾正好等于数据区长度
  let end = off + oldSize
  for (let i = idx + 1; i < all.length; i++) {
    if (Number(all[i].node.offset) !== end) {
      throw new Error('packed 区非紧排，无法安全重建：' + all[i].path)
    }
    end += Number(all[i].node.size)
  }
  if (end !== asar.data.length) {
    throw new Error('packed 区末尾(' + end + ') 与数据区长度(' + asar.data.length + ') 不符')
  }

  const delta = newBuf.length - oldSize
  const newData = Buffer.alloc(asar.data.length + delta)
  asar.data.copy(newData, 0, 0, off)
  newBuf.copy(newData, off)
  asar.data.copy(newData, off + newBuf.length, off + oldSize, asar.data.length)

  T.node.size = newBuf.length
  if (T.node.integrity) {
    const bs = T.node.integrity.blockSize || DEFAULT_BLOCK_SIZE
    T.node.integrity.hash = sha256(newBuf)
    const blocks = []
    for (let o = 0; o < newBuf.length; o += bs) {
      blocks.push(sha256(newBuf.subarray(o, Math.min(o + bs, newBuf.length))))
    }
    T.node.integrity.blocks = blocks
  }
  for (let i = idx + 1; i < all.length; i++) {
    const n = all[i].node
    const v = Number(n.offset) + delta
    n.offset = typeof n.offset === 'string' ? String(v) : v
  }

  const json = Buffer.from(JSON.stringify(asar.header), 'utf8')
  const hb = Buffer.alloc(HEADER_SIZE)
  hb.writeUInt32LE(4, 0)
  hb.writeUInt32LE(json.length + 8, 4)
  hb.writeUInt32LE(json.length + 4, 8)
  hb.writeUInt32LE(json.length, 12)
  return Buffer.concat([hb, json, newData])
}

/**
 * 原地写回（规避 EBUSY）：ftruncate 到目标长度后**从后往前**分块回写。
 * 不用 rename / 不用 copyFile —— 运行中的 Electron 持有该文件句柄。
 */
function writeInPlace(file, buf, chunkSize = 8 * 1024 * 1024) {
  const fd = fs.openSync(file, 'r+')
  try {
    fs.ftruncateSync(fd, buf.length)
    let pos = buf.length
    while (pos > 0) {
      const len = Math.min(chunkSize, pos)
      const off = pos - len
      fs.writeSync(fd, buf, off, len, off)
      pos = off
    }
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

module.exports = {
  HEADER_SIZE,
  sha256,
  readAsar,
  listPacked,
  findEntry,
  readEntry,
  replaceEntry,
  writeInPlace,
}
