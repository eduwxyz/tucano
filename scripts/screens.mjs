// Opens the built app with Playwright and saves screenshots of the main flows.
// Uses a fresh data directory and the fake engines, so nothing touches your
// real database or spends your subscription. Pass --real to use the real CLIs.
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'screens'
const real = process.argv.includes('--real')
mkdirSync(out, { recursive: true })

const data = mkdtempSync(join(tmpdir(), 'tucano-'))
for (const dir of [tmpdir(), '/tmp']) rmSync(join(dir, 'tucano-demo-tasks.json'), { force: true }) // the demo connector starts from its sample list
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', ...(real ? {} : { TUCANO_FAKE_ENGINES: '1' }) }
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 820 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const shot = async (name) => win.screenshot({ path: `${out}/${name}.png` })
const busy = '.msg .shimmer, .msg .typing, .system-line.is-pending'
// Waits until nothing is routing or answering, including replies that start later (handoffs).
async function settle() {
  const deadline = Date.now() + (real ? 180_000 : 15_000)
  let quiet = 0
  while (Date.now() < deadline && quiet < (real ? 6 : 3)) {
    await win.waitForTimeout(500)
    quiet = (await win.locator(busy).count()) === 0 ? quiet + 1 : 0
  }
}
async function send(text) {
  await win.fill('.composer textarea', text)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(400)
}

await shot('01-inicio')

// No mention, two agents: the router picks.
await send('O build do checkout quebrou depois do último merge. Alguém consegue olhar o que pode ser?')
await win.waitForSelector('.system-line')
await shot('02-router-escolhendo')
await settle()
await shot('03-router-escolheu')

// The agent asks a question with ask_user; the next message answers it.
await send('@lia antes de sugerir qualquer coisa, use a ferramenta de pergunta pra me perguntar qual é o meu prazo.')
await settle()
await shot('04-pergunta')
await win.fill('.decisions__text', 'Até sexta.')
await win.keyboard.press('Enter')
await settle()
await shot('05-respondeu-pergunta')

// Several decisions: one at a time in place of the message box, then a review before sending.
await send('@lia me ajuda a decidir')
await settle()
await win.waitForSelector('.decisions')
await shot('05a-decisoes')
await win.keyboard.press('1')
await win.fill('.decisions__text', 'Até sexta.')
await win.keyboard.press('Enter')
await shot('05b-decisoes-revisao')
await win.locator('.decisions .btn--primary').click()
await settle()

// Handoff: Lia mentions Theo, who answers next.
await send('@lia peça pro Theo calcular a mediana de 3, 9 e 4, mencionando ele com arroba. Você não calcula.')
await settle()
await shot('06-handoff')

await win.click('text=Uso e limites')
await shot('07-uso')

// ---------- M3: connector, grant, tools, approval ----------

await win.click('.nav-item:has-text("Conectores")')
await win.click('text=Adicionar conector')
await win.click('button[role=radio]:has-text("Local")')
await win.click('text=Preencher com o servidor de demonstração')
await shot('08-novo-conector')
await win.click('button:has-text("Conectar")')
await win.waitForSelector('.connector .tag:has-text("conectado")', { timeout: 20_000 })
await win.click('.connector__head')
await shot('09-conector-ferramentas')

// Give Lia read and write on it.
await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
await win.click('.tabs [role=tab]:has-text("Ferramentas")')
await win.click('.grant:has-text("Tarefas") button:has-text("Ler e escrever")')
await win.click('button:has-text("Salvar")')
await win.waitForSelector('.saved')
await shot('10-grant')

await win.click('text=Abrir DM')
await send('Liste as minhas tarefas.')
await settle()
await shot('11-consultou')

await send('Apague a tarefa 2, por favor.')
await settle()
await win.waitForSelector('.approval', { timeout: real ? 60_000 : 5000 })
await shot('12-pedido-de-aprovacao')

await win.click('.approval button:has-text("Aprovar")')
await settle()
await shot('13-aprovado')

await win.click('.nav-item:has-text("Aprovações")')
await shot('14-aprovacoes')

await win.click('.nav-item:has-text("Conectores")')
await win.click('.connector__head')
await shot('15-ferramenta-nova')

// Theo (Codex) reads the same connector.
await win.click('.section:has-text("Agentes") .nav-item:has-text("Theo")')
await win.click('.tabs [role=tab]:has-text("Ferramentas")')
await win.click('.grant:has-text("Tarefas") button:has-text("Ler"):not(:has-text("escrever"))')
await win.click('button:has-text("Salvar")')
await win.waitForSelector('.saved')
await win.click('text=Abrir DM')
await send('Quais tarefas ainda estão abertas?')
await settle()
await shot('16-codex-consultou')

// ---------- M4: memory ----------

await win.click('.section:has-text("Mensagens diretas") .nav-item:has-text("Lia")')
await send('lembra que eu prefiro PR pequeno, com descrição em bullets')
await settle()
await win.waitForSelector('.memory-chip', { timeout: real ? 60_000 : 5000 })
await shot('17-guardou-memoria')

// Fill the DM past the window, with a preference only I state, then summarize.
if (!real) {
  await send('eu prefiro café sem açúcar nas reuniões')
  await settle()
  for (let i = 1; i <= 14; i++) {
    await send(`mensagem de enchimento ${i}`)
    await settle()
  }
  await win.click('.topbar button:has-text("Resumo")')
  await win.click('.summary button:has-text("Resumir agora")')
  await win.waitForSelector('.summary textarea', { timeout: 10_000 })
  await shot('18-resumo')
}

await win.click('.nav-item:has-text("Memória")')
await shot('19-memoria')

// ---------- M5: the agent's computer ----------

await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
await win.click('.tabs [role=tab]:has-text("Ferramentas")')
await win.click('[aria-label="Computador"] button:text-is("Linux isolado")')
await win.waitForSelector('.computer .tag:text-is("ligado")', { timeout: 300_000 })
await shot('20-computador')
await win.click('text=Abrir DM')
if (real) {
  await send('Cria um dashboard simples de vendas por mês (dados inventados, 6 meses) numa página HTML com gráfico, sobe ele num serviço e me mostra um print.')
  await settle()
} else {
  await send("rode `mkdir -p site && printf '<meta charset=utf-8><h1 style=\"font:48px sans-serif;color:#2f6bf2\">Vendas por mês</h1><p>Jan 10 · Fev 14 · Mar 9</p>' > site/index.html && ls site`")
  await settle()
  await send('suba `cd site && python3 -m http.server 8000 --bind 0.0.0.0` na porta 8000')
  await settle()
  await send('print de http://localhost:8000')
  await settle()
  await send('mostre `site/index.html`')
  await settle()
}
await shot('21-computador-chat')
await win.click('.artifact-image')
await win.waitForTimeout(500)
await shot('22-painel-print')
const open = win.locator('.artifact-card--service button:has-text("Abrir")')
if (await open.count()) {
  await open.first().click()
  await win.waitForTimeout(1500)
  await shot('23-painel-servico')
}

// ---------- M6: routines ----------

await win.click('.nav-item:has-text("Rotinas")')
await shot('24-rotinas-vazio')
await win.click('.routine-example:has-text("Fechamento da semana")')
await win.locator('.routine-form select').nth(1).selectOption({ label: '#engenharia' })
await shot('25-rotina-nova')
await win.click('button:has-text("Criar rotina")')
await win.click('.routine button:has-text("Rodar agora")')
await win.waitForSelector('.routine .tag:text-is("respondeu")', { timeout: 120_000 })
await shot('26-rotinas')
await win.click('.routine button.link:text-is("ver")')
await settle()
await shot('27-rotina-na-conversa')

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors')
console.log(`data: ${data}`)
await app.close()
// Computers made by this run go with it.
const prefix = `tucano-${createHash('sha1').update(data).digest('hex').slice(0, 6)}-`
const ids = execFileSync('docker', ['ps', '-aq', '--filter', `name=${prefix}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
if (ids.length) execFileSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore' })
