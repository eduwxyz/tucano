// Screenshots of the screens added in M9–M11 (web, Jev, phone, limits, skills,
// triggers, budget pause), with the fake engines and a fresh data directory.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'screens-new'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
for (const dir of [tmpdir(), '/tmp']) rmSync(join(dir, 'tucano-demo-tasks.json'), { force: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1' } })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 860 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

const shot = (name) => win.screenshot({ path: `${out}/${name}.png` })
const card = (title, name) => win.locator(`.card:has(.card__head :text-is("${title}"))`).first().screenshot({ path: `${out}/${name}.png` })
const busy = '.msg .shimmer, .msg .typing, .system-line.is-pending'
async function settle() {
  let quiet = 0
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && quiet < 3) {
    await win.waitForTimeout(400)
    quiet = (await win.locator(busy).count()) === 0 ? quiet + 1 : 0
  }
}
async function send(text) {
  await win.fill('.composer textarea', text)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(400)
  await settle()
}
const step = async (name, fn) => {
  try {
    await fn()
  } catch (e) {
    errors.push(`${name}: ${String(e).split('\n')[0]}`)
    await shot(`erro-${name}`)
  }
}

// ---------- settings: router (Jev), phone, limits ----------
await step('configuracoes', async () => {
  await win.click('.nav-item:has-text("Configurações")')
  await win.click('.tabs [role=tab]:has-text("Modelos")')
  await win.locator('.card:has(.card__head:has-text("Router")) select').selectOption('jev')
  await win.waitForTimeout(300)
  await card('Router', '01-router-jev')
  await win.click('.tabs [role=tab]:has-text("Celular")')
  await card('Celular (Telegram)', '02-celular-telegram')
  await win.click('.tabs [role=tab]:has-text("Agentes")')
  await card('Limites', '03-limites')
  await win.click('.tabs [role=tab]:has-text("Modelos")')
  await win.locator('.card:has(.card__head:has-text("Router")) select').selectOption('haiku')
})

// ---------- the agent page: web ----------
await step('agente-web', async () => {
  await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
  await win.click('.tabs [role=tab]:has-text("Ferramentas")')
  await card('Web', '04-agente-web')
})

// ---------- skills ----------
await step('skills', async () => {
  await win.click('.nav-item:has-text("Skills")')
  await shot('05-skills-vazio')
  await win.click('button:has-text("Nova skill")')
  await win.fill('input[placeholder="testes do core"]', 'testes do core')
  await win.fill('input[placeholder^="Ao rodar"]', 'Ao rodar ou consertar os testes do pacote Core')
  await win.fill('.agent-form textarea', '1. `cd /projetos/simula-oab`\n2. `swift test --package-path Core --scratch-path /work/build-core`\n3. Conte quantos passaram e falharam.')
  await shot('06-skill-nova')
  await win.click('button:has-text("Criar skill")')
  await win.waitForSelector('.skill')
  await win.click('.skill button:has-text("Ver receita")')
  await shot('07-skills-em-uso')
})

await step('skill-proposta', async () => {
  await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
  await win.click('text=Abrir DM')
  await send('proponha a skill `testes-do-core` (quando: Ao rodar ou consertar os testes do pacote Core): 1. `cd /projetos/simula-oab`\n2. `swift package resolve --package-path Core` (senão trava baixando dependências)\n3. `swift test --package-path Core --scratch-path /work/build-core`\n4. Conte quantos passaram e falharam.')
  await shot('08-agente-propos-skill')
  await win.click('.nav-item:has-text("Skills")')
  await win.waitForSelector('.diff')
  await shot('09-skill-proposta-diff')
  await win.click('button:has-text("Aprovar")')
  await win.waitForTimeout(400)
  await win.click('.skill button:has-text("Histórico")')
  await win.waitForTimeout(500)
  await win.click('.skill__history .link:has-text("o que mudou")')
  await shot('10-skill-historico')
})

// ---------- budget pause and Continuar ----------
await step('teto', async () => {
  await win.click('.section:has-text("Mensagens diretas") .nav-item:has-text("Lia")')
  await send('gaste 300000 tokens investigando o bug do sorteio')
  await win.waitForSelector('button:has-text("Continuar")', { timeout: 5000 })
  await shot('11-pausou-no-teto')
  await win.click('button:has-text("Continuar")')
  await settle()
  await shot('12-continuou')
})

// ---------- triggers ----------
await step('conector-demo', async () => {
  await win.click('.nav-item:has-text("Conectores")')
  await win.click('text=Adicionar conector')
  await win.click('button[role=radio]:has-text("Local")')
  await win.click('text=Preencher com o servidor de demonstração')
  await win.click('button:has-text("Conectar")')
  await win.waitForSelector('.connector .tag:has-text("conectado")', { timeout: 20_000 })
})

await step('gatilho-conector', async () => {
  await win.click('.nav-item:has-text("Rotinas")')
  await win.click('button:has-text("Nova rotina")')
  await win.fill('.routine-form input[placeholder="Bom dia"]', 'Tarefa nova')
  await win.fill('.routine-form textarea', 'Leia a tarefa nova e me diga em uma linha o que fazer com ela.')
  await win.click('button[role=radio]:has-text("Quando aparece algo novo")')
  await win.click('button:has-text("Testar agora")')
  await win.waitForTimeout(1500)
  await shot('13-rotina-gatilho-conector')
  await win.click('button:has-text("Criar rotina")')
  await win.waitForTimeout(800)
})

await step('gatilho-local', async () => {
  await win.click('button:has-text("Nova rotina")')
  await win.fill('.routine-form input[placeholder="Bom dia"]', 'Build do Xcode falhou')
  await win.fill('.routine-form textarea', 'O build falhou: leia o erro abaixo e diga o provável motivo.')
  await win.click('button[role=radio]:has-text("Quando chamada no Mac")')
  await shot('14-rotina-gatilho-local')
  await win.click('button:has-text("Criar rotina")')
  await win.waitForTimeout(800)
  await shot('15-rotinas-com-gatilhos')
})

// ---------- M12: pause, approvals, settings, report ----------
await step('pausar', async () => {
  await win.click('.workspace .icon-btn[title^="Pausar tudo"]')
  await win.waitForSelector('.paused-banner')
  await win.click('.section:has-text("Mensagens diretas") .nav-item:has-text("Lia")')
  await send('oi, tá aí?')
  await shot('16-pausado')
  await win.click('.paused-banner')
})

await step('sempre-permitir', async () => {
  await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
  await win.click('.tabs [role=tab]:has-text("Ferramentas")')
  await win.click('.grant:has-text("Tarefas") button:has-text("Ler e escrever")')
  await win.waitForTimeout(300)
  await win.click('text=Abrir DM')
  await send('Apague a tarefa 2, por favor.')
  await win.waitForSelector('.approval button:has-text("sempre permitir")', { timeout: 5000 })
  await win.locator('.approval').last().screenshot({ path: `${out}/17-aprovacao-sempre.png` })
  await win.click('.approval button:has-text("sempre permitir")')
  await settle()
  await send('Apague a tarefa 3, por favor.')
  await shot('18-executou-sem-pedir')
  await win.click('.section:has-text("Agentes") .nav-item:has-text("Lia")')
  await win.locator('.card:has(.card__head:has-text("Ferramentas"))').first().screenshot({ path: `${out}/19-regra-na-pagina` + '.png' }).catch(async () => shot('19-regra-na-pagina'))
})

await step('configuracoes-2', async () => {
  await win.click('.nav-item:has-text("Configurações")')
  await win.click('.tabs [role=tab]:has-text("Agentes")')
  await win.locator('.key-row:has-text("Horário de silêncio") .toggle').click()
  await win.waitForTimeout(300)
  await card('Rotinas', '20-silencio')
  await win.click('.tabs [role=tab]:has-text("Geral")')
  await card('Time e backup', '22-time-backup')
})

await step('uso-boletim', async () => {
  await win.click('text=Uso e limites')
  await shot('23-uso-cota')
  await win.click('.nav-item:has-text("Boletim")')
  await win.waitForSelector('.report-agent')
  await shot('24-boletim')
})

console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors')
await app.close()
