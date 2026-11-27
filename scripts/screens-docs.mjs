// Screenshots of Documents (Conhecimento › Documentos): folders with a rule and who sees them, a file an
// agent saved waiting for a person's yes, the inbox that files what is dropped in it, a deadline found in
// a contract, and a question answered from the files. Fresh data, fake engines.
// Run after `npm run build`: node scripts/screens-docs.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens/docs'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: process.env.TUCANO_LOCALE ?? 'pt-BR' }
const launch = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 860 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}

// The first start makes the seed's team. Then two sectors, the way the organogram would: Theo answers
// to Lia (Engenharia), and a new agent, Caio, answers to Nina (Conteúdo).
const first = await launch()
await first.app.close()
execFileSync('sqlite3', [
  join(data, 'tucano.db'),
  [
    // The workspace takes the system user's name: a made-up one for the pictures.
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('workspaceName', '"Ana"')`,
    "UPDATE people SET name = 'Ana' WHERE role = 'owner'",
    "UPDATE agents SET reports_to = (SELECT id FROM agents WHERE handle = 'lia') WHERE handle = 'theo'",
    "UPDATE agents SET sector_name = 'Engenharia' WHERE handle = 'lia'",
    "UPDATE agents SET sector_name = 'Conteúdo' WHERE handle = 'nina'",
    "CREATE TEMP TABLE one AS SELECT * FROM agents WHERE handle = 'nina'",
    "UPDATE one SET id = 'x-caio', handle = 'caio', name = 'Caio', role = 'Posts', sector_name = NULL, reports_to = (SELECT id FROM agents WHERE handle = 'nina'), created_at = created_at + 1",
    'INSERT INTO agents SELECT * FROM one'
  ].join('; ')
])

const { app, win } = await launch()
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = async (name) => {
  // A toast from the step before would sit on top of the picture.
  for (const close of await win.locator('.toast__close').all()) await close.click().catch(() => {})
  await win.waitForTimeout(600)
  await win.screenshot({ path: `${out}/${name}.png` })
}
const busy = '.msg .shimmer, .msg .typing, .system-line.is-pending'
async function settle() {
  const deadline = Date.now() + 40_000
  let quiet = 0
  while (Date.now() < deadline && quiet < 4) {
    await win.waitForTimeout(500)
    quiet = (await win.locator(busy).count()) === 0 ? quiet + 1 : 0
  }
}
const file = (name, text, mimeType = 'text/markdown') => ({ name, mimeType, buffer: Buffer.from(text, 'utf8') })
const home = async () => {
  await win.click('.nav-item:has-text("Conhecimento")')
  await win.click('.hub__tab:has-text("Documentos")')
  await win.waitForSelector('.dc-page__inner')
  await win.waitForTimeout(500)
}
const folder = async (name) => {
  await home()
  await win.locator(`.dc-page__inner button:has(strong:text-is("${name}"))`).first().click()
  await win.waitForSelector('.dc-fhead')
  await win.waitForTimeout(400)
}
const day = (ahead) => {
  const d = new Date(Date.now() + ahead * 86_400_000)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

// Engenharia: what the sector keeps, with its rule, and every agent's save waiting for a person.
await folder('Engenharia')
await win.locator('.hub__body input[type=file]').first().setInputFiles([
  file('Runbook de deploy.md', '# Runbook de deploy\n\n1. Rodar os testes.\n2. Publicar em homologação e conferir o painel.\n3. Publicar em produção fora do horário de pico.\n4. Acompanhar a fila de pagamentos por 15 minutos.\n'),
  file('Latência por serviço.csv', 'serviço,p50 (ms),p95 (ms)\nAPI,42,180\nPagamentos,95,410\nBusca,31,120\nNotificações,58,260\n', 'text/csv'),
  file('Painel de incidentes.html', '<html><body style="font-family:system-ui;padding:32px"><h1>Incidentes de novembro</h1><p>2 incidentes, 14 minutos fora do ar no total.</p><ul><li>12/11 · fila de pagamentos parada · 14 min</li><li>03/11 · busca lenta · sem queda</li></ul></body></html>', 'text/html')
])
await win.waitForSelector('.dc-list :text("Runbook de deploy")', { timeout: 20_000 })
await win.waitForTimeout(800)
if (await win.locator('.dc-rule summary').count()) await win.locator('.dc-rule summary').first().click()
await win.locator('button:has-text("Mudar a regra"), button:has-text("Escrever a regra")').first().click()
await win.locator('.dc-rule textarea').fill('Um relatório por incidente, com o nome "Relatório de incidente DD-MM". A Lia escreve e uma pessoa aprova antes de valer.')
await win.keyboard.press('Meta+Enter')
await win.waitForTimeout(500)
await win.click('button[aria-label="Mais opções da pasta"]')
await win.click('button:has-text("Pedir aprovação nesta pasta")')
await win.waitForTimeout(700)

// Lia, who heads the sector, is asked for a report: she saves it in the sector's folder, and it waits for me.
await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
if (await win.locator('button:has-text("Abrir DM")').count()) await win.click('button:has-text("Abrir DM")')
await win.waitForSelector('.composer textarea')
await win.fill('.composer textarea', 'guarde em Engenharia: Relatório de incidente 12-11.md = Relatório do incidente de 12/11. A fila de pagamentos parou por 14 minutos. Causa: o banco chegou ao limite de conexões. Ação: aumentar o pool e criar um alerta de fila parada.')
await win.keyboard.press('Enter')
await settle()
await win.locator('.artifact-card').last().click()
await win.waitForSelector('.side-panel')
await shot('05-chat-saved')

// The inbox: a contract dropped on the home is read, filed where its folder's rule says, and its date kept.
await home()
await win.locator('.hub__body input[type=file]').first().setInputFiles([
  file('Contrato de hospedagem.md', `Contrato de hospedagem da Empresa com o fornecedor de nuvem.\nValor mensal fixo, com reajuste anual.\nVencimento: ${day(40)}. Renova por mais um ano se ninguém avisar com 30 dias de antecedência.\n`)
])
await win.waitForSelector('.dc-arr :text("Contrato de hospedagem")', { timeout: 30_000 })
await win.waitForTimeout(1200)
await shot('01-home')

await folder('Engenharia')
await shot('02-folder')

// The report, with the one decision it asks for, and where it came from.
await win.locator('.dc-list :text("Relatório de incidente")').first().click()
await win.waitForSelector('.dc-decide')
await win.locator('.dc-side summary').first().click()
await shot('03-document-waiting')

// Who gets in: people and agents, by sector, in plain words.
await win.click('.dc-back')
await win.waitForSelector('.dc-fhead')
await win.locator('.dc-fhead button:not([aria-label]):not(:has-text("Novo"))').first().click()
await win.waitForSelector('.modal')
await shot('04-access')
await win.keyboard.press('Escape')

// What waits on me: the report to approve and the contract's date.
await win.locator('.nav-item:has-text("Pra você"), .nav-item:has-text("Aprovações")').first().click()
await win.waitForSelector('.dc-ib__file')
await shot('06-inbox')

// A question, answered from the files I may see, each claim with the file it came from.
await home()
await win.locator('.dc-search input').first().fill('quando vence o contrato de hospedagem?')
await win.keyboard.press('Enter')
await win.waitForSelector('.dc-answer', { timeout: 30_000 })
await shot('07-ask')
await win.emulateMedia({ colorScheme: 'dark' })
await shot('08-ask-dark')
await win.emulateMedia({ colorScheme: 'light' })

console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no console errors')
await app.close()
