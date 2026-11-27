// Screenshots of an open document getting the room it needs: a PDF fit to its width with the details
// folded away, the details open, full screen, and a Markdown file that keeps its reading column. On a
// build without the change it takes the "before" picture only. The PDF is made up here, and its page is
// blurred in every picture anyway, so what is being compared is the size, not the words.
// Run after `npm run build`: node scripts/screens-doc-viewer.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens/doc-viewer'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: process.env.TUCANO_LOCALE ?? 'pt-BR' }
const launch = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 820 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}
// The first start makes the seed's team; the workspace takes the system user's name, so a made-up one goes in.
const first = await launch()
await first.app.close()
execFileSync('sqlite3', [join(data, 'tucano.db'), `INSERT OR REPLACE INTO settings (key, value) VALUES ('workspaceName', '"Ana"'); UPDATE people SET name = 'Ana' WHERE role = 'owner'`])
const { app, win } = await launch()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

// A one-page report, printed by Electron itself, so the script needs no file of anyone's.
const lines = Array.from({ length: 14 }, (_, i) => `<p>Seção ${i + 1}. As vendas do trimestre cresceram em todas as regiões, com destaque para o atendimento online e para os pedidos recorrentes, que já passam de um terço do total.</p>`).join('')
const pdf = await app.evaluate(async ({ BrowserWindow }, html) => {
  const w = new BrowserWindow({ show: false })
  await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  const buf = await w.webContents.printToPDF({ pageSize: 'A4' })
  w.destroy()
  return buf.toString('base64')
}, `<html><body style="font-family:system-ui;padding:40px;font-size:13px;line-height:1.5"><h1>Relatório do trimestre</h1>${lines}</body></html>`)

const blur = () => win.addStyleTag({ content: '.dc-viewer iframe, .dc-full iframe { filter: blur(6px); }' })
const shot = async (name, wait = 600) => {
  for (const close of await win.locator('.toast__close').all()) await close.click().catch(() => {})
  await win.waitForTimeout(wait)
  await win.screenshot({ path: `${out}/${name}.png` })
}
const open = async (name) => {
  await win.click('.nav-item:has-text("Conhecimento")')
  await win.click('.hub__tab:has-text("Documentos")')
  await win.waitForSelector('.dc-page__inner')
  await win.locator('.dc-page__inner button:has(strong:text-is("Empresa"))').first().click()
  await win.waitForSelector('.dc-fhead')
  await win.locator(`.dc-list :text("${name}")`).first().click()
  await win.waitForSelector('.dc-viewer')
}

await win.click('.nav-item:has-text("Conhecimento")')
await win.click('.hub__tab:has-text("Documentos")')
await win.waitForSelector('.dc-page__inner')
await win.locator('.dc-page__inner button:has(strong:text-is("Empresa"))').first().click()
await win.waitForSelector('.dc-fhead')
await win.locator('.hub__body input[type=file]').first().setInputFiles([
  { name: 'Relatório do trimestre.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf, 'base64') },
  { name: 'Guia de atendimento.md', mimeType: 'text/markdown', buffer: Buffer.from('# Guia de atendimento\n\nResponda em até duas horas no horário comercial. Comece pelo nome da pessoa e pelo que ela pediu, em uma frase.\n\n## Quando não souber\n\nDiga que vai descobrir e quando volta com a resposta. Volte antes desse horário, mesmo que seja para dizer que ainda falta.\n\n## Reembolsos\n\nAté 7 dias depois da compra, sem perguntas. Depois disso, passe para a equipe financeira com o número do pedido.\n', 'utf8') }
])
await win.waitForSelector('.dc-list :text("Guia de atendimento")', { timeout: 20_000 })
await win.waitForTimeout(800)

await open('Relatório do trimestre')
await blur()
const details = win.locator('.dc-doc__bar button:has-text("Detalhes")')
if (!(await details.count())) {
  await shot('00-before', 2500)
} else {
  await shot('01-pdf', 2500)
  await details.click()
  await shot('02-pdf-details', 2500)
  await details.click()
  await win.click('.dc-doc__bar button:has-text("Tela cheia")')
  await shot('03-pdf-full', 2500)
  await win.keyboard.press('Escape')
  await open('Guia de atendimento')
  await shot('04-markdown')
  await win.emulateMedia({ colorScheme: 'dark' })
  await open('Relatório do trimestre')
  await blur()
  await shot('05-pdf-dark', 2500)
}

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no console errors')
await app.close()
