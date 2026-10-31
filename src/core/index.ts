// The core runs in an Electron utility process: database, engines and runs
// live here so the window never waits on agent work. The renderer talks to it
// over a MessagePort handed out by the main process.
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MessagePortMain } from 'electron'
import { L, langOf, locale, setLang, type Lang } from '../shared/lang'
import type { Api, CoreEvent, Method, Request, Wire } from '../shared/rpc'
import { channelName, ENGINES, inQuietHours, modelInfo, WEBHOOK_PORT, type Agent, type BrowserReply, type Message, type EngineId, type EngineStatus, type Settings } from '../shared/types'
import { listModels, quietClaude, quietCodex, withChoice } from './harness'
import { Db } from './db'
import { claudeEngine, userProvider } from './engines/claude'
import { codexEngine, userCodexProvider } from './engines/codex'
import { opencodeEngine, userOpencodeProviders } from './engines/opencode'
import { piEngine } from './engines/pi'
import { geminiAppDir, geminiEngine } from './engines/gemini'
import { adoptLoginShellPath, detectEngines } from './engines/detect'
import { fakeEngine } from './engines/fake'
import type { Engine } from './engines/types'
import { ConnectorManager } from './connectors'
import { harnessMcps, publicMcp, type FoundMcp } from './harness-mcp'
import { Gateway } from './gateway'
import { createServer } from 'node:http'
import { checkJevKey, JEV_MODEL, JEV_SECRET } from './jev'
import { GitHub } from './github'
import { report } from './report'
import { usage } from './usage'
import { Skills } from './skills'
import { backup, backupIfDue, exportTeam, importTeam } from './team'
import { Telegram } from './telegram'
import { mainCipher, plainCipher, Secrets } from './secrets'
import { Browser, type BrowserHost } from './browser'
import { findOnPath, isWin, loginShell, onPath, osOf, shellCommand, terminalCommand } from './platform'
import { activeWslDistro, listWslDistributions, setExecutionProblem, setExecutionTarget, windowsPathToWsl, wslCanConnect, wslExecutable, wslHasCommand, wslHome, wslHostAddress, wslLoginEnv, wslPathToWindows } from './wsl'
import { ChromeBrowsers, hasChrome } from './chrome'
import { checkFolder, Computers, folderName, type Shooter } from './computer'
import { Memories } from './memory'
import { loginEnv } from './mac'
import { findLocalSkills } from './local-skills'
import { Routines } from './routines'
import { Runner } from './runs'
import { agentFromDraft, availableModels, tucaAgent, tucaHello } from './tuca'
import { seed } from './seed'

const dataDir = process.env['TUCANO_DATA'] ?? join(process.cwd(), '.tucano')
const fake = process.env['TUCANO_FAKE_ENGINES'] === '1'
// Run by the server (src/server): no window, and the screens are in a browser elsewhere.
const serverMode = process.env['TUCANO_SERVER'] === '1'
mkdirSync(dataDir, { recursive: true })

const db = new Db(join(dataDir, 'tucano.db'))
const codexHome = join(dataDir, 'codex-home')
mkdirSync(join(codexHome, '.codex'), { recursive: true })
// Until the settings are read, the language of a new install: the Mac's.
setLang(langOf(process.env['TUCANO_LOCALE']))
// A new install starts empty and the introduction creates the first agent; the
// fake engines (tests, screenshots) and TUCANO_SEED=1 get the sample team.
if (db.created) {
  if (process.env['TUCANO_SEED'] === '1' || (fake && process.env['TUCANO_SEED'] !== '0')) seed(db)
  else db.setSettings({ onboarding: { done: false } })
}
const interrupted = db.interruptStaleRuns()
if (interrupted) console.log(`[core] ${interrupted} run(s) marked as interrupted`)

const user = userInfo().username
const DEFAULTS: Omit<Settings, 'engines'> = {
  workspaceName: user ? user[0]!.toUpperCase() + user.slice(1) : 'Eu',
  context: '',
  routerModel: 'haiku',
  memoryModel: 'haiku',
  memoryLearning: 'approve',
  defaultLimit: 2_000_000,
  approvalTtlHours: 24,
  theme: 'system',
  language: langOf(process.env['TUCANO_LOCALE']),
  executionTarget: { kind: 'windows' }
}

const savedTarget = db.getSettings(DEFAULTS).executionTarget
setExecutionTarget(isWin && savedTarget?.kind === 'wsl' ? savedTarget : { kind: 'windows' })

const wslHomePath = (): string | undefined => {
  const distro = activeWslDistro()
  return distro ? wslPathToWindows(wslHome(distro), distro) : undefined
}
const wslUserPath = (value: string | undefined, fallback: string, distro: string, home: string): string => {
  if (!value) return fallback
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  if (value.startsWith('/')) return wslPathToWindows(value, distro)
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return value
  return join(home, value)
}
async function wslUserPaths(): Promise<{ home: string; claude: string; codex: string; gemini: string; opencodeConfig: string; opencodeData: string } | undefined> {
  const distro = activeWslDistro()
  if (!distro) return undefined
  const home = wslHomePath()!
  const env = await loginEnv()
  return {
    home,
    claude: wslUserPath(env['CLAUDE_CONFIG_DIR'], join(home, '.claude'), distro, home),
    codex: wslUserPath(env['CODEX_HOME'], join(home, '.codex'), distro, home),
    gemini: wslUserPath(env['GEMINI_CLI_HOME'], join(home, '.gemini'), distro, home),
    opencodeConfig: join(wslUserPath(env['XDG_CONFIG_HOME'], join(home, '.config'), distro, home), 'opencode'),
    opencodeData: join(wslUserPath(env['XDG_DATA_HOME'], join(home, '.local', 'share'), distro, home), 'opencode')
  }
}
const claudeProvider = async () => {
  const paths = await wslUserPaths()
  return userProvider(paths?.claude)
}
const codexProvider = async () => {
  const paths = await wslUserPaths()
  return userCodexProvider(paths?.codex)
}
const openCodeProviders = async (v2 = false) => {
  const paths = await wslUserPaths()
  return userOpencodeProviders(paths?.opencodeConfig, v2)
}
const openCodeUserData = async (): Promise<string | undefined> => {
  const paths = await wslUserPaths()
  return paths?.opencodeData
}
let wslGatewayProblem: string | undefined

const unknownEngine: EngineStatus = { installed: false, loggedIn: false }
let engines: Record<EngineId, EngineStatus> = { claude: unknownEngine, codex: unknownEngine, opencode: unknownEngine, pi: unknownEngine, gemini: unknownEngine }
// The models OpenCode and Pi list (what the person has logins for), from the last check.
let listed: Partial<Record<EngineId, string[]>> = {}
let detectGeneration = 0

const fakeStatus = (v: string): EngineStatus => ({ installed: true, loggedIn: true, path: 'fake', version: v, account: L('Motor de teste', 'Test engine'), route: 'plan' })
async function detect(): Promise<void> {
  const generation = ++detectGeneration
  const distro = activeWslDistro()
  if (distro) {
    const installed = await listWslDistributions()
    if (generation !== detectGeneration) return
    if (!installed.some((d) => d.name.toLowerCase() === distro.toLowerCase() && d.version === 2)) {
      const warning = L(`A distribuição ${distro} não está disponível como WSL 2.`, `The ${distro} distribution is not available as WSL 2.`)
      setExecutionProblem(warning)
      const unavailable: EngineStatus = { installed: false, loggedIn: false, warning }
      engines = { claude: unavailable, codex: unavailable, opencode: unavailable, pi: unavailable, gemini: unavailable }
      listed = {}
      gatewayLists.clear()
      emit({ type: 'settings', settings: settings() })
      return
    }
    if (wslGatewayProblem) {
      setExecutionProblem(wslGatewayProblem)
      const unavailable: EngineStatus = { installed: false, loggedIn: false, warning: wslGatewayProblem }
      engines = { claude: unavailable, codex: unavailable, opencode: unavailable, pi: unavailable, gemini: unavailable }
      listed = {}
      gatewayLists.clear()
      emit({ type: 'settings', settings: settings() })
      return
    }
    setExecutionProblem(undefined)
  }
  if (fake) {
    engines = { claude: fakeStatus('0.0.0'), codex: fakeStatus('0.0.0'), opencode: { ...fakeStatus('0.0.0'), route: 'providers', account: 'OpenAI, OpenCode · 3 modelos' }, pi: { installed: false, loggedIn: false }, gemini: { installed: false, loggedIn: false } }
    listed = { opencode: ['openai/gpt-5.5', 'opencode/big-pickle', 'opencode-go/qwen3.8-max'] }
  } else {
    const result = await detectEngines(codexHome)
    if (generation !== detectGeneration) return
    engines = result.engines
    listed = result.listed
  }
  gatewayLists.clear()
  emit({ type: 'settings', settings: settings() })
}
const gateway = new Gateway()
async function exposeWslGateway(distro: string): Promise<void> {
  await gateway.exposeToWsl()
  const target = gateway.agentTarget()
  if (await wslCanConnect(distro, target.host, target.port)) return

  const fallback = wslHostAddress(distro)
  const unreachable = (): Error => new Error(L('A distribuição não consegue alcançar o gateway local do Tucano. Confira a rede do WSL 2.', 'The distribution cannot reach Tucano’s local gateway. Check WSL 2 networking.'))
  if (!fallback || fallback === target.host) throw unreachable()
  await gateway.exposeToWsl(fallback)
  const fallbackTarget = gateway.agentTarget()
  if (!(await wslCanConnect(distro, fallbackTarget.host, fallbackTarget.port))) throw unreachable()
}
async function startGateway(): Promise<void> {
  await gateway.start()
  const distro = activeWslDistro()
  if (!distro) return
  try {
    await exposeWslGateway(distro)
  } catch (error) {
    wslGatewayProblem = L(`Não consegui abrir o gateway do Tucano para o WSL: ${error instanceof Error ? error.message : String(error)}`, `Couldn't expose Tucano's gateway to WSL: ${error instanceof Error ? error.message : String(error)}`)
  }
}
const ready = startGateway().then(() => (fake ? Promise.resolve() : adoptLoginShellPath()).then(detect))

const settings = (): Settings => {
  const s = db.getSettings(DEFAULTS)
  setLang(s.language)
  return { ...s, engines: withChoice(engines, s.harnesses), jevKey: db.getSecret(JEV_SECRET) !== undefined, telegram: telegram?.info(), github: githubInfo() }
}
// github is made further down; settings can be asked for before.
const githubInfo = (): Settings['github'] => githubRef?.info()

const engineImpls: Record<EngineId, Engine> = fake
  ? { claude: fakeEngine('claude'), codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini') }
  : {
      claude: claudeEngine(() => engines.claude.path, async () => quietClaude(await claudeProvider())),
      codex: codexEngine(() => engines.codex.path, codexHome, loginEnv, async () => quietCodex(await codexProvider())),
      opencode: opencodeEngine(
        () => engines.opencode.path,
        join(dataDir, 'opencode-home'),
        loginEnv,
        () => engines.opencode.version,
        openCodeProviders,
        openCodeUserData,
        () => !!activeWslDistro()
      ),
      pi: piEngine(() => engines.pi.path, join(dataDir, 'pi'), loginEnv),
      gemini: geminiEngine(() => engines.gemini.path, geminiAppDir(dataDir), loginEnv, async () => (await wslUserPaths())?.gemini)
    }

// A command in the login shell, where SSO tools live; what it prints, trimmed.
// Windows has no login shell: the same shell agents' commands use (Git Bash, or cmd.exe).
const runHelper = (cmd: string): Promise<string | undefined> => {
  const sh = isWin ? shellCommand(cmd) : { file: loginShell(), args: ['-lc', cmd], verbatim: false, env: process.env }
  return new Promise((resolve) =>
    execFile(sh.file, sh.args, { timeout: 30_000, env: sh.env, windowsHide: true, windowsVerbatimArguments: sh.verbatim }, (err, out) => {
      if ('cleanup' in sh) sh.cleanup?.()
      resolve(err ? undefined : String(out).trim() || undefined)
    })
  )
}

// The MCP servers in the harnesses' own setup, and which are already connectors (same address).
async function foundMcps(): Promise<FoundMcp[]> {
  const env = { ...process.env, ...(await loginEnv()) }
  const have = new Set(connectors.list().map((c) => (c.kind === 'remote' ? `url:${(c.url ?? '').replace(/\/+$/, '')}` : `cmd:${[c.command, ...(c.args ?? [])].join(' ')}`)))
  const paths = await wslUserPaths()
  const dirs = paths ? { claude: join(paths.home, '.claude.json'), codex: paths.codex, opencode: paths.opencodeConfig } : {}
  const distro = activeWslDistro()
  return harnessMcps(dirs, env).map((m) => ({
    ...m,
    ...(distro && m.kind === 'stdio' ? { input: { ...m.input, executionTarget: { kind: 'wsl' as const, distro } } } : {}),
    added: have.has(m.key)
  }))
}

// Where a harness on a gateway sends its requests, and with which key, as its own config says.
async function gatewayTarget(engine: EngineId): Promise<{ baseUrl: string; key?: string } | undefined> {
  if (engine === 'claude') {
    const c = await claudeProvider()
    const baseUrl = c.env['ANTHROPIC_BASE_URL']
    if (!baseUrl) return undefined
    return { baseUrl, key: c.env['ANTHROPIC_AUTH_TOKEN'] || c.env['ANTHROPIC_API_KEY'] || (c.apiKeyHelper ? await runHelper(c.apiKeyHelper) : undefined) }
  }
  if (engine !== 'codex') return undefined
  const x = await codexProvider()
  if (!x.baseUrl) return undefined
  const shell = await loginEnv()
  return { baseUrl: x.baseUrl, key: x.envNames.filter((n) => n !== 'OPENAI_BASE_URL').map((n) => shell[n]).find(Boolean) }
}
const gatewayLists = new Map<EngineId, Promise<{ models: string[]; error?: string }>>()

// ---------- ports ----------

const ports = new Set<MessagePortMain>()
function emit(event: CoreEvent): void {
  const wire: Wire = { event }
  for (const p of ports) p.postMessage(wire)
  toPhone(event)
}

// The phone gets each new approval and question as it happens (spec §19).
let telegram: Telegram | undefined
let githubRef: GitHub | undefined
const sentToPhone = new Set<string>()
function toPhone(e: CoreEvent): void {
  if (!telegram) return
  const name = (id: string): string => db.agent(id)?.name ?? L('Um agente', 'An agent')
  if (e.type === 'approval' && e.approval.state === 'pending' && !sentToPhone.has(e.approval.id)) {
    sentToPhone.add(e.approval.id)
    void telegram.approvalAsked(e.approval, name(e.approval.agentId))
  } else if (e.type === 'message' && e.message.run?.status === 'waiting_input' && e.message.run.question && e.message.author.kind === 'agent' && !sentToPhone.has(e.message.id)) {
    sentToPhone.add(e.message.id)
    const conv = db.conversation(e.message.conversationId)
    void telegram.questionAsked(e.message, name(e.message.author.id), conv?.kind === 'channel' ? `#${conv.name}` : L('na DM', 'in the DM'))
  }
}

// Desktop notification, and the same on the phone.
const notifyAll = (title: string, body: string, conversationId?: string): void => {
  toMain({ type: 'notify', title, body, conversationId })
  void telegram?.notice(title, body)
}

// Asks the main process to do what only it can: open the browser or a folder, show a notification.
type ToMain =
  | { type: 'open'; url: string }
  | { type: 'open_path'; path: string }
  | { type: 'notify'; title: string; body: string; conversationId?: string; kind?: 'approval' | 'question' | 'done' }
  | { type: 'login_item'; open: boolean }
  | { type: 'busy'; busy: boolean }
  | { type: 'lang'; lang: Lang }
const toMain = (msg: ToMain): void =>
  process.parentPort.postMessage(msg)
// The menu is the main process's: it follows the language picked here.
toMain({ type: 'lang', lang: db.getSettings(DEFAULTS).language })

// Screenshots use Electron's Chromium, which lives in the main process.
const shots = new Map<string, { resolve: (b: Buffer) => void; reject: (e: Error) => void }>()
// Agents' browsers too (spec §24).
const pages = new Map<string, { resolve: (r: BrowserReply) => void; reject: (e: Error) => void }>()
process.parentPort.on('message', (e) => {
  const r = e.data as { type?: string; id: string; data?: unknown; error?: string; awake?: boolean; agentId?: string; shown?: boolean } | undefined
  if (r?.type === 'power') return routines.setAwake(r.awake === true)
  if (r?.type === 'browser-shown') return browser.setShown(r.agentId ?? '', r.shown === true)
  if (r?.type === 'browser-result') {
    const p = pages.get(r.id)
    pages.delete(r.id)
    if (r.error !== undefined) p?.reject(new Error(r.error))
    else p?.resolve(r.data as BrowserReply)
    return
  }
  if (r?.type !== 'screenshot-result') return
  const p = shots.get(r.id)
  shots.delete(r.id)
  if (r.error !== undefined) p?.reject(new Error(r.error))
  else p?.resolve(Buffer.from(String(r.data ?? ''), 'base64'))
})
// On a server there's no Electron: the agents' Chrome takes the picture instead.
const shoot: Shooter = (opts) => (serverMode && chrome ? chrome.shot(opts) : electronShoot(opts))
const electronShoot: Shooter = (opts) =>
  new Promise((resolve, reject) => {
    const id = randomUUID()
    shots.set(id, { resolve, reject })
    process.parentPort.postMessage({ type: 'screenshot', id, ...opts })
  })

const electronHost: BrowserHost = (agentId, op, args) =>
  new Promise((resolve, reject) => {
    const id = randomUUID()
    pages.set(id, { resolve, reject })
    process.parentPort.postMessage({ type: 'browser', id, agentId, op, args })
    setTimeout(() => pages.get(id) && (pages.delete(id), reject(new Error(L('o navegador não respondeu em 60 s', "the browser didn't answer in 60 s")))), 60_000).unref()
  })
// Google Chrome when the Mac has it (Google refuses logins in embedded browsers); Electron's Chromium otherwise.
const chrome =
  !fake && hasChrome()
    ? new ChromeBrowsers(
        join(dataDir, 'navegador'),
        (agentId, shown) => browser.setShown(agentId, shown),
        undefined,
        (agentId, jpeg) => browser.frame(agentId, jpeg),
        serverMode
      )
    : undefined
const host: BrowserHost = chrome ? (agentId, op, args) => chrome.run(agentId, op, args) : electronHost

const secrets = new Secrets(db, fake ? plainCipher : mainCipher(process.parentPort))
const browser = new Browser({
  host,
  db,
  dataDir,
  emit,
  me: () => settings().workspaceName,
  jev: { key: () => secrets.get(JEV_SECRET), on: () => !!settings().browserJev && settings().jevKey === true },
  onHandback: (agentId) => void runner.handedBack(agentId)
})
const connectors = new ConnectorManager({
  db,
  secrets,
  emit,
  // On a server there's nothing to open it in: authorizeConnector hands it to the page.
  openUrl: (url) => serverMode || toMain({ type: 'open', url }),
  oauthCallbackUrl: () => gateway.url('/oauth/callback')
})
gateway.route('/oauth/callback', async (url) => {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state') ?? ''
  if (!code) {
    const why = url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? L('sem código', 'no code')
    return L(`Autorização não concluída: ${why}.`, `Authorization not completed: ${why}.`)
  }
  return (await connectors.finishOAuth(state, code))
    ? L('Conector autorizado. Pode fechar esta aba e voltar pro Tucano.', 'Connector authorized. You can close this tab and go back to Tucano.')
    : L('Esse pedido de autorização expirou. Tente de novo pelo app.', 'This authorization request expired. Try again from the app.')
})

const memory = new Memories({ db, engines: engineImpls, settings: () => ready.then(settings), emit, workDir: join(dataDir, 'agents') })

// Issue to PR: the GitHub proxy agents' computers push through (spec §22).
const github: GitHub = new GitHub({
  secrets,
  db,
  post: (conversationId, text) => {
    const m: Message = { id: randomUUID(), conversationId, author: { kind: 'system' }, text, at: Date.now() }
    db.saveMessage(m)
    emit({ type: 'message', message: m })
  },
  changed: () => emit({ type: 'settings', settings: settings() })
})

githubRef = github
const computers = new Computers({ db, dataDir, emit, shoot, gitRemote: (agentId) => github.gitRemote(agentId) })
const backups = join(dataDir, 'backups')

// The runner runs routines, and agents schedule routines through the runner's tools.
const routines = new Routines({
  db,
  runner: { runRoutine: (r, when) => runner.runRoutine(r, when) },
  connectors: { call: (id, tool, args) => connectors.call(id, tool, args), list: () => connectors.list() },
  blocked: () => !!settings().paused || inQuietHours(settings().quietHours),
  emit,
  notify: notifyAll
})

const skills = new Skills({ db, emit, notify: (title, body) => notifyAll(title, body) })

const runner = new Runner({
  db,
  engines: engineImpls,
  settings: () => ready.then(settings),
  emit,
  workDir: join(dataDir, 'agents'),
  dataDir,
  gateway,
  connectors,
  memory,
  computers,
  browser,
  routines,
  skills,
  models: () => availableModels(settings(), listed),
  // Approvals and questions reach the phone with their buttons, through toPhone; a finished reply stays on the Mac.
  notify: (title, body, conversationId, kind) => (kind ? toMain({ type: 'notify', title, body, conversationId, kind }) : notifyAll(title, body, conversationId)),
  jev: { key: () => secrets.get(JEV_SECRET) },
  github,
  onBusy: (busy) => toMain({ type: 'busy', busy }),
  onQuota: (quota) => {
    db.setSettings({ quota })
    emit({ type: 'settings', settings: settings() })
  }
})
runner.setPaused(!!settings().paused)
// Installs from before the Tuca get him at the first start after the introduction.
void ready.then(() => {
  if (settings().onboarding?.done) ensureTuca()
})

telegram = new Telegram({
  secrets,
  decide: (id, decision, reason) => runner.decide(id, decision, reason),
  approval: (id) => db.approval(id),
  answer: (conversationId, text) => void runner.send(conversationId, text),
  changed: () => emit({ type: 'settings', settings: settings() })
})

// Routines started by something on this Mac: POST http://127.0.0.1:WEBHOOK_PORT/gatilho/<token>.
const hooks = createServer((req, res) => {
  const m = /^\/gatilho\/([\w-]{10,})$/.exec(req.url ?? '')
  if (req.method !== 'POST' || !m) return void res.writeHead(404).end(L('Use POST /gatilho/<código>\n', 'Use POST /gatilho/<code>\n'))
  let body = ''
  let tooBig = false
  req.setEncoding('utf8')
  req.on('data', (chunk: string) => {
    body += chunk
    if (body.length > 64_000) tooBig = true
  })
  req.on('end', () => {
    if (tooBig) return void res.writeHead(413).end(L('Grande demais (máx. 64 KB).\n', 'Too big (max. 64 KB).\n'))
    const r = routines.webhook(m[1]!, body)
    res
      .writeHead(r === 'ok' ? 202 : r === 'busy' ? 409 : 404)
      .end(r === 'ok' ? L('Rotina disparada.\n', 'Routine fired.\n') : r === 'busy' ? L('A rotina ainda está rodando.\n', 'The routine is still running.\n') : L('Nenhuma rotina ligada com esse endereço.\n', 'No routine on with that address.\n'))
  })
})
hooks.on('error', (e) => console.error(`[gatilhos] porta ${WEBHOOK_PORT}:`, e.message))


void ready.then(async () => {
  connectors.connectAll()
  returnChannelFolders()
  for (const a of db.agents()) if (a.computer && !a.archived) void computers.refresh(a)
  await runner.expireApprovals()
  setInterval(() => void runner.expireApprovals(), 60_000).unref()
  routines.start()
  // Nothing here waits on the keychain: the first use after an update can be a
  // macOS prompt that stays open until someone answers it.
  void github.start().catch((e: unknown) => console.error('[github]', e))
  if (!fake) {
    hooks.listen(WEBHOOK_PORT, '127.0.0.1')
    github.listen()
    void telegram?.start()
  }
  // A copy of the database once a day, the last 7 kept.
  const daily = (): void => {
    try {
      backupIfDue(db, backups)
    } catch (e) {
      console.error('[backup]', e)
    }
  }
  daily()
  setInterval(daily, 3_600_000).unref()
})
toMain({ type: 'login_item', open: !!settings().openAtLogin })

// Channels used to lend a project folder to their members; those folders go back.
function returnChannelFolders(): void {
  for (const agent of db.agents()) {
    const folders = agent.folders ?? []
    const kept = folders.filter((f) => !('channelId' in f))
    if (kept.length < folders.length) setFolders(agent, kept)
  }
}

function setFolders(agent: Agent, folders: NonNullable<Agent['folders']>): void {
  db.setFolders(agent.id, folders)
  emit({ type: 'agent', agent: db.agent(agent.id)! })
  if (agent.computer) void computers.ensure(agent.id).catch((e: unknown) => console.error('[computer]', e))
}

function emitConversations(ids?: string[]): void {
  for (const c of db.conversations()) if (!ids || ids.includes(c.id)) emit({ type: 'conversation', conversation: c })
}

const demoPath = join(process.cwd(), 'scripts', 'demo-mcp-server.mjs')

// The Tuca, made once (the introduction, or the first start after it) and kept
// even when archived. His model: the one given, else a plan's, else the router's
// or the memory's, which the introduction made sure work.
// `fresh` starts a new session: the builder screen opens with only his hello.
function ensureTuca(modelId?: string, fresh = false): { agentId: string; conversationId: string } {
  const s = settings()
  const works = (id: string): boolean => {
    const m = modelInfo(id)
    return !!m?.id && s.engines[m.engine].loggedIn
  }
  let tuca = db.agents().find((a) => a.kind === 'tuca')
  // A harness turned off since: the model given now, if it works.
  if (tuca && !works(tuca.modelId) && modelId && works(modelId)) {
    tuca = { ...tuca, modelId }
    db.saveAgent(tuca)
    emit({ type: 'agent', agent: tuca })
  }
  if (!tuca) {
    const model = [modelId, 'sonnet', 'gpt-5.6-luna', s.routerModel, s.memoryModel, availableModels(s, listed)[0]?.id].find((id): id is string => !!id && id !== 'jev' && works(id))
    tuca = tucaAgent(model ?? 'sonnet', db.agents().map((a) => a.handle), s.defaultLimit)
    db.saveAgent(tuca)
    emit({ type: 'agent', agent: tuca })
  }
  let dm = db.conversations().find((c) => c.kind === 'dm' && c.name === tuca!.id)
  if (dm && fresh) {
    for (const m of db.messages()) if (m.conversationId === dm.id && m.run?.status === 'working') runner.stop(m.id)
    db.deleteConversation(dm.id)
    emit({ type: 'conversation_removed', id: dm.id })
    dm = undefined
  }
  if (!dm) {
    db.createConversation({ id: randomUUID(), kind: 'dm', name: tuca.id, members: [tuca.id] })
    dm = db.conversations().find((c) => c.kind === 'dm' && c.name === tuca!.id)!
    const hello: Message = { id: randomUUID(), conversationId: dm.id, author: { kind: 'agent', id: tuca.id }, text: tucaHello(), at: Date.now() }
    db.saveMessage(hello)
    emitConversations([dm.id])
    emit({ type: 'message', message: hello })
  }
  return { agentId: tuca.id, conversationId: dm.id }
}

// A Tuca's card is settled once: created (with the agent) or dismissed.
function settleDraft(messageId: string, agentId?: string): void {
  const m = db.message(messageId)
  if (!m?.run?.agentDraft || m.run.agentDraft.state) return
  const updated: Message = { ...m, run: { ...m.run, agentDraft: { ...m.run.agentDraft, state: agentId ? 'created' : 'dismissed', ...(agentId ? { agentId } : {}) } } }
  db.saveMessage(updated)
  emit({ type: 'message', message: updated })
}


const api: Api = {
  // The page loads from file://, which can't fetch tucano:// (CORS); text comes through the core instead.
  artifactText: ({ id }) => {
    const a = db.artifacts().find((x) => x.id === id)
    if (!a) return null
    const file = join(dataDir, 'artifacts', a.id, a.name)
    try {
      return readFileSync(file, 'utf8').slice(0, 2_000_000)
    } catch {
      return null
    }
  },

  snapshot: () => ({
    settings: settings(),
    agents: db.agents(),
    conversations: db.conversations(),
    messages: db.messages(),
    connectors: connectors.list(),
    approvals: db.approvals(),
    memories: db.memories(),
    artifacts: db.artifacts(),
    computers: db.agents().map((a) => computers.info(a)),
    browsers: browser.list(),
    routines: db.routines(),
    skills: db.skills(),
    platform: osOf(),
    packaged: process.env['TUCANO_PACKAGED'] === '1',
    demoServer: existsSync(demoPath) ? { command: 'node', args: [demoPath] } : undefined
  }),

  wslDistributions: async () => (isWin ? listWslDistributions() : []),

  sendMessage: ({ conversationId, text, images }) => {
    void runner.send(conversationId, text, images)
  },

  stopRun: ({ messageId }) => runner.stop(messageId),

  retryRun: ({ messageId }) => runner.retry(messageId),

  continueRun: ({ messageId }) => void runner.continue(messageId),

  saveAgent: ({ agent, channelIds }) => {
    const before = db.agent(agent.id)
    // Archived changes only through archiveAgent, which also stops what the agent was doing.
    const clean: Agent = { ...agent, name: agent.name.trim(), handle: agent.handle.trim().toLowerCase(), archived: before?.archived ?? false }
    const linux = (a?: Agent): boolean => !!a?.computer && a.computerKind !== 'mac'
    const mac = (a?: Agent): boolean => !!a?.computer && a.computerKind === 'mac'
    db.saveAgent(clean)
    // A Linux computer starts right away when turned on (the first time downloads the system) and stops when
    // turned off or moved to the Mac; a computer on the Mac has nothing to start, only its services to stop.
    if (linux(clean) && !linux(before)) void computers.ensure(clean.id).catch(() => {})
    if (linux(before) && !linux(clean))
      void computers.stopLinux(clean.id).then(() => {
        if (mac(clean)) db.removeServices(clean.id) // the container's services don't exist on the Mac
        return computers.refresh(clean)
      })
    if (mac(before) && !mac(clean)) void computers.mac.stopAll(clean.id).then(() => computers.refresh(clean))
    if (mac(clean) && !mac(before)) void computers.refresh(clean)
    if (before?.browser && !clean.browser) void browser.close(clean.id) // its logins stay, for when it's turned back on
    const changed = db.setAgentChannels(clean.id, channelIds)
    emit({ type: 'agent', agent: db.agent(clean.id)! })
    emitConversations(changed)
  },

  // Archived, an agent keeps its history and receipts but stops: replies running end,
  // its routines turn off, its browser closes. Its channels and settings stay for when it comes back.
  archiveAgent: ({ id, archived }) => {
    const agent = db.agent(id)
    if (!agent || agent.archived === archived) return
    if (archived) {
      for (const m of db.messages()) if (m.author.kind === 'agent' && m.author.id === id && (m.run?.status === 'working' || m.run?.status === 'waiting_approval')) runner.stop(m.id)
      routines.pauseAgent(id)
      if (agent.browser) void browser.close(id)
    }
    db.saveAgent({ ...agent, archived })
    emit({ type: 'agent', agent: db.agent(id)! })
    emitConversations()
  },
  renameChannel: ({ id, name }) => {
    const conv = db.conversation(id)
    if (conv?.kind !== 'channel') return
    const clean = channelName(name)
    if (!clean) throw new Error(L('Dê um nome ao canal.', 'Give the channel a name.'))
    if (db.conversations().some((c) => c.kind === 'channel' && c.name === clean && c.id !== id)) throw new Error(L(`Já existe o canal #${clean}.`, `There's already a #${clean} channel.`))
    db.renameConversation(id, clean)
    emitConversations([id])
  },
  setTopic: ({ id, topic }) => {
    if (db.conversation(id)?.kind !== 'channel') return
    db.setTopic(id, topic.trim() || undefined)
    emitConversations([id])
  },
  setChannelMembers: ({ id, agentIds }) => {
    if (db.conversation(id)?.kind !== 'channel') return
    const known = new Set(db.agents().filter((a) => !a.archived).map((a) => a.id))
    db.setMembers(id, agentIds.filter((a) => known.has(a)))
    emitConversations([id])
  },
  // Everything that only made sense there goes too: replies still running stop,
  // its routines, its pending approvals.
  deleteConversation: ({ id }) => {
    if (!db.conversation(id)) return
    for (const m of db.messages()) if (m.conversationId === id && (m.run?.status === 'working' || m.run?.status === 'waiting_approval')) runner.stop(m.id)
    for (const r of db.routines()) if (r.conversationId === id) routines.remove(r.id)
    for (const a of db.approvals()) if (a.conversationId === id && a.state === 'pending' && db.decideApproval(a.id, 'expired', L('O canal foi excluído.', 'The channel was deleted.'))) emit({ type: 'approval', approval: db.approvals().find((x) => x.id === a.id)! })
    db.deleteConversation(id)
    emit({ type: 'conversation_removed', id })
  },

  createChannel: ({ name }) => {
    const clean = channelName(name)
    if (!clean) throw new Error(L('Dê um nome ao canal.', 'Give the channel a name.'))
    if (db.conversations().some((c) => c.kind === 'channel' && c.name === clean)) throw new Error(L(`Já existe o canal #${clean}.`, `There's already a #${clean} channel.`))
    const id = randomUUID()
    db.createConversation({ id, kind: 'channel', name: clean, members: [] })
    emitConversations([id])
    return id
  },

  ensureTuca: ({ modelId, fresh }) => ensureTuca(modelId, fresh),
  createFromDraft: ({ messageId }) => {
    const d = db.message(messageId)?.run?.agentDraft
    if (!d) throw new Error(L('Essa proposta não existe mais.', 'That proposal no longer exists.'))
    if (d.state === 'created' && d.agentId) throw new Error(L('Esse agente já foi criado.', 'That agent was already created.'))
    const agent = agentFromDraft(d, db.agents().map((a) => a.handle), settings().defaultLimit)
    db.saveAgent(agent)
    emit({ type: 'agent', agent })
    settleDraft(messageId, agent.id)
    const conversationId = randomUUID()
    db.createConversation({ id: conversationId, kind: 'dm', name: agent.id, members: [agent.id] })
    emitConversations([conversationId])
    return { agentId: agent.id, conversationId }
  },
  settleDraft: ({ messageId, agentId }) => settleDraft(messageId, agentId),
  openDm: ({ agentId }) => {
    const existing = db.conversations().find((c) => c.kind === 'dm' && c.name === agentId)
    if (existing) return existing.id
    const id = randomUUID()
    db.createConversation({ id, kind: 'dm', name: agentId, members: [agentId] })
    emitConversations([id])
    return id
  },

  saveSkill: ({ skill }) => skills.save(skill),
  localSkills: async () => {
    const paths = await wslUserPaths()
    return findLocalSkills(paths?.home, paths ? { claude: paths.claude, codex: paths.codex } : undefined)
  },
  linkSkill: async ({ source, agents }) => {
    const paths = await wslUserPaths()
    if (!findLocalSkills(paths?.home, paths ? { claude: paths.claude, codex: paths.codex } : undefined).some((k) => k.source === source)) throw new Error(L('Essa skill não está mais no seu Claude Code nem no Codex.', "That skill is no longer in your Claude Code or Codex."))
    return skills.link(source, agents)
  },
  decideSkill: ({ id, approve }) => void skills.decide(id, approve),
  restoreSkill: ({ skillId, versionId }) => void skills.restore(skillId, versionId),
  archiveSkill: ({ id, archived }) => void skills.archive(id, archived),
  removeSkill: ({ id }) => skills.remove(id),
  skillVersions: ({ skillId }) => db.skillVersions(skillId),

  checkTrigger: ({ trigger }) => routines.preview(trigger),

  setTelegramToken: ({ token }) => telegram!.setToken(token),
  setGithubToken: ({ token }) => github.setToken(token),
  exportTeam: () => exportTeam(db),
  importTeam: ({ text }) => {
    const r = importTeam(db, text, settings().defaultLimit)
    for (const a of db.agents()) emit({ type: 'agent', agent: a })
    emitConversations()
    for (const k of db.skills()) emit({ type: 'skill', skill: k })
    for (const r2 of db.routines()) emit({ type: 'routine', routine: r2 })
    return r
  },
  backupNow: () => backup(db, backups),
  openBackups: () => {
    mkdirSync(backups, { recursive: true })
    toMain({ type: 'open_path', path: backups })
  },
  report: ({ week }) => report(db, Date.now(), week),
  usage: () => usage(db),
  unpairTelegram: () => void telegram?.unpair(),

  // Checked with TypeSafe before it's saved; null removes it.
  setJevKey: async ({ key }) => {
    const k = key?.trim()
    if (k) await checkJevKey(k)
    await secrets.set(JEV_SECRET, k || undefined)
    if (!k && settings().routerModel === JEV_MODEL) db.setSettings({ routerModel: 'haiku' })
    emit({ type: 'settings', settings: settings() })
  },

  // The models a harness offers, besides the app's list for a plan: what Gemini CLI,
  // OpenCode and Pi list, or what the gateway in Claude Code's or Codex's config lists.
  engineModels: async ({ engine }) => {
    if (listed[engine]) return { models: listed[engine]! }
    if (engines[engine].route !== 'gateway') return { models: [] }
    if (!gatewayLists.has(engine))
      gatewayLists.set(
        engine,
        (async () => {
          const t = await gatewayTarget(engine)
          if (!t) return { models: [], error: L('Sem endereço do gateway.', 'No gateway address.') }
          return { models: await listModels(engine, t.baseUrl, t.key) }
        })().catch((e: unknown) => ({ models: [], error: e instanceof Error ? e.message : String(e) }))
      )
    return gatewayLists.get(engine)!
  },

  // A real question through the chosen engine and model: what fails here would fail every reply.
  testEngine: async ({ model }) => {
    const m = modelInfo(model)
    if (!m?.id) return { ok: false, message: L('Escolha um modelo pra testar.', 'Pick a model to test.') }
    const st = settings().engines[m.engine]
    if (!st.installed) return { ok: false, message: L(`O ${ENGINES[m.engine].label} não está instalado.`, `${ENGINES[m.engine].label} isn't installed.`) }
    const cwd = join(dataDir, 'teste')
    mkdirSync(cwd, { recursive: true })
    const started = Date.now()
    let text = ''
    let error: string | undefined
    for await (const ev of engineImpls[m.engine].run({ model: m.id, effort: 'low', system: L('Responda só com a palavra pronto.', 'Reply only with the word ready.'), prompt: L('Teste de conexão.', 'Connection test.'), cwd, signal: AbortSignal.timeout(90_000) })) {
      if (ev.type === 'text') text += ev.delta
      else if (ev.type === 'done') text = ev.text || text
      else if (ev.type === 'error') error = ev.message
    }
    if (error || !text.trim()) return { ok: false, message: error ?? L('O modelo não respondeu.', "The model didn't answer.") }
    const secs = ((Date.now() - started) / 1000).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    return { ok: true, message: L(`${m.id} respondeu em ${secs} s: “${text.trim().slice(0, 60)}”`, `${m.id} answered in ${secs} s: “${text.trim().slice(0, 60)}”`) }
  },

  updateSettings: async ({ patch: { jevKey: _computed, telegram: _phone, ...patch } }) => {
    if (patch.executionTarget) {
      if (patch.executionTarget.kind === 'wsl') {
        const distro = patch.executionTarget.distro.trim()
        const installed = await listWslDistributions()
        if (!installed.some((d) => d.name.toLowerCase() === distro.toLowerCase() && d.version === 2)) throw new Error(L('Escolha uma distribuição WSL 2 instalada.', 'Choose an installed WSL 2 distribution.'))
        setExecutionTarget({ kind: 'wsl', distro })
        try {
          await exposeWslGateway(distro)
          wslGatewayProblem = undefined
        } catch (error) {
          wslGatewayProblem = L(`Não consegui abrir o gateway do Tucano para o WSL: ${error instanceof Error ? error.message : String(error)}`, `Couldn't expose Tucano's gateway to WSL: ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        wslGatewayProblem = undefined
        setExecutionTarget({ kind: 'windows' })
        gateway.useWindowsHost()
      }
    }
    db.setSettings(patch)
    if (patch.paused !== undefined) runner.setPaused(patch.paused)
    if (patch.openAtLogin !== undefined) toMain({ type: 'login_item', open: patch.openAtLogin })
    if (patch.onboarding?.done) void ready.then(() => ensureTuca()) // skipping the introduction still gets the Tuca
    if (patch.language) toMain({ type: 'lang', lang: patch.language })
    if (patch.executionTarget) await detect()
    else emit({ type: 'settings', settings: settings() })
  },

  // Validation errors come back to the form; connecting continues in the background.
  addConnector: ({ input }) => connectors.add(input),

  removeConnector: ({ id }) => void connectors.remove(id),
  reconnectConnector: ({ id }) => void connectors.connect(id),
  authorizeConnector: async ({ id }) => {
    const url = await connectors.authorize(id)
    return serverMode && url ? { url } : {}
  },
  finishConnectorAuth: ({ url }) => connectors.finishOAuthFromUrl(url),
  harnessMcps: async () => (await foundMcps()).map(publicMcp),
  importHarnessMcp: async ({ key }) => {
    const m = (await foundMcps()).find((x) => x.key === key)
    if (!m) throw new Error(L('Esse servidor não está mais na configuração do harness.', "That server is no longer in the harness's configuration."))
    if (m.added) throw new Error(L(`${m.name} já é um conector.`, `${m.name} is already a connector.`))
    return connectors.add(m.input)
  },
  updateTool: ({ connectorId, name, patch }) => connectors.updateTool(connectorId, name, patch),
  decideApproval: ({ id, decision, reason, always }) => void runner.decide(id, decision, reason?.trim() || undefined, always),

  addMemory: ({ scope, text }) => memory.add(scope, text),
  editMemory: ({ id, text }) => memory.edit(id, text),
  confirmMemory: ({ id }) => memory.confirm(id),
  decideMemory: ({ id, accept }) => memory.decide(id, accept),
  forgetMemory: ({ id, reason }) => memory.forget(id, reason?.trim() || undefined),
  purgeMemory: ({ id }) => memory.purge(id),
  editSummary: ({ conversationId, text }) => memory.editSummary(conversationId, text),
  summarizeNow: ({ conversationId }) => void memory.consolidate(conversationId, true),

  computerAction: ({ agentId, action }) => {
    const agent = db.agent(agentId)
    if (!agent) return
    if (action === 'open_folder') {
      mkdirSync(computers.folder(agentId), { recursive: true })
      return toMain({ type: 'open_path', path: computers.folder(agentId) })
    }
    const run = { start: () => computers.ensure(agentId), restart: () => computers.restart(agentId), erase: () => computers.erase(agentId), refresh: () => computers.refresh(agent) }[action]
    void run().catch((e: unknown) => console.error('[computer]', e))
  },
  stopService: ({ agentId, name }) => void computers.stopService(agentId, name),
  // Driving a taken-over browser from the panel (Tucano as a server: no window to open).
  browserInput: async ({ agentId, input }) => {
    if (!serverMode || !chrome) throw new Error(L('Só no Tucano em servidor.', 'Only on Tucano as a server.'))
    await chrome.run(agentId, 'input', input)
  },

  browserAction: ({ agentId, action }) => {
    const agent = db.agent(agentId)
    if (agent) void browser.action(agent, action).catch((e: unknown) => console.error('[navegador]', e))
  },

  // Lending or returning a folder remakes the computer with the new mounts (what it installed stays).
  lendFolder: ({ agentId, path }) => {
    const agent = db.agent(agentId)
    if (!agent) return
    const why = checkFolder(path, { dataDir })
    if (why) throw new Error(why)
    const folders = agent.folders ?? []
    if (folders.some((f) => f.path === path)) return
    setFolders(agent, [...folders, { name: folderName(path, folders.map((f) => f.name)), path, readOnly: false }])
  },
  folderAction: ({ agentId, name, action }) => {
    const agent = db.agent(agentId)
    if (!agent) return
    const folders = agent.folders ?? []
    setFolders(agent, action === 'return' ? folders.filter((f) => f.name !== name) : folders.map((f) => (f.name === name ? { ...f, readOnly: action === 'read_only' } : f)))
  },
  openExternal: ({ url }) => toMain({ type: 'open', url }),

  saveRoutine: ({ routine }) => routines.save(routine),
  removeRoutine: ({ id }) => routines.remove(id),
  runRoutine: ({ id }) => routines.runNow(id),

  refreshEngines: () => {
    const distro = activeWslDistro()
    if (!distro) return void detect()
    void exposeWslGateway(distro)
      .then(() => (wslGatewayProblem = undefined))
      .catch((error: unknown) => {
        wslGatewayProblem = L(`Não consegui abrir o gateway do Tucano para o WSL: ${error instanceof Error ? error.message : String(error)}`, `Couldn't expose Tucano's gateway to WSL: ${error instanceof Error ? error.message : String(error)}`)
      })
      .then(detect)
  },

  // Login always happens in the CLI's own flow; the app never sees credentials.
  // Codex logs into the app's own home (see codexEnv), separate from the user's.
  loginEngine: ({ engine }) => {
    const bin = engines[engine].path ?? ENGINES[engine].cli
    const sub = ENGINES[engine].login.split(' ').slice(1).join(' ')
    const distro = activeWslDistro()
    if (isWin && distro) {
      const home = wslHome(distro)
      const env = engine === 'codex' ? [`HOME=${windowsPathToWsl(codexHome, distro)}`, `CODEX_HOME=${windowsPathToWsl(join(codexHome, '.codex'), distro)}`] : []
      const subArgs = sub ? sub.split(' ') : []
      const args = ['--distribution', distro, '--cd', home, '--exec', 'bash', '-lc', 'exec env "$@"', 'tucano-login', ...env, bin, ...subArgs]
      const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
      const command = [`& ${quote(wslExecutable())}`, '--distribution', quote(distro), '--cd', quote(home), '--exec', 'bash', '-lc', quote('exec env "$@"'), quote('tucano-login'), ...env.map(quote), quote(bin), ...subArgs.map(quote)].join(' ')
      if (!onPath('wt')) return { opened: false, command }
      spawn('wt.exe', ['-w', '0', 'new-tab', '--', wslExecutable(), ...args], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref()
      return { opened: true, command }
    }
    if (isWin) {
      // A new console window running a small script: cmd's quoting can't be trusted with paths otherwise.
      const script = join(dataDir, 'login.cmd')
      const env = engine === 'codex' ? `set "HOME=${codexHome}"\r\nset "CODEX_HOME=${join(codexHome, '.codex')}"\r\n` : ''
      writeFileSync(script, `@echo off\r\n${env}call "${bin}" ${sub}\r\n`)
      spawn(process.env['ComSpec'] || 'cmd.exe', ['/d', '/c', 'start', '"Tucano"', 'cmd.exe', '/k', `"${script}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref()
      return { opened: true, command: `"${bin}" ${sub}` }
    }
    const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
    const cmd = engine === 'codex' ? `HOME=${q(codexHome)} CODEX_HOME=${q(join(codexHome, '.codex'))} ${q(bin)} ${sub}` : `${q(bin)} ${sub}`
    const term = terminalCommand(cmd, osOf(), onPath)
    // Its own process, so the terminal outlives the app if the person quits it mid-login.
    if (term) spawn(term.bin, term.args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
    return { opened: !!term, command: cmd }
  },

  // The harness's own installer, in a terminal the person sees: its progress, its
  // questions and its errors stay theirs. Detection picks the CLI up once it lands.
  installEngine: async ({ engine }) => {
    const distro = activeWslDistro()
    const windowsExecution = isWin && !distro
    const command = (windowsExecution && ENGINES[engine].windows) || ENGINES[engine].install
    // An npm package needs Node.js first; without it the command would only fail.
    if (/^npm\s/.test(command) && !(distro ? await wslHasCommand(distro, 'npm') : findOnPath('npm'))) return { opened: false, command, needsNode: true }
    if (isWin && distro) {
      const home = wslHome(distro)
      const args = ['--distribution', distro, '--cd', home, '--exec', 'bash', '-lc', command]
      const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
      const manual = [`& ${quote(wslExecutable())}`, '--distribution', quote(distro), '--cd', quote(home), '--exec', 'bash', '-lc', quote(command)].join(' ')
      if (!onPath('wt')) return { opened: false, command: manual }
      spawn('wt.exe', ['-w', '0', 'new-tab', '--', wslExecutable(), ...args], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref()
      return { opened: true, command: manual }
    }
    if (windowsExecution) {
      // A PowerShell window running a small script: the install commands are PowerShell.
      const script = join(dataDir, 'install.ps1')
      writeFileSync(script, `${command}\r\n`)
      spawn(process.env['ComSpec'] || 'cmd.exe', ['/d', '/c', 'start', '"Tucano"', 'powershell.exe', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', `"${script}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref()
      return { opened: true, command }
    }
    const term = terminalCommand(command, osOf(), onPath)
    if (term) spawn(term.bin, term.args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
    return { opened: !!term, command }
  }
}

function handle(port: MessagePortMain, req: Request): void {
  const reply = (r: Omit<Extract<Wire, { id: number }>, 'id'>): void => port.postMessage({ id: req.id, ...r } satisfies Wire)
  const fn = api[req.method as Method] as ((p: unknown) => unknown) | undefined
  if (!fn) return reply({ error: `unknown method ${req.method}` })
  Promise.resolve()
    .then(() => fn(req.params))
    .then(
      (result) => reply({ result }),
      (e: unknown) => {
        console.error(`[core] ${req.method}`, e)
        reply({ error: e instanceof Error ? e.message : String(e) })
      }
    )
}

process.parentPort.on('message', (e) => {
  const port = e.ports[0]
  if (!port) return
  ports.add(port)
  port.on('message', (m) => handle(port, m.data as Request))
  port.on('close', () => ports.delete(port))
  port.start()
})

process.on('exit', () => db.close())
// The app stops the core with SIGTERM, which by default skips the 'exit' handlers
// above and leaves the agents' Chromes running with nothing to drive them.
process.on('SIGTERM', () => process.exit(0))
