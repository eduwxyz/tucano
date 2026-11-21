// Screenshots of the Cofre: its Logins tab, a login saved for an agent, and the card pedir_chave leaves
// (on Approvals). Fresh data, fake engines; the card's request is put straight into the database.
// Run after `npm run build`: node scripts/screens-cofre.mjs [out-dir]
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] ?? 'screens/cofre'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: process.env.TUCANO_LOCALE ?? 'pt-BR' }
const errors = []
const open = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await win.setViewportSize({ width: 1280, height: 860 })
  await win.waitForSelector('.sidebar')
  return { app, win }
}

let { app, win } = await open()
await app.close()
const db = new DatabaseSync(join(data, 'tucano.db'))
const agent = db.prepare("SELECT id, name FROM agents WHERE archived = 0 AND kind IS NOT 'tuca' LIMIT 1").get()
db.prepare('UPDATE agents SET computer = 1, browser = 1 WHERE id = ?').run(agent.id)
const conv = db.prepare("SELECT id FROM conversations WHERE kind = 'channel' LIMIT 1").get()
const owner = db.prepare('SELECT id FROM people LIMIT 1').get()
const ap = (id, args, why) =>
  db
    .prepare(`INSERT INTO approvals (id, hash, agent_id, conversation_id, message_id, connector_id, connector_name, tool, args, why, high_risk, state, created_at, expires_at, requested_by) VALUES (?, ?, ?, ?, ?, 'cofre', 'Cofre', 'pedir_chave', ?, ?, 0, 'pending', ?, ?, ?)`)
    .run(id, id, agent.id, conv.id, `m-${id}`, JSON.stringify(args), why, Date.now(), Date.now() + 86_400_000, owner?.id ?? null)
ap('ap-key', { nome: 'STRIPE_KEY' }, 'Pra puxar as cobranças do mês na API do Stripe.')
ap('ap-login', { site: 'https://conta.luz.com.br' }, 'Pra baixar a conta de luz de novembro.')
db.close()
;({ app, win } = await open())
const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })

await win.locator('.nav-item', { hasText: /Aprovações|Approvals/ }).first().click()
await win.waitForSelector('.key-request')
await win.waitForTimeout(300)
await shot('1-pedidos')

await win.click('.sidebar__tool:has-text("Cofre")')
await win.click('.tabs button:has-text("Logins")')
await win.waitForTimeout(300)
await shot('2-logins-vazio')
await win.click('button:has-text("Novo login")')
await win.fill('input[placeholder="conta.exemplo.com.br"]', 'conta.luz.com.br')
await win.locator('.vault-editor input').nth(1).fill('edu@exemplo.com')
await win.locator('.vault-editor input[type="password"]').fill('senha-de-teste')
await win.locator('.vault-editor .chip').first().click()
await shot('3-novo-login')
await win.click('button:has-text("Guardar no Cofre")')
await win.waitForTimeout(400)
await shot('4-logins')

// The browser's export, read through the system's file dialog: the main process answers with a
// fixture, so the modal is drawn as someone sees it after choosing a Chrome export.
const csv = join(mkdtempSync(join(tmpdir(), 'tucano-csv-')), 'Chrome Passwords.csv')
writeFileSync(
  csv,
  [
    'name,url,username,password,note',
    'Luz,https://conta.luz.com.br/entrar,edu@exemplo.com,senha-trocada,',
    'Banco,"https://app.banco.com/login","ana@exemplo.com","sen,ha nova",',
    'App,android://abcd@app.exemplo/,app@exemplo.com,senha-do-app,',
    'Portal,http://portal.exemplo,edu@exemplo.com,senha-http,'
  ].join('\n')
)
await app.evaluate(async ({ dialog }, file) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
}, csv)
await win.click('.sidebar__tool:has-text("Cofre")')
await win.click('.tabs button:has-text("Logins")')
await win.click('button:has-text("Importar CSV")')
await win.waitForSelector('.vault-import__lines')
await win.waitForTimeout(300)
await shot('5-import-csv')
const rows = await win.locator('.vault-import__lines .table__row').count()
const skipped = await win.locator('.vault-import__lines .tag--danger').count()
const already = await win.locator('.vault-import__lines label').count()
console.log('csv import, rows:', rows, 'already saved:', already, 'skipped:', skipped)

await win.locator('.nav-item', { hasText: /Aprovações|Approvals/ }).first().click()
await win.waitForSelector('.key-request')
await win.locator('.key-request input[type="password"]').first().fill('sk_test_123456789')
await win.click('.key-request button:has-text("Guardar no Cofre e liberar")')
await win.waitForTimeout(800)
await shot('6-depois-de-colar')

await win.click('.sidebar__tool:has-text("Cofre")')
await win.click('.tabs button:has-text("Chaves")')
await win.waitForTimeout(300)
await shot('7-chaves')
console.log('agente:', agent.name, 'erros:', errors)
await app.close()
