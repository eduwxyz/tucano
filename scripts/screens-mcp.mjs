// Screenshots of Settings › Harnesses (the MCP address, a key made and what to paste in each harness)
// and of the inbox after a harness set something up over MCP. Fresh data, fake engines.
// Run after `npm run build`: node scripts/screens-mcp.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens/mcp'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: process.env.TUCANO_LOCALE ?? 'pt-BR' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await win.setViewportSize({ width: 1280, height: 860 })
await win.waitForSelector('.sidebar')
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })

await win.click('.sidebar__gear')
await win.click('.tabs button:has-text("Harnesses")')
await win.waitForSelector('text=Endereço do MCP')
await win.waitForTimeout(300)
await shot('1-harnesses')

await win.fill('input[placeholder="Claude Code no notebook"]', 'Claude Code no notebook')
await win.click('button:has-text("Gerar chave")')
await win.waitForSelector('.harness-snippet')
await win.waitForTimeout(300)
await shot('2-chave')
const key = await win.locator('input.mono').nth(1).inputValue()
const url = await win.locator('input.mono').nth(0).inputValue()

// A harness on this computer sets something up.
const mcp = async (method, params) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  return r.json()
}
await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'screens', version: '1' } })
const made = await mcp('tools/call', { name: 'create_agent', arguments: { name: 'Bia', role: 'Revisa contratos', instructions: 'Você revisa contratos com cuidado.' } })
await mcp('tools/call', { name: 'create_routine', arguments: { agent: 'Bia', name: 'Contratos da semana', prompt: 'Liste os contratos novos.', schedule: { days: [1], time: '09:00' } } })
console.log('create_agent:', made.result?.content?.[0]?.text?.slice(0, 120))

await win.click('button:has-text("Pronto")')
await win.waitForTimeout(400)
await shot('3-chaves')
await win.locator('.nav-item', { hasText: /Aprovações|Approvals/ }).first().click()
await win.waitForSelector('text=Feito pelos seus harnesses')
await win.waitForTimeout(300)
await shot('4-caixa-de-entrada')
console.log('erros:', errors)
await app.close()
