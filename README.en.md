# dsh-raw-html · VCP Visual-Synesthesia Protocol Plugin

**[中文 README](./README.md) · [CHANGELOG](./CHANGELOG.md)**

Brings **VCP (Visual-Synesthesia)** to the DeepSeek Harness Web GUI:
HTML in messages goes from "a blob of source code" to a genuinely rendered interface,
and the agent outputs following a **maintainable design system**.

**Plug & play**: any computer, any agent — run the one-shot installer patch (`node patch/install-all.cjs`, rendering capability + Trusted Mode in one command)
+ install this plugin + toggle the **「</>」switch** in the browser → the browser renders HTML
(including SVG cards / Mermaid charts / KaTeX math), the agent follows the design spec
(design principles / Chinese typography / font pairing).

> The rendering capability (HTML/SVG/charts/math) is injected into the frontend bundle by the patch;
> the plugin provides the toggles and the protocol injection — see the **Install** section below.

> ## ⚠️ This repository is a locally-maintained fork
>
> The upstream [`plolpl789/dsh-raw-html`](https://github.com/plolpl789/dsh-raw-html) is **no longer maintained**.
> This fork takes over maintenance and carries local fixes that upstream does not have:
>
> | Fix | Location | What it does |
> |---|---|---|
> | Aesthetics panel shows "0 styles" | `lib/index.js` | Upstream's `ctx.inject(['connection'])` callback never fired, so the RPC channel was never registered; replaced with a direct `webServer` prefix route that replicates the host RPC envelope byte-for-byte (origin fence + failure-envelope normalization) |
> | White-on-white button hover | `lib/client.js` | 7 hover rules moved from `--dsw-alias-button-primary-fill` (near-white in dark theme) to `--dsw-alias-interactive-bg-hover-accent`, with text back on `--dsw-alias-label-primary` |
> | Trusted Mode on by default + badge hidden | `lib/client.js` | `isTrusted()` now defaults to trusted (only an explicit `'0'` disables it); the shield badge is not mounted by default, avoiding a collision with the `dsh-video-skin` floating pill `#dsvs-knobs-pill` |
> | Trimmed style library | `styles/` | Only `abyss-maid` is kept; the other 12 styles are archived |
>
> **Install via a `link:` local-directory dependency** (so `pnpm install` can never overwrite local edits):
>
> ```bash
> pnpm add "link:D:/DeepSeek Harness/Works/dsh-raw-html"
> ```
>
> **Why `link:` and not `file:`**: `link:` only creates a symlink in `node_modules` pointing at the source
> directory — `pnpm install` rebuilds the link and **never copies or overwrites the source**. Local fixes are
> therefore immune to any install. (`file:` directory dependencies copy the source into `node_modules` on
> install, so edits get shadowed by the copy; `github:` / `git+https:` dependencies re-download the tarball
> on every install — that is exactly what caused the "whole-package rollback" incident.)

## ✨ Gallery

> VCP cards rendered in real conversations (5 promo banners):

![Banner 1](docs/images/banner-1.jpg)
![Banner 2](docs/images/banner-2.jpg)
![Banner 3](docs/images/banner-3.jpg)
![Banner 4](docs/images/banner-4.jpg)
![Banner 5](docs/images/banner-5.jpg)

## 📣 What's New (v0.3.0 · patch v6.18)

**2026-08-24 updates**

- **Fixed (frontend compatibility)**: `install-v6.cjs` now supports **dsh-web-frontend 0.1.0-rc.8 / 0.1.1-rc.x** (bundle `index-CA9Bpko5.js` / `index-ClqxG24t.js`), where the minifier renamed `vc`→`Xu` and `hp`→`jd`/`Sd`. A new anchor set with automatic generation detection was added; legacy anchors (rc.5~rc.7) are kept intact and regression-verified.
- **Fixed (startup crash)**: removed the static `@deepseek-ai/schemastery` import from `lib/index.js` — the only third-party runtime dependency. It is now loaded dynamically with a graceful fallback, so the plugin boots fine even when `node_modules` is missing (static import chain is now built-in Node modules only).
- **Feature**: declarative color presets — write `data-vcp-preset="editorial|chiaroscuro|fauvism|cyberpunk|wabi_sabi"` and the built-in VCPColorEngine deterministically generates the whole `--vcp-*` palette (WCAG contrast & sRGB gamut closed-loop; hex never passes through the LLM; stable across streaming rebuilds).
- **Feature**: streaming anchor lock (CSS-only `overflow-anchor` lock) + cached ref closures — smoother streaming, no per-frame `setProperty` storms.
- **Protocol**: render/aesthetic split toggles; active visual-synesthesia prompting; flow discipline moved to the structural layer (measured output −4.6K tokens/turn, cost −¥0.056).

**Audit hardening (2026-08-21)**

- **Security (P0)**: fixed the `on*` attribute passthrough gap (only the `onclick` bridge is allowed); fixed the performance-timer diagnostics; aligned documentation references.
- **Performance (P1)**: fast guards for regex conversions, fixed the mermaid global-listener leak, protocol text slimmed by ~74%.
- **Fonts (P2)**: 12 built-in commercial fonts → **7 open-source fonts** (all OFL-licensed).
- **Enhancements**: `prefers-reduced-motion` accessibility, keyboard focus states, named constants for magic numbers.
- See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## Versioning

- **Plugin version**: the `version` in `package.json` (currently **0.6.5**), upgraded via `dsh plugin`.
- **Patch codename**: the evolution codename of the `patch/` injected modules, applied to the frontend bundle by the installer. The two evolve independently:
  - **Desktop (Electron)**: **v10 · generation-adaptive** (`patch/patch-frontend-asar.cjs`) — replaces the bundle in place inside `app.asar`, recomputes integrity, and writes back in place to dodge `EBUSY`. It **scans the bundle to derive the minified symbol table before generating anchors**, so a frontend upgrade that renames variables (jsx `f→l`, React `R→j`, `vc(n,r)→vc(e,n)`, …) is adapted automatically; enhancements it cannot detect are skipped with a warning while base rendering still installs.
  - **Web / standalone bundle**: **v6 · sub-version v6.38** (`patch/install-v6.cjs`), compatible with **0.0.1-rc.5 ~ 0.1.0-rc.7** and **0.1.0-rc.8 / 0.1.1-rc.x** (the `vc`/`hp` and `Xu`/`jd` minified shapes are auto-detected).

## Components

| Component | Path | Purpose |
|---|---|---|
| One-shot installer | `patch/install-all.cjs` | **Recommended**: auto-routes by environment — desktop goes to `patch-frontend-asar.cjs` (v10, in-place asar replace); web runs `install-v6.cjs` (rendering) + `update-v6-inject.cjs` (module upgrade) + `trusted-patch.cjs` (Trusted Mode vc gating). Idempotent + backup/rollback + `node --check` health check, aborts safely on anchor mismatch |
| Desktop patcher | `patch/patch-frontend-asar.cjs` | **v10 · generation-adaptive**: patches `dsh-web-frontend/dist/assets/index-*.js` inside `app.asar`; derives the symbol table first, then generates anchors (A `case"html"` tri-state / B+C generation shim + v6 injection / E `case"code"` fence fallback / F markdown blank-line fix); recomputes integrity and rewrites in place via `ftruncate` to dodge `EBUSY`, auto-rollback on failure |
| asar I/O library | `patch/asar-io.cjs` | Pure-Node asar parse / entry read / full repack (no third-party deps): 16-byte header + JSON directory tree + tightly packed data region, with integrity recomputation |
| Universal installer | `patch/install-v6.cjs` | Web-side rendering-capability full v6 patch (web branch step ① of install-all): auto-detects the dist bundle and applies the full v6 patch from any historical state (idempotent + backup/rollback + `node --check`) |
| Stable-state render module | `patch/v6-inject.js` | Incremental render engine injected into the bundle: container-aware block caching, streaming-tail placeholders, KaTeX math, Mermaid viewer; `onclick="input('...')"` bridge for real interaction; filters script/iframe/object/embed, `on*` events and `javascript:` protocols |
| **vcp-fast engine** | `patch/v6-inject.js` | Container-aware block-level incrementality: closed blocks cached (element references stay stable across frames → React skips diff → real looping animations), only the tail re-rendered; measured cache-hit **1200~6800×**, incremental **12×** speedup |
| Plugin (host side) | `lib/index.js` | Toggle state (**persisted to disk**) + VCP protocol injected into the system prompt + `/fonts` font service (**built-in + external library dual source**) + shared knowledge (the protocol carries the local DESIGN.md path for any agent) |
| Plugin (browser side) | `lib/client.js` | Injects the **「</>」toggle** next to the composer send button + exposes `window.__dshInput` (VCP button → fill & send) |
| **Built-in fonts** | `assets/fonts/` | **7 open-source fonts (woff2 subsets, ~7.6MB) shipped with the plugin** — WenKai / WenKai Light / MaShanZheng / HeiTi / HeiTi Light / HeiTi Bold / GreatVibes, all OFL-licensed, zero config |
| Design system docs | `DESIGN.md` | Full spec library: font list / palettes / Chinese typography / security iron laws (knowledge layer; agents may read on demand) |
| Regression tests | `tests/` | Ten suites (stable 47 + security 43 + trusted 21 + bundle + smoke + math + mermaid + boost-fontface, 200+ assertions): frame sequences / security filtering / bundle integrity (run after any engine change). Test dependencies are resolved by `tests/_deps.cjs` (jsdom / puppeteer are **optional dev-time deps**; the plugin itself has zero runtime dependencies) |
| Benchmark | `patch/vcp-fast-bench.cjs` | Compares old/new paths in a real DOM parsing environment (auto-downloads dependencies, zero install) |
| Subset tool | `tools/subset_fonts.py` | For maintainers: trims new fonts to common-character subsets + woff2 compression (needs Python + fonttools + brotli) |

## Install (any DSH environment · for humans & agents alike)

**Recommended: one-shot installer `patch/install-all.cjs`** — one command installs everything.
It **detects which dsh you are on** and takes the matching path:

- **Desktop (Electron)** → `patch-frontend-asar.cjs` (v10, generation-adaptive): replaces the frontend
  bundle in place inside `app.asar` and recomputes integrity. **All five capabilities (A/B/C/E/F) land in
  one step — no other sub-script needed.**
- **Web / standalone bundle** → `install-v6.cjs` (rendering) → `update-v6-inject.cjs` (module upgrade)
  → `trusted-patch.cjs` (Trusted Mode vc gating).

Idempotent, every step auto-backs-up + `node --check` health check, aborts safely without writing on
anchor mismatch.

```powershell
# 1. One-shot patch (HTML rendering / SVG cards / Mermaid charts / KaTeX math / Trusted Mode — all in place)
node "path\to\plugin\patch\install-all.cjs"
#    dry-run (probe only, writes nothing): add --dry-run

# 2. Install the plugin (uninstall: dsh plugin --profile web remove dsh-raw-html)
dsh plugin --profile web add "path\to\plugin"

# 3. Restart dsh (desktop MUST restart: the asar header is cached by the process), then hard-refresh (Ctrl+F5)
# 4. Toggle the 「</>」switch (render/aesthetic). Since v7.3 Trusted Mode is on by default and the badge is hidden
```

> **Agent install guide** (for users letting their own agent install this plugin — hand these 4 steps
> to the agent as-is): ① verify Node.js is available (`node -v`); ② run the one-shot installer
> `install-all.cjs` (auto-detects `app.asar` / the dist bundle; pass the target path as an argument if
> detection fails); ③ register the plugin into the profile; ④ tell the user to restart dsh and
> hard-refresh. All patches are idempotent — re-installing or re-running after a dsh upgrade has no
> side effects.

If auto-detection fails, specify the target path manually:

```powershell
node "...\patch\install-all.cjs" "D:\...\resources\app.asar"                          # desktop
node "...\patch\install-all.cjs" "C:\...\dsh-web-frontend\dist\assets\index-*.js"    # web
```

> They may also be run individually: `install-v6.cjs` (rendering) / `trusted-patch.cjs` (Trusted Mode vc gating);
> legacy scripts (v1/v2 era) `patch/install.cjs`, `patch/patch-frontend.cjs`, `patch/upgrade-patch.cjs`
> are kept in the source repo for reference; use `install-all.cjs` for daily installs.

## vcp-fast engine (v0.3.0)

The "cache + incremental" dual engine (`window.__vcpFast`) layered on the v1 render patch:

- **Exact cache**: when the HTML string is unchanged, returns the cached React element reference — React skips reconciliation for identical references. History scrolling / session switching / React re-renders → zero rebuild.
- **Incremental append**: content = old content + appended segment, and when the old content ends with a closed tag, stable parts keep their references and only the new segment is parsed.
- **Safety boundary**: only active in non-streaming mode with the toggle on; falls back to full re-render on unclosed old values or content rewrites; cache capped at 200 entries; onclick bridging and script/iframe filtering unchanged.
- **Verify**: `[vcp-fast] HIT/BUILD` logs in the DevTools console (throttled every 2s); benchmarks in `patch/vcp-fast-bench.cjs` (measured in a real DOM environment: ~1200~6800× cache-hit, ~12× incremental speedup).

## ⚠️ Common pitfall: no blank lines inside vcp-root (important!)

**A markdown HTML block ends at a blank line (`\n\n`)** — if `<div id="vcp-root">` contains two consecutive line breaks, the card is split into multiple nodes: the opening part is auto-completed by DOMParser into a small card with only a top background strip, and the rest overflows outside the background. Symptom: **the dark background only wraps the top strip, and content below has no background** (confirmed 2026-08-19).

**Rules**:
- All children inside vcp-root use **single line breaks** or stay on one line; never leave `\n\n` anywhere;
- Use `margin` for visual grouping, not blank lines;
- After writing, check: the card HTML string must contain zero occurrences of `\n\n`.

## ⚠️ Common pitfall: one message = one format (HTML or Markdown)

**If a single message contains both a raw HTML card and Markdown, the Markdown part is rendered as plain source text.**

Symptom (measured 2026-10-13): the card renders fine, but a Markdown table after it collapses into bare pipes and `**bold**` shows its asterisks — **the Markdown pipeline never ran, this is not a render failure**.

Two causes:
1. **Renderer**: `fixVcpBlank` uses `(<div id="vcp-root"[^>]*>)([\s\S]*)$` to collapse blank lines inside the card — that regex has **no right boundary** and consumes everything up to the end of the message, including the blank line separating the card from the following Markdown. Once that separator is gone, the trailing Markdown is absorbed into the HTML block.
2. **Host**: a Markdown HTML block never parses Markdown syntax inside itself.

> **Since patch v6.39 the renderer self-heals** (2026-10-13): `fixVcpBlank` now locates the root container's closing tag first and collapses blank lines only *inside* the container; when the closing tag is followed by a single newline plus content, it restores the blank line — so trailing Markdown lands in its own block and parses normally. Seven cases verified green. **The model-side rule still stands**: this is a safety net, not a licence — compliant output is cheaper and avoids one reflow on the streaming frame where the card closes.

**Rules**:
- One message is **either all HTML** (a `<div id="vcp-root">` card, with prose written inside using `<div>`/`<p>`/`<span>`);
- **or all Markdown** (plain prose, tables, lists);
- **never both**. When you need "card + explanation", put the explanation inside the card.

> Authoritative source: [DESIGN.md §4](./DESIGN.md) rule 12; this section is an operational quick reference only.

## Config

- **Built-in fonts** (recommended): 7 open-source fonts shipped with the plugin (all OFL-licensed), zero config.
- **External font library** (optional): defaults to `I:\字体`. Point `Settings → Plugins → raw-html → fontsRoot` to your own library (or edit the default in `lib/index.js`). Works fine without one: 7 built-in open-source fonts + system fonts as fallback.
- **Toggle state**: persisted at `~/.dsh/dsh-raw-html-state.json`, restored after service restart.

## Usage

- Click **「</> OFF」→「</> ON」** next to the composer send button to enable;
- Once on, HTML in **new messages** renders immediately; historical messages re-render on page refresh;
- The agent receives the injected VCP protocol → automatically outputs `#vcp-root` visual containers; when off, the protocol is withdrawn → the agent falls back to plain Markdown.
- VCP buttons `onclick="input('reply text')"` fill the input and send on click.

## Maintenance / Upgrading

- After each change: `node --check lib/client.js && node --check lib/index.js`; client changes take effect on refresh; host changes require a dsh service restart.
- A `dsh` upgrade overwrites the patched dist files → re-run `patch/install-all.cjs` (idempotent; aborts without writing on anchor mismatch; backups in `*.bak-installv6-<timestamp>`).
- **Dependency declaration rule** (lesson from the 2026-08-19 crash): every third-party package you `import` **must be declared** in package.json (dependencies or peerDependencies) — relying on whatever node_modules happens to exist is gambling your lifeline. Run `node tools/check-deps.cjs` after each change to verify.
- To improve the design spec → edit `DESIGN.md` (agents read it on demand) + sync the protocol text (`buildProtocolText` in `lib/index.js`).
- To add built-in fonts → edit the FONTS list in `tools/subset_fonts.py` and re-run (needs Python + fonttools + brotli); woff2 subsets are output to `assets/fonts/`.

## Restore (undo patch)

```powershell
# Rename the backup generated by the installer back (e.g. index-*.js.bak-xxx → index-*.js), then remove the plugin:
dsh plugin --profile web remove dsh-raw-html
```

## Security notes

Once enabled, HTML from model output is rendered as UI. The patch filters scripts/events/dangerous
protocols (React rendering naturally never executes script; events only allow the controlled
`onclick="input('...')"` channel; `script/iframe/object/embed` and `javascript:` protocols are
dropped), but styles and external images remain reachable — **enable only for trusted models**.
