import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import asarIO from '../patch/asar-io.cjs'

const entryRE = /\/dsh-web-frontend\/dist\/assets\/index-[\w-]+\.js$/
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Read only: never invoke an installer or extract into the installation directory.
export function loadBundle(target) {
  if (target) {
    const split = target.indexOf('.asar')
    if (split >= 0) {
      const archive = target.slice(0, split + 5)
      const explicit = target.slice(split + 5).replace(/^[!\\/]+/, '').replaceAll('\\', '/')
      const asar = asarIO.readAsar(archive)
      const entries = asarIO.listPacked(asar.header).filter(e => entryRE.test(e.path))
      const entry = explicit ? entries.find(e => e.path === '/' + explicit) : entries.length === 1 ? entries[0] : null
      if (!entry) throw new Error(`Expected one frontend bundle in ${archive}; found: ${entries.map(e => e.path).join(', ') || '(none)'}`)
      return { source: `${archive}!${entry.path}`, text: asarIO.readEntry(asar, entry.path).toString('utf8') }
    }
    const absolute = path.resolve(target)
    if (fs.statSync(absolute).isDirectory()) {
      const assets = path.basename(absolute) === 'assets' ? absolute : path.join(absolute, 'dist', 'assets')
      const entries = fs.readdirSync(assets).filter(f => /^index-[\w-]+\.js$/.test(f))
      if (entries.length !== 1) throw new Error(`Expected one frontend bundle in ${assets}; found ${entries.length}`)
      return loadBundle(path.join(assets, entries[0]))
    }
    return { source: absolute, text: fs.readFileSync(absolute, 'utf8') }
  }
  // Explicit environment override must fail loudly rather than silently test another install.
  if (process.env.DSH_ASAR) return loadBundle(process.env.DSH_ASAR)
  const candidates = [
    path.join(path.dirname(process.execPath), 'resources', 'app.asar'),
    path.resolve(repo, '..', '..', 'resources', 'app.asar'),
    ...[process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'dsh'), process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'dsh')]
      .filter(Boolean).map(p => path.join(p, 'resources', 'app.asar')),
    ...[process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend'),
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh-web-frontend')].filter(Boolean),
  ]
  const found = candidates.find(p => fs.existsSync(p))
  if (!found) throw new Error('未找到 dsh-web-frontend bundle；请传 bundle/app.asar 路径或设置 DSH_ASAR')
  return loadBundle(found)
}
