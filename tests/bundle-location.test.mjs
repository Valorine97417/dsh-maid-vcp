import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadBundle } from './_bundle.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-bundle-test-'))
const text = 'export const fixture = true;'
const entry = 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-changingHash.js'
const assets = path.join(root, 'frontend', 'dist', 'assets')
try {
  fs.mkdirSync(assets, { recursive: true })
  const file = path.join(assets, 'index-changingHash.js')
  fs.writeFileSync(file, text)
  assert.equal(loadBundle(file).text, text)
  assert.equal(loadBundle(path.join(root, 'frontend')).text, text)
  assert.equal(loadBundle(assets).text, text)
  let tree = { size: Buffer.byteLength(text), offset: '0' }
  for (const part of entry.split('/').reverse()) tree = { files: { [part]: tree } }
  const json = Buffer.from(JSON.stringify(tree))
  const header = Buffer.alloc(16)
  header.writeUInt32LE(4, 0)
  header.writeUInt32LE(json.length + 8, 4)
  header.writeUInt32LE(json.length + 4, 8)
  header.writeUInt32LE(json.length, 12)
  const archive = path.join(root, 'app.asar')
  fs.writeFileSync(archive, Buffer.concat([header, json, Buffer.from(text)]))
  assert.equal(loadBundle(archive).text, text)
  assert.equal(loadBundle(`${archive}!/${entry}`).text, text)
  assert.equal(loadBundle(`${archive}/${entry}`).text, text)
  const old = process.env.DSH_ASAR
  try {
    process.env.DSH_ASAR = archive
    assert.equal(loadBundle().text, text)
    process.env.DSH_ASAR = path.join(root, 'missing.asar')
    assert.throws(() => loadBundle(), /ENOENT/)
  } finally {
    if (old === undefined) delete process.env.DSH_ASAR
    else process.env.DSH_ASAR = old
  }
  fs.writeFileSync(path.join(assets, 'index-otherHash.js'), text)
  assert.throws(() => loadBundle(assets), /Expected one frontend bundle/)
  assert.throws(() => loadBundle(`${archive}!/missing.js`), /Expected one frontend bundle/)
  console.log('bundle-location: 10 assertions passed (file/package/assets/asar/internal path/env/fail-loud)')
} finally {
  // The target is exactly the private directory returned by mkdtemp above.
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
  assert.ok(path.basename(root).startsWith('vcp-bundle-test-'))
  fs.rmSync(root, { recursive: true, force: true })
}
