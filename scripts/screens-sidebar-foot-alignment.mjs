// Sidebar foot alignment: Send feedback and Connectors should line up with Vault.
// Renders a full app shell at desktop width from the repo's styles.css in Chromium.
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const current = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
const before = execSync('git show HEAD~1:src/renderer/src/styles.css', {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024
})

const icon = (d, size = 15) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const ask = icon('<circle cx="12" cy="12" r="10"/><path d="M9.5 9a2.8 2.8 0 0 1 5 .8c0 1.9-2.5 2.3-2.5 3.9"/><circle cx="12" cy="16.8" r=".7" fill="currentColor" stroke="none"/>')
const plug = icon('<path d="M12 2v5M8 7V2M16 7V2M7 7h10v4a5 5 0 0 1-10 0zM12 16v6"/>')
const key = icon('<circle cx="8.5" cy="14.5" r="3.5"/><path d="M11.7 12.3 20 4v3h-3v3h-3"/>')
const gear = icon('<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-1.9-3.3-2.3 1a7 7 0 0 0-1.7-1l-.3-2.5h-3.8l-.3 2.5a7 7 0 0 0-1.7 1l-2.3-1L4.1 9.5 6.1 11a7 7 0 0 0 0 2l-2 1.5 1.9 3.3 2.3-1a7 7 0 0 0 1.7 1l.3 2.5h3.8l.3-2.5a7 7 0 0 0 1.7-1l2.3 1 1.9-3.3-2-1.5c.1-.3.1-.7.1-1z"/>', 16)
const hash = icon('<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>', 16)
const layers = icon('<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 12l10 5 10-5"/><path d="M2 17l10 5 10-5"/>', 16)
const spark = icon('<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z"/>', 16)

const nav = (svg, label, active = false) => `<button class="nav-item ${active ? 'is-active' : ''}" style="width:100%">${svg}<span class="nav-item__label">${label}</span></button>`

const MARKUP = `
<div class="app" style="height:100vh;">
  <aside class="sidebar" style="position:relative; height:100vh;">
    <div class="sidebar__drag"></div>
    <div class="workspace" style="padding:14px 12px 10px; display:flex; align-items:center; gap:10px;">
      <div style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#f0b429,#e07a2f);display:grid;place-items:center;color:white;font-weight:700;font-size:13px;">T</div>
      <div style="display:flex;flex-direction:column;line-height:1.2;"><strong style="font-size:14px;color:var(--text);">Tucano</strong><span style="font-size:12px;color:var(--text-3);">Workspace</span></div>
    </div>
    <nav class="sidebar__scroll" style="padding:4px 8px 12px; flex:1; overflow:auto;">
      ${nav(spark, 'Tuca')}
      <div style="height:8px"></div>
      <div class="section">
        <div class="section__head"><div style="padding:6px 8px; font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--text-3);">Channels</div></div>
        ${nav(hash, 'general', true)}
        ${nav(hash, 'design')}
      </div>
      <div style="height:8px"></div>
      <div class="section">
        <div class="section__head"><div style="padding:6px 8px; font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--text-3);">Agents</div></div>
        ${nav(layers, 'Routines')}
      </div>
    </nav>
    <div class="sidebar__foot">
      <div class="sidebar__foot-rows">
        <button class="sidebar__tool">${ask}<span class="grow">Send feedback</span></button>
        <button class="sidebar__tool sidebar__tool--connectors">${plug}<span class="grow">Connectors</span></button>
        <div class="sidebar__tools">
          <button class="sidebar__tool">${key}<span class="grow">Vault</span></button>
          <button class="icon-btn sidebar__gear">${gear}</button>
        </div>
      </div>
    </div>
  </aside>
  <main class="main" style="display:flex; align-items:center; justify-content:center; background:var(--bg);">
    <div style="text-align:center; color:var(--text-3);">
      <div style="font-size:28px; font-weight:600; color:var(--text-2); margin-bottom:8px;">#general</div>
      <div style="font-size:14px;">Pick a conversation or start a new one.</div>
    </div>
  </main>
</div>`

const out = new URL('../frames/sidebar-foot-alignment/', import.meta.url)
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ headless: true })
try {
  for (const [tag, css] of [['before', before], ['after', current]]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 })
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}
html,body{margin:0;height:100%;background:var(--bg,#fff);font-family:var(--font-sans,system-ui,sans-serif);}
</style></head><body>${MARKUP}</body></html>`)
    await page.waitForTimeout(250)
    const metrics = await page.evaluate(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) }
      }
      return {
        feedback: pick('.sidebar__foot-rows > .sidebar__tool:nth-child(1)'),
        connectors: pick('.sidebar__foot-rows > .sidebar__tool:nth-child(2)'),
        vault: pick('.sidebar__tools > .sidebar__tool'),
      }
    })
    console.log(tag, JSON.stringify(metrics))
    await page.screenshot({ path: new URL(`${tag}.png`, out).pathname.replace(/^\/([A-Z]:)/, '$1'), fullPage: false })
    await page.close()
  }
} finally {
  await browser.close()
}
