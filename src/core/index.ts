// The core runs in an Electron utility process: database, engines and runs
// live here so the window never waits on agent work. The renderer talks to it
// over a MessagePort handed out by the main process.
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MessagePortMain } from 'electron'
import { L, langOf, locale, setLang, type Lang } from '../shared/lang'
import type { Api, CoreEvent, Method, Request, Wire } from '../shared/rpc'
import { channelName, ENGINES, inQuietHours, modelInfo, rememberModels, WEBHOOK_PORT, type Account, type AccountEngine, type Agent, type BrowserReply, type Message, type EngineId, type EngineStatus, type Settings } from '../shared/types'
import { listModels, quietClaude, quietCodex, withChoice } from './harness'
import { cleanLook } from './agent-look'
import { Db } from './db'
import { claudeEngine, userProvider } from './engines/claude'
import { codexEngine, userCodexProvider } from './engines/codex'
import { opencodeEngine } from './engines/opencode'
import { piEngine } from './engines/pi'
import { geminiAppDir, geminiEngine } from './engines/gemini'
import { cursorAppDir, cursorEngine } from './engines/cursor'
import { grokEngine } from './engines/grok'
import { accountDir, accountStatus, adoptLoginShellPath, detectEngines, type CodexModel } from './engines/detect'
import { fakeEngine } from './engines/fake'
import { DesktopApps, macApps, SELF } from './apps'
import { linuxApps, windowsApps, type SystemApp } from './apps-os'
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
import { findOnPath, isWin, loginShell, onPath, openWindowsConsole, osOf, shellCommand, terminalCommand } from './platform'
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
  language: langOf(process.env['TUCANO_LOCALE'])
}

const unknownEngine: EngineStatus = { installed: false, loggedIn: false }
let engines: Record<EngineId, EngineStatus> = { claude: unknownEngine, codex: unknownEngine, opencode: unknownEngine, pi: unknownEngine, gemini: unknownEngine, cursor: unknownEngine, grok: unknownEngine }
// The models OpenCode and Pi list (what the person has logins for), from the last check.
let listed: Partial<Record<EngineId, string[]>> = {}
// Codex's own catalog for this login (names and what each model is for), from the last check.
let codexCatalog: CodexModel[] = []

const fakeStatus = (v: string): EngineStatus => ({ installed: true, loggedIn: true, path: 'fake', version: v, account: L('Motor de teste', 'Test engine'), route: 'plan' })
async function detect(): Promise<void> {
  if (fake) {
    engines = { claude: fakeStatus('0.0.0'), codex: fakeStatus('0.0.0'), opencode: { ...fakeStatus('0.0.0'), route: 'providers', account: 'OpenAI, OpenCode · 3 modelos' }, pi: { installed: false, loggedIn: false }, gemini: { installed: false, loggedIn: false }, cursor: { installed: false, loggedIn: false }, grok: { installed: false, loggedIn: false } }
    listed = { opencode: ['openai/gpt-5.5', 'opencode/big-pickle', 'opencode-go/qwen3.8-max'] }
  } else ({ engines, listed, codexCatalog } = await detectEngines(codexHome))
  await checkAccounts()
  rememberModels(codexCatalog.map((m) => ({ id: m.slug, engine: 'codex', label: m.label, hint: m.description ?? '' })))
  gatewayLists.clear()
  emit({ type: 'settings', settings: settings() })
}
// The harness's own sign-in, in a terminal, with the variables that say which login it is.
function openLogin(engine: EngineId, vars: Record<string, string>): { opened: boolean; command: string } {
  const bin = engines[engine].path ?? ENGINES[engine].cli
  const sub = ENGINES[engine].login.split(' ').slice(1).join(' ')
  if (isWin) {
    // A new console window running a small script, its paths in the environment.
    openWindowsConsole(join(dataDir, 'login.cmd'), [`call "%TUCANO_CLI%" ${sub}`], { TUCANO_CLI: bin, ...vars })
    return { opened: true, command: `"${bin}" ${sub}` }
  }
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const cmd = [...Object.entries(vars).map(([k, v]) => `${k}=${q(v)}`), q(bin), sub].filter(Boolean).join(' ')
  if (fake) return { opened: true, command: cmd } // test engines: nothing to sign into
  const term = terminalCommand(cmd, osOf(), onPath)
  // Its own process, so the terminal outlives the app if the person quits it mid-login.
  if (term) spawn(term.bin, term.args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
  return { opened: !!term, command: cmd }
}

// After a sign-in or an install in a terminal, the harness is checked again every few
// seconds until it shows up (for 10 minutes at most): it appears with no "Check again".
let watching: ReturnType<typeof setInterval> | undefined
function watchEngine(engine: EngineId, done: (s: EngineStatus) => boolean): void {
  if (watching) clearInterval(watching)
  const until = Date.now() + 10 * 60_000
  watching = setInterval(() => {
    if (done(engines[engine]) || Date.now() > until) return void clearInterval(watching)
    void detect()
  }, 4_000)
  watching.unref()
}

const gateway = new Gateway()
const ready = Promise.all([gateway.start(), (fake ? Promise.resolve() : adoptLoginShellPath()).then(detect)])

const settings = (): Settings => {
  const s = db.getSettings(DEFAULTS)
  setLang(s.language)
  return { ...s, engines: withChoice(engines, s.harnesses), jevKey: db.getSecret(JEV_SECRET) !== undefined, telegram: telegram?.info(), github: githubInfo(), accounts: (s.accounts ?? []).map((a) => ({ ...a, ...accountLogins.get(a.id) })) }
}

// More logins of Claude Code and Codex (Settings › Accounts): each in its own folder, checked with
// the CLI's own status when the harnesses are, and every few seconds after a sign-in.
const accountLogins = new Map<string, { loggedIn: boolean; detail?: string }>()
const savedAccounts = (): Account[] => (db.getSettings(DEFAULTS).accounts ?? []).map(({ id, engine, name }) => ({ id, engine, name }))
async function checkAccounts(only?: string): Promise<void> {
  await Promise.all(
    savedAccounts()
      .filter((a) => !only || a.id === only)
      .map(async (a) => {
        const bin = engines[a.engine].path
        if (fake) accountLogins.set(a.id, { loggedIn: true, detail: L('Motor de teste', 'Test engine') })
        else accountLogins.set(a.id, bin ? await accountStatus(a.engine, bin, accountDir(dataDir, a.id)) : { loggedIn: false })
      })
  )
}
let watchingAccount: NodeJS.Timeout | null = null
function watchAccount(id: string): void {
  if (watchingAccount) clearInterval(watchingAccount)
  const until = Date.now() + 10 * 60_000
  watchingAccount = setInterval(() => {
    if (accountLogins.get(id)?.loggedIn || Date.now() > until || !savedAccounts().some((a) => a.id === id)) return void clearInterval(watchingAccount!)
    void checkAccounts(id).then(() => emit({ type: 'settings', settings: settings() }))
  }, 4_000)
  watchingAccount.unref()
}
// github is made further down; settings can be asked for before.
const githubInfo = (): Settings['github'] => githubRef?.info()

const engineImpls: Record<EngineId, Engine> = fake
  ? { claude: fakeEngine('claude'), codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok') }
  : {
      claude: claudeEngine(() => engines.claude.path, async () => quietClaude(userProvider())),
      codex: codexEngine(() => engines.codex.path, codexHome, loginEnv, async () => quietCodex(userCodexProvider())),
      opencode: opencodeEngine(() => engines.opencode.path, join(dataDir, 'opencode-home'), loginEnv, () => engines.opencode.version),
      pi: piEngine(() => engines.pi.path, join(dataDir, 'pi'), loginEnv),
      gemini: geminiEngine(() => engines.gemini.path, geminiAppDir(dataDir), loginEnv),
      cursor: cursorEngine(() => engines.cursor.path, cursorAppDir(dataDir), loginEnv),
      grok: grokEngine(() => engines.grok.path, loginEnv)
    }

// A command in the login shell, where SSO tools live; what it prints, trimmed.
// Windows has no login shell: the same shell agents' commands use (Git Bash, or cmd.exe).
const runHelper = (cmd: string): Promise<string | undefined> => {
  const sh = isWin ? shellCommand(cmd) : { file: loginShell(), args: ['-lc', cmd], verbatim: false, env: process.env }
  return new Promise((resolve) => execFile(sh.file, sh.args, { timeout: 30_000, env: sh.env, windowsHide: true, windowsVerbatimArguments: sh.verbatim }, (err, out) => resolve(err ? undefined : String(out).trim() || undefined)))
}

// The MCP servers in the harnesses' own setup, and which are already connectors (same address).
async function foundMcps(): Promise<FoundMcp[]> {
  const env = { ...process.env, ...(await loginEnv()) }
  const have = new Set(connectors.list().map((c) => (c.kind === 'remote' ? `url:${(c.url ?? '').replace(/\/+$/, '')}` : `cmd:${[c.command, ...(c.args ?? [])].join(' ')}`)))
  return harnessMcps({}, env).map((m) => ({ ...m, added: have.has(m.key) }))
}

// Where a harness on a gateway sends its requests, and with which key, as its own config says.
async function gatewayTarget(engine: EngineId): Promise<{ baseUrl: string; key?: string } | undefined> {
  if (engine === 'claude') {
    const c = userProvider()
    const baseUrl = c.env['ANTHROPIC_BASE_URL']
    if (!baseUrl) return undefined
    return { baseUrl, key: c.env['ANTHROPIC_AUTH_TOKEN'] || c.env['ANTHROPIC_API_KEY'] || (c.apiKeyHelper ? await runHelper(c.apiKeyHelper) : undefined) }
  }
  if (engine !== 'codex') return undefined
  const x = userCodexProvider()
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
  toMain({ type: 'notify', title, body, conversationId, sound: settings().sounds !== false })
  void telegram?.notice(title, body)
}

// Asks the main process to do what only it can: open the browser or a folder, show a notification.
type ToMain =
  | { type: 'open'; url: string }
  | { type: 'open_path'; path: string }
  | { type: 'notify'; title: string; body: string; conversationId?: string; kind?: 'approval' | 'question' | 'done'; sound?: boolean }
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
  if (r?.type === 'icons-result') {
    iconWaits.get(r.id)?.((r.data ?? {}) as Record<string, string>)
    iconWaits.delete(r.id)
    return
  }
  if (r?.type !== 'screenshot-result') return
  const p = shots.get(r.id)
  shots.delete(r.id)
  if (r.error !== undefined) p?.reject(new Error(r.error))
  else p?.resolve(Buffer.from(String(r.data ?? ''), 'base64'))
})
// The apps' icons come from the main process (Electron's), a few seconds at most.
const iconWaits = new Map<string, (icons: Record<string, string>) => void>()
const appIcons = (paths: string[]): Promise<Record<string, string>> =>
  paths.length === 0 || serverMode || fake
    ? Promise.resolve({})
    : new Promise((resolve) => {
        const id = randomUUID()
        iconWaits.set(id, resolve)
        process.parentPort.postMessage({ type: 'icons', id, paths })
        setTimeout(() => iconWaits.has(id) && (iconWaits.delete(id), resolve({})), 8_000).unref()
      })

// The person's installed apps, with their icons, kept in the data folder: the apps picker
// shows them at once, even right after a restart, and a refresh runs behind it when they
// may have changed. Made once a few seconds after start, so even the first look is instant.
// bundleId: a Mac app's bundle id, a Windows app's AppUserModelID, a Linux desktop id.
type ShelfApp = { name: string; bundleId?: string; path?: string; icon?: string; exe?: string; exec?: string[]; chromium?: boolean }
// Each system's own list: the Mac's Applications folders, Windows' Start menu, Linux's application menu.
const systemApps = async (): Promise<ShelfApp[]> => {
  if (process.platform === 'darwin') return (await macApps().catch(() => [])).filter((a) => !SELF.test(a.bundleId ?? ''))
  const list: SystemApp[] = process.platform === 'win32' ? await windowsApps().catch(() => []) : linuxApps()
  return list.map(({ id, ...a }) => ({ ...a, ...(id ? { bundleId: id } : {}) }))
}
const shelfFile = join(dataDir, 'apps.json')
let shelf: { at: number; list: ShelfApp[] } | undefined = (() => {
  try {
    return JSON.parse(readFileSync(shelfFile, 'utf8')) as { at: number; list: ShelfApp[] }
  } catch {
    return undefined
  }
})()
let restocking: Promise<ShelfApp[]> | undefined
const restock = (): Promise<ShelfApp[]> =>
  (restocking ??= (async () => {
    const found = await systemApps()
    // The icons the system draws from a program (a Mac bundle, a Windows .exe) come from the
    // main process, once; Store apps and Linux's bring theirs.
    const known = new Map((shelf?.list ?? []).filter((a) => a.path && a.icon).map((a) => [a.path!, a.icon!]))
    const icons = await appIcons(found.filter((a) => a.path && !a.icon && !known.has(a.path)).map((a) => a.path!))
    const list = found
      .map((a) => {
        const icon = a.icon ?? (a.path ? (known.get(a.path) ?? icons[a.path]) : undefined)
        return { ...a, ...(icon ? { icon } : {}) }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    shelf = { at: Date.now(), list }
    try {
      writeFileSync(shelfFile, JSON.stringify(shelf))
    } catch {}
    return list
  })().finally(() => (restocking = undefined)))
const shelfNow = async (): Promise<ShelfApp[]> => {
  if (!shelf) return restock()
  if (Date.now() - shelf.at > 5 * 60_000) void restock()
  return shelf.list
}
if (!serverMode && !fake) setTimeout(() => void restock(), 4_000).unref()

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
// The person's own apps, through agent-desktop (none on a server: no screen there).
// Off a Mac it needs the installed apps to know each one's program.
const desktopApps = new DesktopApps(undefined, {
  installed: async () => (await shelfNow()).map(({ bundleId, ...a }) => ({ ...a, ...(bundleId ? { id: bundleId } : {}) }))
})

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
  runner: { runRoutine: (r, when) => runner.runRoutine(r, when), retryRoutine: (r, when, id) => runner.retryRoutine(r, when, id) },
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
  ...(serverMode ? {} : { apps: desktopApps }),
  routines,
  skills,
  models: () => availableModels(settings(), listed),
  // Approvals and questions reach the phone with their buttons, through toPhone; a finished reply stays on the Mac.
  notify: (title, body, conversationId, kind) => (kind ? toMain({ type: 'notify', title, body, conversationId, kind, sound: settings().sounds !== false }) : notifyAll(title, body, conversationId)),
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

  sendMessage: ({ conversationId, text, images }) => {
    void runner.send(conversationId, text, images)
  },

  stopRun: ({ messageId }) => runner.stop(messageId),

  retryRun: ({ messageId }) => runner.retry(messageId),

  continueRun: ({ messageId }) => void runner.continue(messageId),

  saveAgent: ({ agent, channelIds }) => {
    const before = db.agent(agent.id)
    // Archived changes only through archiveAgent, which also stops what the agent was doing.
    const clean: Agent = { ...cleanLook(agent), name: agent.name.trim(), handle: agent.handle.trim().toLowerCase(), archived: before?.archived ?? false }
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
  localSkills: () => findLocalSkills(),
  linkSkill: ({ source, agents }) => {
    if (!findLocalSkills().some((k) => k.source === source)) throw new Error(L('Essa skill não está mais no seu Claude Code nem no Codex.', "That skill is no longer in your Claude Code or Codex."))
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

  // The models a harness offers, besides the app's list for a plan: what OpenCode
  // and Pi list, or what the gateway in Claude Code's or Codex's config lists.
  engineModels: async ({ engine }) => {
    if (engine === 'codex' && codexCatalog.length)
      return { models: codexCatalog.map((m) => m.slug), labels: Object.fromEntries(codexCatalog.map((m) => [m.slug, { label: m.label, ...(m.description ? { hint: m.description } : {}) }])) }
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

  updateSettings: ({ patch: { jevKey: _computed, telegram: _phone, accounts: _own, ...patch } }) => {
    db.setSettings(patch)
    if (patch.paused !== undefined) runner.setPaused(patch.paused)
    if (patch.openAtLogin !== undefined) toMain({ type: 'login_item', open: patch.openAtLogin })
    if (patch.onboarding?.done) void ready.then(() => ensureTuca()) // skipping the introduction still gets the Tuca
    if (patch.language) toMain({ type: 'lang', lang: patch.language })
    emit({ type: 'settings', settings: settings() })
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
    void detect()
  },

  // Login always happens in the CLI's own flow; the app never sees credentials.
  // Codex logs into the app's own home (see codexEnv), separate from the user's.
  loginEngine: ({ engine }) => {
    // The sign-in happens in a terminal: check again until it lands, wherever the person is.
    watchEngine(engine, (s) => s.loggedIn)
    return openLogin(engine, engine === 'codex' ? { HOME: codexHome, CODEX_HOME: join(codexHome, '.codex') } : {})
  },

  // Another login of Claude Code or Codex: a folder of its own, signed into in a terminal like the first.
  addAccount: ({ engine, name }) => {
    const account: Account = { id: randomUUID().slice(0, 8), engine, name: name.trim() || ENGINES[engine].label }
    mkdirSync(join(accountDir(dataDir, account.id), '.codex'), { recursive: true })
    db.setSettings({ accounts: [...savedAccounts(), account] })
    void checkAccounts(account.id).then(() => emit({ type: 'settings', settings: settings() }))
    emit({ type: 'settings', settings: settings() })
    return account
  },
  loginAccount: ({ id }) => {
    const a = savedAccounts().find((x) => x.id === id)
    if (!a) return { opened: false, command: '' }
    const dir = accountDir(dataDir, a.id)
    watchAccount(a.id)
    return openLogin(a.engine, a.engine === 'claude' ? { CLAUDE_CONFIG_DIR: dir } : { HOME: dir, CODEX_HOME: join(dir, '.codex') })
  },
  // Its agents go back to the harness's usual login; the folder, with the login in it, goes away.
  removeAccount: ({ id }) => {
    db.setSettings({ accounts: savedAccounts().filter((a) => a.id !== id) })
    accountLogins.delete(id)
    for (const agent of db.agents().filter((x) => x.accountId === id || x.fallbackAccountId === id)) {
      const rest = { ...agent }
      if (rest.accountId === id) delete rest.accountId
      if (rest.fallbackAccountId === id) delete rest.fallbackAccountId
      db.saveAgent(rest)
      emit({ type: 'agent', agent: db.agent(agent.id)! })
    }
    rmSync(accountDir(dataDir, id), { recursive: true, force: true })
    emit({ type: 'settings', settings: settings() })
  },

  // The harness's own installer, in a terminal the person sees: its progress, its
  // questions and its errors stay theirs. Detection picks the CLI up once it lands.
  installEngine: ({ engine }) => {
    const r = installer((isWin && ENGINES[engine].windows) || ENGINES[engine].install)
    // It installs in a terminal: check again until it lands, wherever the person is.
    if (r.opened) watchEngine(engine, (st) => st.installed)
    return r
  },

  // The person's apps (agent-desktop): whether it's there and allowed, and what's open.
  desktopStatus: async () => (serverMode ? { installed: false, server: true } : desktopApps.status()),
  // The installed apps come from a shelf kept on disk (instant, refreshed behind); the open
  // ones are asked each time, apart, so the list never waits for them.
  installedApps: async () => (serverMode ? [] : shelfNow()),
  openApps: async () => (serverMode ? [] : desktopApps.foreground().catch(() => [])),
  installDesktop: () => installer('npm install -g agent-desktop@1.0.2'), // the version the apps feature is tested with
  desktopPermissions: () => {
    // Opens the system's privacy settings at Accessibility (agent-desktop knows where).
    void desktopApps.guide()
  }
}

// An installer in a terminal the person sees: its progress, its questions and its
// errors stay theirs. Detection picks the program up once it lands.
function installer(command: string): { opened: boolean; command: string; needsNode?: boolean } {
  // An npm package needs Node.js first; without it the command would only fail.
  if (/^npm\s/.test(command) && !findOnPath('npm')) return { opened: false, command, needsNode: true }
  if (isWin) {
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
