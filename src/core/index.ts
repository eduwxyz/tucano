// The core runs in an Electron utility process: database, engines and runs
// live here so the window never waits on agent work. The renderer talks to it
// over a MessagePort handed out by the main process.
import { voiceRefusal } from '../shared/voice'
import { ModelDownload, Transcriber, VOICE_MODELS, voiceStatus, warmUp } from './transcribe'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { isLimited, localUrl, resolveLocal, type LocalReach } from './local-paths'
import { basename, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MessagePortMain } from 'electron'
import { L, langOf, locale, setLang, type Lang } from '../shared/lang'
import { errorFor } from '../shared/errors'
import type { Api, CoreEvent, Method, Params, Request, Wire } from '../shared/rpc'
import { limitError, paramsError } from '../shared/rpc-shapes'
import { ACCOUNT_ENGINES, applyOrder, artifactUrl, proposalsOf, type Proposal, type ProposalsResult, channelName, ENGINES, inQuietHours, modelInfo, personScope, rememberModels, scopePerson, usable, WEBHOOK_PORT, type Account, type AccountEngine, type Agent, type BrowserReply, type Message, type EngineId, type EngineStatus, type Person, type Routine, type Settings, type WikiChange, type WikiSource } from '../shared/types'
import { noticeOf, type NoticeArea, type NoticePicture } from '../shared/notice'
import { agentOwner, channelEditError, cleanName, dmOwner, Hub, MAX_NAME, mayEditChannel, nameLongError, nameTakenError, People, routineDetail, stripInvisible, type Purged } from './people'
import { adminError, admit, admitComputer, can, isAdmin, must } from './policy-people'
import { cleanRules, isAutonomy } from '../shared/actions'
import { possibleBosses } from '../shared/org'
import { listModels, quietClaude, quietCodex, withChoice } from './harness'
import { cleanLook } from './agent-look'
import { Db, MIGRATIONS } from './db'
import { claudeEngine, userProvider } from './engines/claude'
import { codexEngine, userCodexProvider } from './engines/codex'
import { opencodeEngine } from './engines/opencode'
import { piEngine } from './engines/pi'
import { antigravityAppDir, antigravityEngine } from './engines/antigravity'
import { cursorAppDir, cursorEngine } from './engines/cursor'
import { grokEngine } from './engines/grok'
import { clineAppDir, clineEngine, clineLoginDir, clineLoginEnv } from './engines/cline'
import { hermesAppDir, hermesEngine } from './engines/hermes'
import { accountDir, accountStatus, adoptLoginShellPath, detectEngines } from './engines/detect'
import { detectEngine, EngineCheck, type EngineFindings } from './engine-check'
import { EngineSetup, SETUP_ENGINES, type SetupEngine, type SetupState } from './engine-setup'
import { asdfEnv, codexEnv } from './engines/codex'
import { CATALOG, CATEGORIES, catalogInput, catalogView, entryOf, ownAppGuide } from '../shared/connector-catalog'
import { LoginTerminal, type LoginKey } from './login-terminal'
import { Push, pushUrl } from './push'
import { fakeEngine } from './engines/fake'
import { relocating } from './engines/relocate'
import { DesktopApps, macApps, SELF } from './apps'
import { linuxApps, windowsApps, type SystemApp } from './apps-os'
import type { Engine } from './engines/types'
import { ConnectorManager, notAuthorized } from './connectors'
import { harnessMcps, publicMcp, type FoundMcp } from './harness-mcp'
import { Gateway } from './gateway'
import { createServer } from 'node:http'
import { checkJevKey, JEV_MODEL, JEV_SECRET } from './jev'
import { report } from './report'
import { usage } from './usage'
import { Skills } from './skills'
import { cleanTitle, pageKey, Wiki, type WikiView } from './wiki'
import { COPY_SUFFIX, WikiGit } from './wiki-git'
import { settingsPatchError } from './settings-patch'
import { WikiCurator } from './wiki-curator'
import { WikiReviewer } from './wiki-review'
import { extractFile, extractLink } from './wiki-extract'
import { backup, backupIfDue, exportTeam, importTeam } from './team'
import { cancelRestore, finishRestore, markRestoreReady, stageRestore, writeBackup } from './restore'
import { applyForeignTeam, readForeignZip } from './agent-import'
import { extractZip, zipFromBuffer, zipFromFile } from './zip'
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
import { agentFromDraft, availableModels, tucaAgent, tucaHello, tucaUpToDate } from './tuca'
import { initializeWorkspace } from './seed'
import { workspacePorts } from './ports'
import { isTheme, workspaceLabel, workspaceParts } from '../shared/workspaces'
import { isNewQuestion } from '../shared/questions'
import { companyNetwork } from './network'

// Before any request: the system's certificates and proxy, for networks that inspect HTTPS (src/core/network.ts).
companyNetwork()

const dataDir = process.env['TUCANO_DATA'] ?? join(process.cwd(), '.tucano')
const fake = process.env['TUCANO_FAKE_ENGINES'] === '1'
// Run by the server (src/server): no window, and the screens are in a browser elsewhere.
const serverMode = process.env['TUCANO_SERVER'] === '1'
const publicUrl = process.env['TUCANO_URL']?.replace(/\/+$/, '')
const runtimePorts = workspacePorts()
const defaultWorkspace = process.env['TUCANO_DEFAULT_WORKSPACE'] !== '0'
mkdirSync(dataDir, { recursive: true })

const db = new Db(join(dataDir, 'tucano.db'))
// This app's version: the desktop says it; a server reads its package.json.
const appVersion = process.env['TUCANO_VERSION'] || (() => {
  try {
    return String((JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '')
  } catch {
    return ''
  }
})()
// A backup restored at this start (src/server applied it): what only worked on the other computer goes.
const restored = finishRestore(db, dataDir)
if (restored !== undefined) console.log(`[core] a backup was restored; ${restored} routine(s) left off`)
const codexHome = join(dataDir, 'codex-home')
mkdirSync(join(codexHome, '.codex'), { recursive: true })
// Cline's own login for the app (see cline.ts), and where its turns run.
const clineDir = clineAppDir(dataDir)
const clineLogin = clineLoginDir(clineDir)
// Until the settings are read, the language of a new install: the Mac's.
setLang(langOf(process.env['TUCANO_LOCALE']))
initializeWorkspace(db)
// A workspace made from the switcher starts with the name it was given there.
if (db.created && process.env['TUCANO_WORKSPACE_LABEL']) db.setSettings({ workspaceLabel: process.env['TUCANO_WORKSPACE_LABEL'] })
const appTheme = process.env['TUCANO_THEME']
if (!serverMode && isTheme(appTheme)) db.setSettings({ theme: appTheme })
// A new install has nothing new to show: the news start with the next update.
if (db.created && process.env['TUCANO_VERSION']) db.setSettings({ seenVersion: process.env['TUCANO_VERSION'] })
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

// The owner is a person like any other, named after the settings' name (what the agents call them):
// a new install fills it in, and a name changed in the settings changes theirs.
const people = new People(db)
if (!db.owner().name) db.renamePerson(db.ownerId(), db.getSettings(DEFAULTS).workspaceName, false)

const fakeStatus = (v: string): EngineStatus => ({ installed: true, loggedIn: true, path: 'fake', version: v, account: L('Motor de teste', 'Test engine'), route: 'plan' })
// TUCANO_FAKE_NO_AI: a computer with nothing set up yet, until the introduction's setup "signs in" (no network).
const fakeNoAi = fake && process.env['TUCANO_FAKE_NO_AI'] === '1'
const fakeSignedIn = new Set<EngineId>()
const fakeOne = (e: EngineId, s: EngineStatus): EngineStatus => (fakeNoAi && !fakeSignedIn.has(e) ? { installed: false, loggedIn: false } : s)
// TUCANO_FAKE_BROKEN_PI: Pi found signed in to Anthropic, whose login then fails every reply (an expired refresh token).
// TUCANO_FAKE_BROKEN_OPENCODE: OpenCode, found, fails every reply with an error nobody wrote for people.
const fakeBrokenPi = fake && process.env['TUCANO_FAKE_BROKEN_PI'] === '1'
const fakeBrokenOpencode = fake && process.env['TUCANO_FAKE_BROKEN_OPENCODE'] === '1'
const OPENCODE_CRASH = "TypeError: Cannot read properties of undefined (reading 'providers')\n    at loadConfig (file:///opt/homebrew/lib/node_modules/opencode-ai/dist/config.js:212:30)\n    at async main (file:///opt/homebrew/lib/node_modules/opencode-ai/dist/index.js:18:3)"
const PI_EXPIRED = 'OAuth refresh failed for anthropic: 400 {"type":"error","error":{"type":"invalid_grant","message":"Refresh token expired"}}\n    at postJson (file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/auth/oauth.js:88:11)\n    at async refreshAnthropic (file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/auth/anthropic.js:41:5)\n    at async getAuth (file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/auth/index.js:23:12)'
const fakeFindings = (): Omit<EngineFindings, 'accounts'> => ({
  engines: { claude: fakeOne('claude', fakeStatus('0.0.0')), codex: fakeOne('codex', fakeStatus('0.0.0')), opencode: fakeOne('opencode', { ...fakeStatus('0.0.0'), route: 'providers', account: 'OpenAI, OpenCode · 3 modelos' }), pi: fakeBrokenPi ? { ...fakeStatus('0.0.0'), route: 'providers', account: 'Anthropic · 1 modelo' } : { installed: false, loggedIn: false }, antigravity: { installed: false, loggedIn: false }, cursor: { installed: false, loggedIn: false }, grok: { installed: false, loggedIn: false }, cline: { installed: false, loggedIn: false }, hermes: { installed: false, loggedIn: false } },
  listed: { opencode: ['openai/gpt-5.5', 'opencode/big-pickle', 'opencode-go/qwen3.8-max'], ...(fakeBrokenPi ? { pi: ['anthropic/claude-haiku-4-5'] } : {}) },
  codexCatalog: []
})
// The harnesses' last check, kept in the data folder: the window opens on it while the next runs.
const engineCheck = new EngineCheck({
  file: join(dataDir, 'engines.json'),
  all: async () => (fake ? fakeFindings() : detectEngines(codexHome, clineLogin)),
  one: async (e) => (fake ? { status: fakeFindings().engines[e], listed: fakeFindings().listed[e] } : detectEngine(e, codexHome, clineLogin)),
  after: async (found, engine) => {
    ;({ engines, listed, codexCatalog } = found)
    await checkAccounts(undefined, engine)
    rememberModels(codexCatalog.map((m) => ({ id: m.slug, engine: 'codex', label: m.label, hint: m.description ?? '' })))
    gatewayLists.clear()
    emit({ type: 'settings', settings: settings() })
    return { accounts: Object.fromEntries(accountLogins) }
  }
})
// The models OpenCode and Pi list (what the person has logins for), and Codex's own catalog for
// this login (names and what each model is for), from the last check.
let { engines, listed, codexCatalog } = engineCheck.current
// Everything checked again; a call while a check runs gets that one.
const detect = (): Promise<unknown> => engineCheck.detect().catch((e: unknown) => console.error('[engines]', e))
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
// Only that harness is checked, not all of them.
let watching: ReturnType<typeof setInterval> | undefined
let watched: EngineId | undefined
function watchEngine(engine: EngineId, done: (s: EngineStatus) => boolean): void {
  if (watching) clearInterval(watching)
  const until = Date.now() + 10 * 60_000
  const stop = (): void => (clearInterval(watching), (watched = undefined))
  watched = engine
  watching = setInterval(() => {
    if (done(engines[engine]) || Date.now() > until) return stop()
    void engineCheck.recheck(engine).catch((e: unknown) => console.error('[engines]', e))
  }, 4_000)
  watching.unref()
}

// Codex and Claude Code set up from the introduction, with no terminal (engine-setup.ts).
const engineSetup = new EngineSetup({
  dir: join(dataDir, 'engines'),
  os: osOf(),
  arch: process.arch,
  musl: () => existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1'),
  fetch: (...a) => fetch(...a),
  untar: (archive, into) => new Promise((done, fail) => execFile('tar', ['-xzf', archive, '-C', into], { windowsHide: true }, (e) => (e ? fail(e) : done()))),
  spawn: (bin, args, env) => {
    // stdin stays open and unused: the sign-in finishes on the CLI's own callback, never on a pasted code.
    const p = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const exit = new Promise<number>((done) => {
      p.on('error', () => done(1))
      p.on('exit', (code) => done(code ?? 1))
    })
    return { output: (on) => (p.stdout.on('data', (b: Buffer) => on(b.toString())), p.stderr.on('data', (b: Buffer) => on(b.toString()))), exit, kill: () => p.kill() }
  },
  status: (e) => engines[e],
  recheck: async (e) => (await engineCheck.recheck(e)).engines[e],
  env: (e) => (e === 'codex' ? codexEnv(codexHome) : { ...process.env, DISABLE_AUTOUPDATER: '1' }),
  changed: () => {}
})

// A harness's sign-in from the page or the phone, on a server: its login command in a terminal of the
// server's, the screen shown where the person is (login-terminal.ts). Linux only, through `script`;
// elsewhere the command is shown, to run in a terminal as before.
const loginTerminal = new LoginTerminal({
  spawn: (bin, args, env, size) => {
    if (!serverMode || osOf() !== 'linux' || !onPath('script')) return undefined
    const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
    const line = `stty cols ${size.cols} rows ${size.rows} 2>/dev/null; exec ${[bin, ...args].map(q).join(' ')}`
    const p = spawn('script', ['-qfec', line, '/dev/null'], { env: { ...env, TERM: 'xterm-256color', COLUMNS: String(size.cols), LINES: String(size.rows) }, stdio: ['pipe', 'pipe', 'pipe'] })
    const exit = new Promise<number>((done) => {
      p.on('error', () => done(1))
      p.on('exit', (code) => done(code ?? 1))
    })
    p.stdin.on('error', () => {})
    return {
      write: (data) => void p.stdin.write(data),
      output: (on) => (p.stdout.on('data', (b: Buffer) => on(b.toString())), p.stderr.on('data', (b: Buffer) => on(b.toString()))),
      exit,
      kill: () => void p.kill()
    }
  },
  bin: (e) => engines[e].path ?? ENGINES[e].cli,
  env: (e, account) => {
    if (account) {
      const dir = accountDir(dataDir, account)
      return e === 'claude' ? { ...process.env, CLAUDE_CONFIG_DIR: dir, DISABLE_AUTOUPDATER: '1' } : codexEnv(dir, engines.codex.path)
    }
    return e === 'codex' ? codexEnv(codexHome, engines.codex.path) : e === 'cline' ? { ...process.env, ...clineLoginEnv(clineLogin) } : { ...process.env, DISABLE_AUTOUPDATER: '1' }
  },
  signedIn: async (e, account) => {
    if (!account) return (await engineCheck.recheck(e)).engines[e].loggedIn
    await checkAccounts(account)
    engineCheck.setAccounts(Object.fromEntries(accountLogins))
    emit({ type: 'settings', settings: settings() })
    return accountLogins.get(account)?.loggedIn === true
  }
})

// The same steps with the test engines: no network, no CLI; the harness is "signed in" at the end.
function fakeSetup(engine: SetupEngine): SetupState {
  if (fakeSetupState?.state === 'running') return fakeSetupState
  const at = (s: SetupState, ms: number): void => void setTimeout(() => fakeSetupState?.state === 'running' && (fakeSetupState = s), ms)
  fakeSetupState = { engine, step: 'install', state: 'running', progress: 0 }
  at({ engine, step: 'install', state: 'running', progress: 0.45 }, 700)
  at({ engine, step: 'login', state: 'running', url: 'https://example.invalid/login' }, 1500)
  setTimeout(() => {
    if (fakeSetupState?.state !== 'running') return
    fakeSignedIn.add(engine)
    void engineCheck.recheck(engine).then(() => (fakeSetupState = { engine, step: 'login', state: 'done' }))
  }, 3200)
  return fakeSetupState
}
let fakeSetupState: SetupState | null = null

const gateway = new Gateway()
// The login shell's PATH comes before any CLI starts: harnesses, connectors and Docker are found on it.
// Then the CLIs the introduction installed, after the person's own.
const pathReady = fake ? Promise.resolve() : adoptLoginShellPath().catch((e: unknown) => console.error('[path]', e)).then(() => void (process.env['PATH'] = engineSetup.withDirs(process.env['PATH'] ?? '')))
// The harnesses are checked behind the window (it opens on the last check). What truly needs
// them (a reply, the memory, routines, a connection test) waits for this.
const enginesReady = pathReady.then(detect)
// The window waits only for the database, open by now, and the gateway.
const ready = gateway.start()

const settings = (): Settings => {
  const s = db.getSettings(DEFAULTS)
  setLang(s.language)
  return { ...s, engines: withChoice(engines, s.harnesses), jevKey: db.getSecret(JEV_SECRET) !== undefined, telegram: telegram?.info(), accounts: (s.accounts ?? []).map((a) => ({ ...a, ...accountLogins.get(a.id) })) }
}

// More logins of Claude Code and Codex (Settings › Accounts): each in its own folder, checked with
// the CLI's own status when the harnesses are, and every few seconds after a sign-in.
const accountLogins = new Map<string, { loggedIn: boolean; detail?: string }>(Object.entries(engineCheck.current.accounts ?? {}))
const savedAccounts = (): Account[] => (db.getSettings(DEFAULTS).accounts ?? []).map(({ id, engine, name }) => ({ id, engine, name }))
// `only`: that account; `engine`: that harness's accounts.
async function checkAccounts(only?: string, engine?: EngineId): Promise<void> {
  await Promise.all(
    savedAccounts()
      .filter((a) => (!only || a.id === only) && (!engine || a.engine === engine))
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
    void checkAccounts(id).then(() => {
      engineCheck.setAccounts(Object.fromEntries(accountLogins))
      emit({ type: 'settings', settings: settings() })
    })
  }, 4_000)
  watchingAccount.unref()
}


// The Codex subscription's windows, read again when the usage page asks (it does when it opens and
// after each reply), at most once a minute, and only for a login on a ChatGPT plan.
let codexQuotaAt = 0
function refreshCodexQuota(): void {
  const s = engines.codex
  if (!s.loggedIn || s.route !== 'plan' || Date.now() - codexQuotaAt < 60_000) return
  codexQuotaAt = Date.now()
  void engineImpls.codex.planUsage?.().then((codexQuota) => {
    if (!codexQuota) return
    db.setSettings({ codexQuota })
    emit({ type: 'settings', settings: settings() })
  }, () => {})
}

// A harness that moved since it was found (an update to another folder) is looked for again.
function moved(id: EngineId): Parameters<typeof relocating>[1] {
  return { path: () => engines[id].path, label: ENGINES[id].label, redetect: () => detect().then(() => undefined) }
}

const engineImpls: Record<EngineId, Engine> = fake
  ? { claude: fakeEngine('claude'), codex: fakeEngine('codex'), opencode: fakeBrokenOpencode ? { ...fakeEngine('opencode'), async *run() { yield { type: 'error' as const, message: OPENCODE_CRASH } } } : fakeEngine('opencode'), pi: fakeBrokenPi ? { ...fakeEngine('pi'), async *run() { yield { type: 'error' as const, message: PI_EXPIRED } } } : fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
  : {
      claude: relocating(claudeEngine(() => engines.claude.path, async () => quietClaude(userProvider())), moved('claude')),
      codex: relocating(codexEngine(() => engines.codex.path, codexHome, loginEnv, async () => quietCodex(userCodexProvider())), moved('codex')),
      opencode: relocating(opencodeEngine(() => engines.opencode.path, join(dataDir, 'opencode-home'), loginEnv, () => engines.opencode.version), moved('opencode')),
      pi: relocating(piEngine(() => engines.pi.path, join(dataDir, 'pi'), loginEnv), moved('pi')),
      antigravity: relocating(antigravityEngine(() => engines.antigravity.path, antigravityAppDir(dataDir), loginEnv), moved('antigravity')),
      cursor: relocating(cursorEngine(() => engines.cursor.path, cursorAppDir(dataDir), loginEnv), moved('cursor')),
      grok: relocating(grokEngine(() => engines.grok.path, loginEnv), moved('grok')),
      cline: relocating(clineEngine(() => engines.cline.path, clineDir, loginEnv), moved('cline')),
      hermes: relocating(hermesEngine(() => engines.hermes.path, hermesAppDir(), loginEnv), moved('hermes'))
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

// Each port is a person's (a desktop's one window is the owner's); events go through what each may see.
const hub = new Hub<MessagePortMain>(people, db)
// The conversation each person has open: what arrives there is read already.
const viewing = new Map<string, string | null>()
let closing = false
type Ctx = { person: Person; device?: string } // device: the hash of the key a server's page signed in with
const ownerCtx = (): Ctx => ({ person: db.owner() })
// What the workspace switcher shows of this workspace: its name, whether it's paused, and two
// counts. Coalesced: a reply streaming updates its message many times a second.
let summaryTimer: NodeJS.Timeout | undefined
let lastSummary = ''
function workspaceSummary(): void {
  summaryTimer ??= setTimeout(() => {
    summaryTimer = undefined
    const current = db.getSettings(DEFAULTS)
    // The owner's counts: the switcher is on the desktop, the owner's app.
    const owner = db.owner()
    const unread = db.conversations(owner.id).filter((c) => people.canSeeConversation(owner, c)).reduce((n, c) => n + (c.unread ?? 0), 0)
    const summary = { type: 'workspace-summary', name: workspaceLabel(current), paused: !!current.paused, unread, approvals: db.pendingApprovals() }
    const wire = JSON.stringify(summary)
    if (wire !== lastSummary) process.parentPort.postMessage(summary)
    lastSummary = wire
  }, 250)
}
function emit(event: CoreEvent): void {
  const more = event.type === 'message' && db.recordActivity(event.message, viewing)
  hub.emit(event)
  // An approval asked or decided changes what waits on its deciders.
  if (event.type === 'approval') hub.emit({ type: 'inbox' })
  toPhone(event)
  // A new unread one: the sidebar's count goes up (each person's own).
  const conversation = more ? db.conversation(event.message.conversationId) : undefined
  if (conversation) hub.emit({ type: 'conversation', conversation })
  if (['message', 'conversation', 'conversation_removed', 'approval', 'settings'].includes(event.type)) workspaceSummary()
}

// The phone gets each new approval and question as it happens (spec §19).
let telegram: Telegram | undefined
const sentToPhone = new Set<string>()
function toPhone(e: CoreEvent): void {
  // The phone is the owner's: only what the owner may see reaches it.
  if (!telegram || (e.type !== 'approval' && e.type !== 'message') || !people.eventFor(e, db.owner())) return
  const name = (id: string): string => db.agent(id)?.name ?? L('Um agente', 'An agent')
  if (e.type === 'approval' && e.approval.state === 'pending' && !sentToPhone.has(e.approval.id)) {
    sentToPhone.add(e.approval.id)
    void telegram.approvalAsked(e.approval, name(e.approval.agentId))
  } else if (e.type === 'message' && e.message.author.kind === 'agent' && isNewQuestion(e.message) && !sentToPhone.has(e.message.id) && forOwner(e.message.id)) {
    sentToPhone.add(e.message.id)
    const conv = db.conversation(e.message.conversationId)
    void telegram.questionAsked(e.message, name(e.message.author.id), conv?.kind === 'channel' ? `#${conv.name}` : L('na DM', 'in the DM'))
  }
}

// A question the owner answers: theirs (or one from before questions were kept).
const forOwner = (messageId: string): boolean => {
  const q = db.question(messageId)
  return !q || (q.confirm === 'pending' ? q.requestedBy : q.askedTo) === db.ownerId()
}

// The phones that gave this Tucano a push handle get the same notification while the app is closed.
// The test engines never reach the relay.
const push = new Push({
  url: fake ? undefined : pushUrl(),
  targets: (to) => db.pushTargets(to),
  gone: (hash) => db.dropKeyPush(hash)
})

// Desktop notification, and the same on the phone.
// `fullText`: the whole reply, for the phone; `page`: a click opens that screen instead of a conversation.
// `to`: the people it's for; unset, everyone (but a DM's news only ever reaches its person).
// `messageId`: the reply it's about, for the pictures the card over the window shows.
const noticePictures = (messageId: string): NoticePicture[] =>
  db
    .artifactsOf(messageId)
    .slice(0, 4)
    .map((a) => ({ url: artifactUrl(a), title: a.title || a.name, kind: a.kind }))
const notifyAll = (title: string, shortText: string, conversationId?: string, fullText?: string, more: { kind?: 'approval'; page?: 'skills'; threadId?: string; to?: string[]; messageId?: string } = {}): void => {
  const to = notifyTo(conversationId, more.to)
  const pictures = more.messageId ? noticePictures(more.messageId) : []
  toMain({ type: 'notify', title, body: shortText, conversationId, ...more, ...(to ? { to } : {}), ...(pictures.length ? { pictures } : {}), sound: settings().sounds !== false })
  void push.send({ title, body: shortText, ...(conversationId ? { conversationId } : {}), ...(more.threadId ? { threadId: more.threadId } : {}), ...(more.kind ? { kind: more.kind } : {}) }, to)
  if (!to || to.includes(db.ownerId())) void telegram?.notice(title, fullText ?? shortText)
}
// Whether the cards go over every window instead of the system's own notification (Settings).
const noticePrefs = (): { on: boolean; area?: NoticeArea } => {
  const rules = noticeOf(settings())
  return { on: rules.on, ...(rules.area ? { area: rules.area } : {}) }
}
function notifyTo(conversationId: string | undefined, to: string[] | undefined): string[] | undefined {
  const c = conversationId ? db.conversationOwner(conversationId) : undefined
  const dm = c && dmOwner(c, db.ownerId())
  return dm ? (to ?? [dm]) : to
}

// Asks the main process to do what only it can: open the browser or a folder, show a notification.
type ToMain =
  | { type: 'theme'; theme: Settings['theme']; initial?: boolean }
  | { type: 'ready' }
  | { type: 'open'; url: string }
  | { type: 'open_path'; path: string }
  | { type: 'open_local'; path: string; how: 'open' | 'reveal' }
  | { type: 'wiki_dir'; path: string } // the wiki's folder, which the app may open
  | { type: 'restart' } // a server: start again, to restore a backup (src/server)
  | { type: 'notify'; title: string; body: string; conversationId?: string; threadId?: string; kind?: 'approval' | 'question' | 'done'; page?: 'skills'; sound?: boolean; to?: string[]; messageId?: string; pictures?: NoticePicture[] } // to: the people it's for (a server delivers it only to them); unset: everyone
  | { type: 'notice-pref'; on: boolean; area?: NoticeArea } // the cards over every window (src/main/notice.ts), as the settings say now
  | { type: 'auth-result'; id: string; person?: Person; removed?: true } // removed: a key of someone removed since
  | { type: 'join-result'; id: string; data: { key?: string; person?: Person; error?: string } }
  | { type: 'device-key-result'; id: string; data: { key?: string; person?: Person } }
  | { type: 'person-removed'; id: string }
  | { type: 'person-changed'; id: string } // a role changed: the server forgets what it remembered of them
  | { type: 'login_item'; open: boolean }
  | { type: 'busy'; busy: boolean }
  | { type: 'lang'; lang: Lang }
const toMain = (msg: ToMain): void =>
  process.parentPort.postMessage(msg)
// The menu is the main process's: it follows the language picked here.
toMain({ type: 'lang', lang: db.getSettings(DEFAULTS).language })
if (!serverMode && defaultWorkspace) toMain({ type: 'theme', theme: db.getSettings(DEFAULTS).theme, initial: true })

// Screenshots use Electron's Chromium, which lives in the main process.
const shots = new Map<string, { resolve: (b: Buffer) => void; reject: (e: Error) => void }>()
// Agents' browsers too (spec §24).
const pages = new Map<string, { resolve: (r: BrowserReply) => void; reject: (e: Error) => void }>()
process.parentPort.on('message', (e) => {
  const r = e.data as { type?: string; id: string; data?: unknown; error?: string; awake?: boolean; agentId?: string; shown?: boolean; conversationId?: string | null; targetDir?: string; name?: string; theme?: unknown; paused?: unknown; parts?: unknown; path?: unknown; person?: unknown; key?: unknown; code?: unknown; label?: unknown; artifact?: unknown; port?: unknown } | undefined
  if (r?.type === 'workspace-pause') {
    try {
      if (closing || typeof r.paused !== 'boolean') throw new Error('Workspace cannot change pause state right now')
      api.updateSettings({ patch: { paused: r.paused } }, ownerCtx())
      process.parentPort.postMessage({ type: 'workspace-paused' })
    } catch (error) {
      process.parentPort.postMessage({ type: 'workspace-paused', error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (r?.type === 'workspace-theme' && isTheme(r.theme)) {
    db.setSettings({ theme: r.theme })
    emit({ type: 'settings', settings: settings() })
    return
  }
  if (r?.type === 'duplicate-workspace') {
    try {
      if (closing || !r.targetDir || !r.name) throw new Error('Workspace cannot be duplicated right now')
      mkdirSync(r.targetDir, { recursive: true, mode: 0o700 })
      db.duplicateTo(join(r.targetDir, 'tucano.db'), r.name, r.parts === undefined ? undefined : workspaceParts(r.parts), wiki.dir)
      process.parentPort.postMessage({ type: 'workspace-duplicated' })
    } catch (error) {
      process.parentPort.postMessage({ type: 'workspace-duplicated', error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  // The workspace whose folder held this wiki is being deleted: the folder moved here.
  if (r?.type === 'wiki-relocate') {
    void Promise.resolve()
      .then(() => api.setWikiDir({ dir: typeof r.path === 'string' ? r.path : '' }, ownerCtx()))
      .then(
        () => process.parentPort.postMessage({ type: 'wiki-relocated' }),
        (e: unknown) => process.parentPort.postMessage({ type: 'wiki-relocated', error: e instanceof Error ? e.message : String(e) })
      )
    return
  }
  if (r?.type === 'delete-workspace') {
    if (closing) return
    closing = true
    routines.stop()
    telegram?.stop()
    hooks.close()
    runner.stopAll()
    void (async () => {
      await runner.idle()
      await memory.idle()
      await runner.settled() // a Claude Code process writes its session's last prompt on its way out
      runner.cleanTranscripts()
      const agents = db.agents()
      for (const a of agents) if (a.computer) await computers.erase(a.id)
      chrome?.quit()
      process.parentPort.postMessage({ type: 'workspace-cleaned', agentIds: agents.map((a) => a.id) })
    })().catch((e: unknown) => process.parentPort.postMessage({ type: 'workspace-cleaned', error: e instanceof Error ? e.message : String(e) }))
    return
  }
  // The desktop says which conversation its window shows: the owner's (a person may be named).
  if (r?.type === 'viewing') {
    const who = typeof r.person === 'string' ? db.person(r.person) : db.owner()
    if (!who) return
    const open = typeof r.conversationId === 'string' && people.canSeeConversation(who, db.conversation(r.conversationId)) ? r.conversationId : null
    viewing.set(who.id, open)
    if (open) { db.markRead(open, who.id); emitConversations([open]) }
    workspaceSummary()
    return
  }
  // A server's sign-in: the person a key opens (src/server keeps the answer a few seconds).
  if (r?.type === 'auth') {
    const person = people.authenticate(r.key)
    return toMain({ type: 'auth-result', id: r.id, ...(person ? { person } : people.removedKey(r.key) ? { removed: true } : {}) })
  }
  // A server's file or page: may this person see it? An artifact is its conversation's; an agent's
  // page, the conversation whose reply started its service (one started by hand: everyone's).
  if (r?.type === 'access') {
    const who = typeof r.person === 'string' ? db.person(r.person) : undefined
    const a = typeof r.artifact === 'string' ? db.artifacts().find((x) => x.id === r.artifact) : undefined
    const svc = typeof r.port === 'number' ? db.agents().flatMap((x) => computers.info(x).services).find((x) => x.url && Number(new URL(x.url).port) === r.port) : undefined
    const ok = !!who && (a ? people.canSeeFrom(who, a.conversationId) : svc ? people.canSeeFrom(who, svc.conversationId) : false)
    return process.parentPort.postMessage({ type: 'access-result', id: r.id, ok })
  }
  // A server's invite page: the name of whom a restoring invite brings back, to fill in.
  if (r?.type === 'invite-info') {
    const name = people.inviteName(r.code)
    return process.parentPort.postMessage({ type: 'invite-info-result', id: r.id, data: name ? { name } : {} })
  }
  // A server's /join: an invite's code and a name become a person with a key.
  if (r?.type === 'join') {
    const out = people.join(r.code, r.name)
    if ('person' in out) {
      inherit()
      emitPeople()
      if (out.routines) routines.resume(out.routines)
    }
    return toMain({ type: 'join-result', id: r.id, data: 'person' in out ? { person: out.person, key: out.key } : out })
  }
  // A server's POST /pair: a one-time code it checked, spent for this person (none: the owner), becomes a key of a device's own.
  if (r?.type === 'device-key') {
    const out = people.deviceKey(r.person, r.label)
    if (out) emitPeople()
    return toMain({ type: 'device-key-result', id: r.id, data: out ?? {} })
  }
  if (r?.type === 'power') return routines.setAwake(r.awake === true)
  // A server's /oauth/callback: the code the provider sent back, checked against the state only this core made.
  if (r?.type === 'oauth-callback') {
    const { state = '', code = '', error = '' } = (r.data ?? {}) as { state?: string; code?: string; error?: string }
    const reply = (ok: boolean, why?: string): void => process.parentPort.postMessage({ type: 'oauth-result', id: r.id, data: { ok, why } })
    if (!code) return reply(false, error === 'access_denied' ? L('Você recusou o acesso na página do serviço.', 'You declined access on the service’s page.') : L('A autorização não voltou com o código.', 'The authorization came back without a code.'))
    void connectors.finishOAuth(state, code).then(
      (ok) => reply(ok, ok ? undefined : L('Esse pedido de autorização venceu. Tente de novo pelo app.', 'That authorization request expired. Try again from the app.')),
      (e: unknown) => reply(false, e instanceof Error ? e.message : String(e))
    )
    return
  }
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
// may have changed. Made at start only when the kept one is a day old: a scan starts a hundred
// processes, so it waits for the harnesses' check to end too.
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
if (!serverMode && !fake && (!shelf || Date.now() - shelf.at > 24 * 3600_000)) void enginesReady.then(() => setTimeout(() => void restock(), 5_000).unref())

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
        serverMode,
        serverMode ? 10 * 60_000 : undefined // on a server, an idle agent's Chrome gives its memory back
      )
    : undefined
const host: BrowserHost = chrome ? (agentId, op, args) => chrome.run(agentId, op, args) : electronHost

const transcriber = new Transcriber()
// Dictation's places: the whisper-cli inside the app, and the folder for the models it downloads.
const voicePlaces = { ...(process.env['TUCANO_WHISPER'] ? { bundled: process.env['TUCANO_WHISPER'] } : {}), models: join(dataDir, 'voice') }
const modelDownload = new ModelDownload(voicePlaces.models, () => emit({ type: 'voice' }), fetch, undefined, () => void dictation().then((s) => warmUp(transcriber, s)))
const dictation = async () => {
  const s = voiceStatus(settings().voice, await loginEnv(), undefined, voicePlaces)
  return { ...s, ...(modelDownload.progress ? { downloading: modelDownload.progress } : {}), ...(modelDownload.error ? { error: modelDownload.error } : {}) }
}
// Out of the environment before anything starts: commands the agents run inherit it.
const localKey = process.env['TUCANO_LOCAL_KEY']
delete process.env['TUCANO_LOCAL_KEY']

// What the author of a message reaches, for the paths it cites. An agent on this Mac reaches what
// its commands do; any other, only its own files. Not on a server, where the page isn't on this
// computer, and not on Windows yet, where paths don't look like this.
function localReach(messageId: string): LocalReach | undefined {
  const message = db.message(messageId)
  // On a server a cited file is saved down instead of shown in Finder (src/server's /local/), so it counts there too.
  if (isWin || message?.author.kind !== 'agent') return undefined
  const agent = db.agent(message.author.id)
  if (!agent) return undefined
  return { agentId: agent.id, own: computers.folder(agent.id), dataRoot: dataDir, limited: isLimited(agent) }
}

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
  // On a server behind https (TUCANO_URL), the provider sends the person back to the server's own
  // address, which src/server hands over here; on a desktop, to the gateway on this computer.
  oauthCallbackUrl: () => (serverMode && publicUrl?.startsWith('https://') ? `${publicUrl}/oauth/callback` : gateway.url('/oauth/callback')),
  // Slack's app registers its address once: the workspace's webhook port, which doesn't change.
  fixedCallbackUrl: () => (serverMode && publicUrl?.startsWith('https://') ? `${publicUrl}/oauth/callback` : `http://localhost:${runtimePorts.webhook}/oauth/callback`)
})
const oauthCallback = async (url: URL): Promise<string> => {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state') ?? ''
  if (!code) return notAuthorized(url)
  return (await connectors.finishOAuth(state, code))
    ? L('Conector autorizado. Pode fechar esta aba e voltar pro Tucano.', 'Connector authorized. You can close this tab and go back to Tucano.')
    : L('Esse pedido de autorização expirou. Tente de novo pelo app.', 'This authorization request expired. Try again from the app.')
}
gateway.route('/oauth/callback', oauthCallback)

const memory = new Memories({ db, engines: engineImpls, settings: () => enginesReady.then(settings), emit, workDir: join(dataDir, 'agents') })

const computers = new Computers({ db, dataDir, emit, shoot })
const backups = join(dataDir, 'backups')

// The runner runs routines, and agents schedule routines through the runner's tools.
const routines = new Routines({
  db,
  runner: { runRoutine: (r, when) => runner.runRoutine(r, when), retryRoutine: (r, when, id) => runner.retryRoutine(r, when, id) },
  connectors: { call: (id, tool, args) => connectors.call(id, tool, args), list: () => connectors.list() },
  connectorsReady: () => connectors.settled(),
  blocked: () => !!settings().paused || inQuietHours(settings().quietHours),
  paused: () => !!settings().paused,
  emit,
  notify: (title, body, conversationId, fullText, to) => notifyAll(title, body, conversationId, fullText, to ? { to } : {})
})

// A proposal waits for a decision: the knock at the door, and a click opens Skills.
const skills = new Skills({ db, emit, notify: (title, body) => notifyAll(title, body, undefined, undefined, { kind: 'approval', page: 'skills' }) })
// The wiki's folder is the truth (Markdown, as Obsidian opens it); TUCANO_WIKI points it elsewhere.
// The default folder keeps wiki.db; another folder gets an index of its own, so going back finds the old one.
const wikiHome = join(dataDir, 'wiki')
const wikiIndex = (dir: string): string => (dir === wikiHome ? join(dataDir, 'wiki.db') : join(dataDir, `wiki-${createHash('sha256').update(dir).digest('hex').slice(0, 12)}.db`))
const wikiDir = (): string => process.env['TUCANO_WIKI'] || settings().wikiDir || wikiHome
// Whose DM a conversation is (null: not a DM; undefined: gone), for where each page's versions came from.
const dmOf = (conversationId: string): string | null | undefined => {
  const c = db.conversationOwner(conversationId)
  return c ? (dmOwner(c, db.ownerId()) ?? null) : undefined
}
// The git sync (wiki-git.ts) hears of every page written here, and says when the wiki takes no writes.
let wikiGit: WikiGit | undefined
const wiki = new Wiki({ dir: wikiDir(), indexPath: wikiIndex(wikiDir()), onChange: () => emit({ type: 'wiki' }), dmOf, onWrite: (w) => wikiGit?.wrote(w.title, w.byName), readOnly: () => wikiGit?.readOnlyReason() })
// The folder is read behind the window: a big Obsidian vault takes a while.
wiki.init(true, true)
toMain({ type: 'wiki_dir', path: wiki.dir })
// What never goes to the wiki's repository: the pages held for someone, the sources that came from a
// DM (or may have: a conversation gone), and Tucano's own index and log, which name every page.
const gitPrivate = (): Set<string> => {
  const out = new Set<string>(['índice.md', 'registro.md'])
  for (const f of wiki.heldFiles()) out.add(f)
  for (const s of wiki.sources(100_000)) {
    const conv = s.origin.conversationId
    if (!conv || dmOf(conv) === null) continue
    out.add(`${s.file}.md`)
    if (s.origin.original) out.add(s.origin.original)
  }
  return out
}
wikiGit = new WikiGit({
  dataDir,
  secrets,
  load: () => db.meta('wikiGit') || undefined,
  store: (json) => db.setMeta('wikiGit', json ?? ''),
  privatePaths: gitPrivate,
  // a held page git moved aside (the repository brought a file by its name): its copy stays held
  movedPrivate: (from, to) => {
    const key = pageKey(from.split('/').pop()!.replace(/\.md$/i, ''))
    const h = wiki.heldKeys().find((x) => x.key === key)
    if (h && to.endsWith('.md')) wiki.holdKey(pageKey(to.split('/').pop()!.replace(/\.md$/i, '')), h.person)
  },
  quiet: (on) => wiki.quiet(on),
  refresh: () => wiki.refresh(),
  notice: (n) => wiki.addNotice(n),
  changed: () => emit({ type: 'wiki' }),
  currentPages: () => wiki.count(),
  ...(process.env['TUCANO_GIT_SSH'] ? { ssh: process.env['TUCANO_GIT_SSH'] } : {}),
  local: fake || process.env['TUCANO_GIT_LOCAL'] === '1',
  log: (line) => console.error(line)
})
const gitSync = wikiGit
// Connected: a round once the folder's first read is done, then every 2 minutes.
void wiki.loaded.then(async () => {
  await gitSync.loadKey()
  if (gitSync.connected) gitSync.start()
})

// "Juntar": the pages the wiki had, copied into the clone it now is. Nothing there is overwritten: a
// file by the same name with something else in it comes in as "(versão do Tucano)". Held pages stay held.
function mergeWiki(from: { root: string; dir: string; held: { key: string; person: string }[] }): { copied: number; copies: string[] } {
  const to = wiki.pagesRoot
  const held = new Map(from.held.map((h) => [h.key, h.person]))
  const own = new Set(['esquema.md', 'índice.md', 'registro.md'])
  let copied = 0
  const copies: string[] = []
  const pagesThere = new Map(wiki.list().flatMap((p) => { const f = wiki.page(p.title)?.file; return f ? [[pageKey(p.title), join(wiki.dir, f)] as const] : [] }))
  const go = (rel: string): void => {
    for (const e of readdirSync(rel ? join(from.root, rel) : from.root, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (!rel && from.root === from.dir && (own.has(e.name) || e.name === 'fontes')) continue
      if (e.isDirectory()) {
        go(r)
        continue
      }
      const src = join(from.root, r)
      let dest = r
      // the same path, or (a page) the same title in another folder: Obsidian would see one page
      const same = existsSync(join(to, dest)) ? join(to, dest) : r.endsWith('.md') ? pagesThere.get(pageKey(r.split('/').pop()!.replace(/\.md$/i, ''))) : undefined
      if (same) {
        if (readFileSync(same).equals(readFileSync(src))) continue
        const dot = r.lastIndexOf('.')
        const [base, ext] = dot > r.lastIndexOf('/') ? [r.slice(0, dot), r.slice(dot)] : [r, '']
        dest = `${base}${COPY_SUFFIX()}${ext}`
        for (let k = 2; existsSync(join(to, dest)); k++) dest = `${base}${COPY_SUFFIX().replace(/\)$/, ` ${k})`)}${ext}`
        copies.push(dest)
      }
      mkdirSync(join(to, dest, '..'), { recursive: true })
      copyFileSync(src, join(to, dest))
      copied++
      const title = (s: string): string => s.split('/').pop()!.replace(/\.md$/i, '')
      const person = r.endsWith('.md') ? held.get(pageKey(title(r))) : undefined
      if (person) wiki.holdKey(pageKey(title(dest)), person)
    }
  }
  if (existsSync(from.root)) go('')
  wiki.scan()
  return { copied, copies }
}
// The curator reads the conversations with the memory's cheap model, and keeps what lasts.
const wikiLlm = async (system: string, prompt: string): Promise<string> => {
  await enginesReady
  const s = settings()
  const model = usable(modelInfo(s.memoryModel)) ?? modelInfo('haiku')!
  const st = s.engines[model.engine]
  if (!st.installed || !st.loggedIn) throw new Error(L(`O ${ENGINES[model.engine].label} não está pronto pra organizar a wiki.`, `${ENGINES[model.engine].label} isn't ready to organize the wiki.`))
  const cwd = join(dataDir, 'agents', '_wiki')
  mkdirSync(cwd, { recursive: true })
  const started = Date.now()
  let text = ''
  for await (const ev of engineImpls[model.engine].run({ model: model.id, effort: 'low', system, prompt, cwd, signal: AbortSignal.timeout(180_000) })) {
    if (ev.type === 'text') text += ev.delta
    else if (ev.type === 'done') {
      text = ev.text || text
      db.addReceipt({ ...ev.usage, model: model.id, ms: Date.now() - started, messageId: 'wiki', agentId: 'wiki', engine: model.engine, at: Date.now() })
    } else if (ev.type === 'error') throw new Error(ev.message)
  }
  return text
}
// A curation from someone's DM may read the pages held for them; any other, none that's held.
const curator = new WikiCurator({ wiki, db, settings, emitMessage: (message) => emit({ type: 'message', message }), llm: wikiLlm, hidden: (id) => wiki.heldTitles(id ? (dmOf(id) ?? undefined) : undefined), beforeWrite: () => gitSync.pull() })
// The review: by hand, or once a week when asked (checked every hour).
const reviewer = new WikiReviewer({ wiki, settings, llm: wikiLlm })
setInterval(() => {
  if (reviewer.due()) void reviewer.review().then(() => emit({ type: 'wiki' }))
}, 3600_000).unref()

const runner = new Runner({
  db,
  engines: engineImpls,
  settings: () => enginesReady.then(settings),
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
  wiki,
  wikiCurator: curator,
  models: () => availableModels(settings(), listed),
  // Approvals and questions reach the phone with their buttons, through toPhone; a finished reply stays on the Mac.
  notify: (title, body, conversationId, kind, threadId, to, messageId) => {
    if (!kind) return notifyAll(title, body, conversationId, undefined, { threadId, ...(to ? { to } : {}), ...(messageId ? { messageId } : {}) })
    const who = notifyTo(conversationId, to)
    const pictures = messageId ? noticePictures(messageId) : []
    toMain({ type: 'notify', title, body, conversationId, threadId, kind, ...(who ? { to: who } : {}), ...(messageId ? { messageId } : {}), ...(pictures.length ? { pictures } : {}), sound: settings().sounds !== false })
    void push.send({ title, body, ...(conversationId ? { conversationId } : {}), ...(threadId ? { threadId } : {}), kind }, who)
  },
  jev: { key: () => secrets.get(JEV_SECRET) },
  onBusy: (busy) => toMain({ type: 'busy', busy }),
  onQuota: (quota) => {
    db.setSettings({ quota })
    emit({ type: 'settings', settings: settings() })
  }
})
runner.setPaused(!!settings().paused)
// Installs from before the Tuca get him at the first start after the introduction.
void enginesReady.then(() => {
  if (settings().onboarding?.done) ensureTuca()
})

if (defaultWorkspace) telegram = new Telegram({
  secrets,
  decide: (id, decision, reason) => runner.decide(id, decision, reason),
  approval: (id) => db.approval(id),
  answer: (conversationId, text, threadId) => void runner.send(conversationId, text, [], threadId),
  changed: () => emit({ type: 'settings', settings: settings() })
})

// Routines started by something on this Mac: POST http://127.0.0.1:WEBHOOK_PORT/gatilho/<token>.
const hooks = createServer((req, res) => {
  // The sign-in of a connector whose app registers a fixed address (Slack's) comes back here.
  if (req.method === 'GET' && req.url?.startsWith('/oauth/callback')) {
    void oauthCallback(new URL(req.url, 'http://localhost')).then(
      (text) => res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(text),
      (e: unknown) => res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(e instanceof Error ? e.message : String(e))
    )
    return
  }
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
      .writeHead(r === 'ok' ? 202 : r === 'busy' || r === 'paused' ? 409 : 404)
      .end(
        r === 'ok'
          ? L('Rotina disparada.\n', 'Routine fired.\n')
          : r === 'busy'
            ? L('A rotina ainda está rodando.\n', 'The routine is still running.\n')
            : r === 'paused'
              ? L('Os agentes estão pausados.\n', 'The agents are paused.\n')
              : L('Nenhuma rotina ligada com esse endereço.\n', 'No routine on with that address.\n')
      )
  })
})
hooks.on('error', (e) => console.error(`[gatilhos] porta ${runtimePorts.webhook}:`, e.message))


void ready.then(async () => {
  toMain({ type: 'ready' })
  // How this workspace's notifications show, before the first one arrives (never a server's: it
  // has no window to draw them in).
  if (!serverMode) toMain({ type: 'notice-pref', ...noticePrefs() })
  workspaceSummary()
  await runner.expireApprovals()
  const settled = await runner.settleDecidedRuns()
  if (settled) console.log(`[core] ${settled} reply(ies) closed: their approval was decided without them`)
  setInterval(() => void runner.expireApprovals(), 60_000).unref()
  // A thread that went quiet gets its own summary, and the memories in it.
  setInterval(() => void memory.sweep().catch((e: unknown) => console.error('[memory]', e)), 60_000).unref()
  // A question to someone that waited past its deadline: its requester hears of it.
  setInterval(() => runner.sweepQuestions(), 60_000).unref()
  setInterval(() => runner.sweepDelegations(), 60_000).unref()
  if (!fake) {
    // A port taken (another Tucano open, say) is logged and the rest goes on: a call there reaches
    // a server that doesn't know its token, never this workspace's data.
    hooks.listen(runtimePorts.webhook, '127.0.0.1')
    void telegram?.start()
  }
  // A copy of the database once a day, the last 7 kept.
  const daily = (): void => {
    try {
      backupIfDue(db, backups, workspaceLabel(db.getSettings(DEFAULTS)))
    } catch (e) {
      console.error('[backup]', e)
    }
    // People removed over 30 days ago: their DMs and memories go (checked hourly, due once a day at most).
    try {
      purged(people.sweep())
    } catch (e) {
      console.error('[people]', e)
    }
  }
  daily()
  setInterval(daily, 3_600_000).unref()
  // Connectors and computers start programs: they're found on the login shell's PATH.
  await pathReady
  connectors.connectAll()
  returnChannelFolders()
  for (const a of db.agents()) if (a.computer && !a.archived) void computers.refresh(a)
  await enginesReady
  routines.start()
  // A Tucano that had more people (or an invite out) before the heritage existed gets it now.
  if (db.people({ removed: true }).length > 1 || db.invites().length) inherit()
}).catch((e: unknown) => {
  console.error('[core] startup failed', e)
  process.exit(1)
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
// Each person's DM with him is kept: every way to the builder screen opens it where it was, and his
// session goes on. `fresh` ("Nova conversa") starts another: the old one goes, with only his hello in the new.
// A model runs here when its harness is chosen and signed in.
function worksWith(s: Settings): (id: string) => boolean {
  return (id) => {
    const m = modelInfo(id)
    return !!m?.id && s.engines[m.engine].loggedIn
  }
}
// The first that runs: the one given, a plan's, the router's or the memory's, or any a harness lists.
function readyModel(s: Settings, first?: string): string | undefined {
  const works = worksWith(s)
  return [first, 'sonnet', 'gpt-5.6-luna', s.routerModel, s.memoryModel, availableModels(s, listed)[0]?.id].find((id): id is string => !!id && id !== 'jev' && works(id))
}

// `person`: whose builder screen it is: each person has their own DM with him.
function ensureTuca(modelId?: string, fresh = false, person = db.ownerId()): { agentId: string; conversationId: string } {
  const s = settings()
  const works = worksWith(s)
  let tuca = db.agents().find((a) => a.kind === 'tuca')
  // Made before he helped with the app: what he does and says, as it is now.
  const current = tuca && tucaUpToDate(tuca)
  if (current) {
    tuca = current
    db.saveAgent(tuca)
    emit({ type: 'agent', agent: tuca })
  }
  // A harness turned off since: the model given now, if it works.
  if (tuca && !works(tuca.modelId) && modelId && works(modelId)) {
    tuca = { ...tuca, modelId }
    db.saveAgent(tuca)
    emit({ type: 'agent', agent: tuca })
  }
  if (!tuca) {
    const model = readyModel(s, modelId)
    tuca = tucaAgent(model ?? 'sonnet', db.agents().map((a) => a.handle), s.defaultLimit)
    db.saveAgent(tuca)
    emit({ type: 'agent', agent: tuca })
  }
  const theirs = (c: { kind: 'channel' | 'dm'; owner?: string; name: string }): boolean => c.kind === 'dm' && c.name === tuca!.id && dmOwner(c, db.ownerId()) === person
  let dm = db.conversations().find(theirs)
  if (dm && fresh) {
    for (const m of db.messagesWithRun(['working'])) if (m.conversationId === dm.id) runner.stop(m.id)
    runner.forgetSessions({ conversationId: dm.id })
    db.deleteConversation(dm.id)
    emit({ type: 'conversation_removed', id: dm.id, for: person })
    dm = undefined
  }
  if (!dm) {
    db.createConversation({ id: randomUUID(), kind: 'dm', name: tuca.id, members: [tuca.id], owner: person })
    dm = db.conversations().find(theirs)!
    const hello: Message = { id: randomUUID(), conversationId: dm.id, author: { kind: 'agent', id: tuca.id }, text: tucaHello(), at: Date.now() }
    db.saveMessage(hello)
    emitConversations([dm.id])
    emit({ type: 'message', message: hello })
  }
  return { agentId: tuca.id, conversationId: dm.id }
}

// One of a reply's proposals changed: settled once (applied, with what it made or changed, or
// dismissed), or told why applying it didn't work. A reply from before (one `proposal`) gets the list.
type ProposalPatch = { state?: 'applied' | 'dismissed'; appliedId?: string; error?: string; agentIds?: string[] }
function patchProposal(messageId: string, index: number, patch: ProposalPatch): void {
  const m = db.message(messageId)
  const list = proposalsOf(m?.run)
  const p = list[index]
  if (!m?.run || !p || p.state) return
  const proposals = list.map((x, i) => (i === index ? ({ ...x, ...patch } as Proposal) : x))
  if (patch.state || !patch.error) delete proposals[index]!.error
  const { proposal: _old, ...run } = m.run
  const updated: Message = { ...m, run: { ...run, proposals } }
  db.saveMessage(updated)
  emit({ type: 'message', message: updated })
  if (patch.state) emit({ type: 'inbox' }) // one a member had sent the admins leaves their inbox
}
function settleProposal(messageId: string, index: number, appliedId?: string, extra: ProposalPatch = {}): void {
  patchProposal(messageId, index, { ...extra, state: appliedId ? 'applied' : 'dismissed', ...(appliedId ? { appliedId } : {}) })
}

// The agents a card needs from its own reply (`needs`), as made: the new-agent card's, a team's.
function neededAgents(messageId: string, p: Proposal): string[] {
  const run = db.message(messageId)?.run
  return (p.needs ?? []).map((name) => {
    const same = (n: string): boolean => n.toLowerCase() === name.toLowerCase()
    const d = run?.agentDraft
    if (d && same(d.name) && d.state === 'created' && d.agentId && db.agent(d.agentId)) return d.agentId
    for (const t of proposalsOf(run)) {
      if (t.kind !== 'team' || t.state !== 'applied') continue
      const at = t.agents.findIndex((a) => same(a.name))
      const id = at >= 0 ? t.agentIds?.[at] : undefined
      if (id && db.agent(id)) return id
    }
    throw new Error(L(`Antes, crie ${name}: está num card desta mesma resposta.`, `Create ${name} first: it's in a card of this same reply.`))
  })
}

// A Tuca's card is settled once: created (with the agent) or dismissed.
function settleDraft(messageId: string, agentId?: string): void {
  const m = db.message(messageId)
  if (!m?.run?.agentDraft || m.run.agentDraft.state) return
  const updated: Message = { ...m, run: { ...m.run, agentDraft: { ...m.run.agentDraft, state: agentId ? 'created' : 'dismissed', ...(agentId ? { agentId } : {}) } } }
  db.saveMessage(updated)
  emit({ type: 'message', message: updated })
  emit({ type: 'inbox' }) // one a member had sent the admins leaves their inbox
}


// A member's card for agents or a team: it went to the admins instead of being applied.
class Forwarded extends Error {}

// One card of a reply, done the way the screens do it (and checked the same way). `batch`: part of
// "apply all", which tells the admins once for everything a member sent them.
function applyOne(ctx: Ctx, messageId: string, index: number, batch = false): { id: string } {
  const p = proposalsOf(db.message(messageId)?.run)[index]
  if (!p) throw new Error(L('Essa proposta não existe mais.', 'That proposal no longer exists.'))
  if (p.state) throw new Error(p.state === 'applied' ? L('Essa proposta já foi aplicada.', 'That proposal was already applied.') : L('Essa proposta foi descartada.', 'That proposal was discarded.'))
  // Agents are the admins': a member's card goes to them instead (they get what it proposes).
  if ((p.kind === 'agent' || p.kind === 'team') && !isAdmin(ctx.person)) {
    const what = p.kind === 'agent' ? L(`mudar ${db.agent(p.agentId)?.name ?? 'um agente'}`, `change ${db.agent(p.agentId)?.name ?? 'an agent'}`) : L(`criar ${p.agents.map((a) => a.name).join(', ')}`, `create ${p.agents.map((a) => a.name).join(', ')}`)
    if (!batch) notifyAll(L(`${ctx.person.name} pede pra ${what}`, `${ctx.person.name} asks to ${what}`), p.reason ?? L('Uma proposta do Tuca que só um admin aplica.', 'A Tuca proposal only an admin can apply.'), undefined, undefined, { to: db.people().filter(isAdmin).map((x) => x.id) })
    record(ctx, 'proposal.forwarded', messageId, { kind: p.kind, index })
    if (!batch) emit({ type: 'inbox' })
    throw new Forwarded(L('Só um admin aplica isso: os admins foram avisados.', 'Only an admin can apply this: the admins were told.'))
  }
  if (p.kind === 'routine') mayRoutine(ctx, { scope: p.routine.scope, owner: ctx.person.id })
  const needed = neededAgents(messageId, p)
  let id: string
  const extra: ProposalPatch = {}
  if (p.kind === 'agent') {
    const agent = db.agent(p.agentId)
    if (!agent || agent.archived) throw new Error(L('Esse agente não existe mais.', 'That agent no longer exists.'))
    const channelIds = db.conversations().filter((c) => c.kind === 'channel' && c.members.includes(agent.id)).map((c) => c.id)
    api.saveAgent({ agent: { ...agent, ...p.changes }, channelIds }, ctx)
    id = agent.id
  } else if (p.kind === 'routine') {
    if (p.routine.conversationId) reach(ctx, p.routine.conversationId)
    const agentId = needed[0] ?? p.routine.agentId
    const conversationId = p.routine.conversationId || api.openDm({ agentId }, ctx)
    const made = routines.save({ ...p.routine, agentId, conversationId }, ctx.person.id)
    id = made.id
    record(ctx, 'routine.created', id, routineDetail(db, made))
  } else if (p.kind === 'channel') {
    id = api.createChannel({ name: p.name, ...(p.threads ? { threads: true } : {}) }, ctx)
    api.setChannelMembers({ id, agentIds: [...new Set([...p.members, ...needed])] }, ctx)
    if (p.topic) api.setTopic({ id, topic: p.topic }, ctx)
  } else {
    // A team: its agents, each with a DM, and the channel they share when there is one.
    if (p.channel && db.conversations().some((c) => c.kind === 'channel' && c.name === p.channel!.name)) throw new Error(L(`Já existe o canal #${p.channel.name}.`, `There's already a #${p.channel.name} channel.`))
    const made: string[] = []
    for (const d of p.agents) {
      const agent = { ...agentFromDraft(d, db.agents().map((a) => a.handle), settings().defaultLimit), owner: ctx.person.id }
      db.saveAgent(agent)
      emit({ type: 'agent', agent })
      record(ctx, 'agent.created', agent.id, { name: agent.name })
      api.openDm({ agentId: agent.id }, ctx)
      made.push(agent.id)
    }
    extra.agentIds = made
    if (p.channel) {
      id = api.createChannel({ name: p.channel.name, ...(p.channel.threads ? { threads: true } : {}) }, ctx)
      api.setChannelMembers({ id, agentIds: made }, ctx)
      if (p.channel.topic) api.setTopic({ id, topic: p.channel.topic }, ctx)
    } else id = made[0]!
  }
  settleProposal(messageId, index, id, extra)
  return { id }
}

const PAGE = 100 // messages outside threads per conversation, per page sent to the window

// Each method gets who is asking: every human action is that person's.
type Handlers = { [M in Method]: (p: Params<M>, ctx: Ctx) => ReturnType<Api[M]> }

// Someone else's DM is out of reach (and says so, no more); one that's gone, gone.
function reach(ctx: Ctx, conversationId: string | undefined): void {
  const why = people.conversationError(ctx.person, conversationId)
  if (why) throw new Error(why)
}
// A message from a channel's heritage (People.visibleAt) is, to a member, as if it weren't there.
function reachMessage(ctx: Ctx, messageId: string): void {
  reach(ctx, db.messageConversation(messageId))
  const m = db.message(messageId)
  if (m && !people.visibleAt(ctx.person, m)) throw new Error(L('Essa mensagem não existe mais.', 'That message no longer exists.'))
}
// How a conversation works (threads, the wiki, its summary): a DM's person's; a channel's, whoever
// made it and the admins, like its name and agents.
function manage(ctx: Ctx, conversationId: string): void {
  reach(ctx, conversationId)
  const c = db.conversation(conversationId)
  if (c?.kind === 'channel' && !mayEditChannel(ctx.person, c, db.ownerId())) throw new Error(channelEditError())
}
// A person's own memories are theirs alone to change; an agent's notes are the admins'.
function ownMemory(ctx: Ctx, id: string): void {
  const m = db.memory(id)
  if (m) must(ctx.person, { kind: 'memory', scope: m.scope, ...(m.privateTo ? { privateTo: m.privateTo } : {}) })
}
// What the wiki made of a source is seen by whoever sees the source: one from someone's DM, by
// them alone. A change or version whose source is gone went with it.
const seesSource = (ctx: Ctx) => (sourceId: string): boolean => {
  const src = wiki.source(sourceId)
  return !!src && people.canSeeFrom(ctx.person, src.origin.conversationId)
}
// A change this person may know of: not from a source they don't see, not on a page held (or ever
// held) for someone else, and, once decided, not from before the heritage (the owner's history, as
// its versions are: wikiHistory). One rule for the list, a single read, and every action by id.
const seesChange = (ctx: Ctx, c: WikiChange): boolean =>
  (!c.source || seesSource(ctx)(c.source.id)) && !c.ops.some((o) => heldFrom(ctx, o.page) || everHeldFrom(ctx, o.page)) && (c.state === 'pending' || c.state === 'conflict' || (c.decidedAt ?? c.at) >= historySince(ctx))
function changeInReach(ctx: Ctx, id: string): void {
  const c = wiki.change(id)
  if (c && !seesChange(ctx, c)) throw new Error(L('Essa mudança não existe mais.', 'That change no longer exists.'))
}
// Someone's DM, to an admin: that a source came from one, nothing of what it says.
const privateSource = (s: WikiSource): WikiSource => ({ id: s.id, file: s.id, title: L('Uma fonte de uma conversa privada', 'A source from a private conversation'), kind: s.kind, origin: {}, addedBy: s.addedBy, addedAt: s.addedAt, private: true })
const wikiSourcesFor = (ctx: Ctx, limit = 100): WikiSource[] =>
  wiki.sources(limit).flatMap((s) => (people.canSeeFrom(ctx.person, s.origin.conversationId) ? [s] : isAdmin(ctx.person) ? [privateSource(s)] : []))
// The team's log (owners and admins read it): who did what, never what a DM said.
const record = (ctx: Ctx | undefined, kind: string, target?: string, detail?: Record<string, unknown>): void =>
  void db.addActivity({ ...(ctx ? { personId: ctx.person.id } : {}), kind, ...(target ? { target } : {}), ...(detail ? { detail } : {}) })
// A routine's rules: the team's are the admins'; a person's, theirs (and the admins').
const mayRoutine = (ctx: Ctx, r: Pick<Routine, 'scope' | 'owner'> | undefined): void => must(ctx.person, { kind: 'routine', routine: r ?? { scope: 'channel' } })
// A browser working for a conversation this person sees is theirs to take over; any other, the admins'.
function mayBrowser(ctx: Ctx, agentId: string): void {
  if (!people.canSeeFrom(ctx.person, browser.view(agentId)?.conversationId) || !browser.view(agentId)?.conversationId) must(ctx.person, { kind: 'admin' })
}
// What a removed person's DMs had running stops; their files go from the disk, and what the wiki
// took from those DMs goes too. Only they could see any of it: no one else is told (not even the ids).
function purged(all: Purged[]): void {
  for (const p of all) {
    for (const id of p.dms) {
      runner.forgetSessions({ conversationId: id })
      emit({ type: 'conversation_removed', id, for: p.person })
    }
    for (const r of p.routines) emit({ type: 'routine_removed', id: r.id, for: p.person })
    for (const a of p.artifacts) rmSync(join(dataDir, 'artifacts', a.id), { recursive: true, force: true })
    for (const src of wiki.sources(100_000)) if (src.origin?.conversationId && p.dms.includes(src.origin.conversationId)) wiki.removeSource(src.id)
  }
  if (all.some((p) => p.dms.length)) {
    wiki.scrub() // what those sources proposed leaves the index's file too
    emit({ type: 'wiki' })
  }
}
// The Tucano gets its second person (its first invite, or someone joining): what was one person's
// becomes a team's. Once. The channels' summaries (and their threads') are made again from what was
// said there alone: while alone, the owner's DM memories fed them. The pages that came from the
// owner's DMs stay theirs until they release each one, and the wiki's history from before is theirs.
function inherit(): void {
  if (db.meta('heritageAt')) return
  const at = Date.now()
  db.setMeta('heritageAt', String(at))
  wiki.inherit(db.ownerId(), at)
  // What a channel held before stays the owner's (People.visibleAt): the team's summaries start here.
  for (const c of db.conversations()) if (c.kind === 'channel') bg(memory.rebuild(c.id, at), 'heritage')
  emit({ type: 'wiki' })
}
const heritageAt = (): number => Number(db.meta('heritageAt') ?? 0)
// The wiki's history from before the heritage: the owner's alone.
const historySince = (ctx: Ctx): number => (ctx.person.role === 'owner' ? 0 : heritageAt())
// The wiki as this person reads it: without the pages held for someone else, and (but the owner's)
// its log from the heritage on.
const wikiFor = (ctx: Ctx): WikiView => wiki.view(wiki.heldTitles(ctx.person.id), ctx.person.role === 'owner' ? {} : { viewer: ctx.person.id, afterSwitch: true, everHidden: wiki.everHeld(ctx.person.id) })
// Whether a title (any spelling of it: see pageKey) is a page held for someone else.
const heldFrom = (ctx: Ctx, title: string | undefined): boolean => !!title && wiki.heldTitles(ctx.person.id).has(pageKey(title))
// ...or ever was (gone or renamed since, not released): what names it (a change's pages) isn't theirs either.
const everHeldFrom = (ctx: Ctx, title: string | undefined): boolean => !!title && wiki.everHeld(ctx.person.id).has(pageKey(title))
// A name someone may not take, said the same whether it's a page held for someone else or not.
const titleUnavailable = (title: string): string => L(`Não dá pra usar o título "${title.trim()}". Escolha outro.`, `The title "${title.trim()}" can't be used. Pick another.`)

// How the wiki's history names someone: the owner by the workspace's name, as before.
const nameOf = (ctx: Ctx): string => (ctx.person.role === 'owner' ? settings().workspaceName : ctx.person.name) || L('Você', 'You')
const emitPeople = (): void => emit({ type: 'people', people: db.people(), former: db.formerPeople() })

const api: Handlers = {
  markRead: ({ conversationId }, ctx) => {
    reach(ctx, conversationId)
    db.markRead(conversationId, ctx.person.id)
    emitConversations([conversationId])
  },
  // The page loads from file://, which can't fetch tucano:// (CORS); text comes through the core instead.
  artifactText: ({ id }, ctx) => {
    const a = db.artifact(id)
    if (!a || !people.canSeeConversation(ctx.person, db.conversation(a.conversationId)) || !people.artifactVisible(ctx.person, a)) return null
    const file = join(dataDir, 'artifacts', a.id, a.name)
    try {
      return readFileSync(file, 'utf8').slice(0, 2_000_000)
    } catch {
      return null
    }
  },

  snapshot: (_, ctx) => people.snapshotFor(ctx.person, {
    webhookPort: runtimePorts.webhook,
    defaultWorkspace,
    settings: settings(),
    agents: db.agents(),
    ...db.openingMessages(PAGE), // each conversation's latest: the rest come as the scroll gets there
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
    // On a desktop it's always offered (the page says when Docker is missing); a server without Docker,
    // inside a container, can't have one, so it isn't.
    isolatedComputers: !serverMode || onPath('docker'),
    demoServer: existsSync(demoPath) ? { command: 'node', args: [demoPath] } : undefined
  }, { server: serverMode }),

  olderMessages: ({ conversationId, before, through }, ctx) => {
    reach(ctx, conversationId)
    // Back to a message to show (a reply: from its thread's first message), or one more page.
    const target = through ? db.message(through) : undefined
    const start = target?.threadId ? db.message(target.threadId) : target
    const page = db.messagesBefore(conversationId, before, PAGE, start?.conversationId === conversationId ? start.at : undefined)
    const messages = people.pageFor(ctx.person, page.messages)
    // Past the heritage, to a member, there's nothing more to read.
    return { messages, since: messages.length < page.messages.length ? 0 : page.since }
  },
  threadMessages: ({ rootId }, ctx) => {
    const root = db.message(rootId)
    if (!root) return []
    reach(ctx, root.conversationId)
    return people.pageFor(ctx.person, [root, ...db.recentMessages(root.conversationId, 100_000, rootId)])
  },

  sendMessage: ({ conversationId, text, images, files, threadId }, ctx) => {
    reach(ctx, conversationId)
    bg(runner.send(conversationId, text, images, threadId, ctx.person.id, files?.length ? { files } : {}), 'sendMessage')
  },

  typing: ({ conversationId, threadId, opened }, ctx) => {
    reach(ctx, conversationId)
    void runner.typing(conversationId, threadId, opened).catch((e: unknown) => console.warn('[typing]', e))
  },

  stopRun: ({ messageId }, ctx) => (reachMessage(ctx, messageId), runner.stop(messageId)),

  retryRun: ({ messageId }, ctx) => (reachMessage(ctx, messageId), runner.retry(messageId)),

  continueRun: ({ messageId }, ctx) => (reachMessage(ctx, messageId), bg(runner.continue(messageId), 'continueRun')),

  setAgentModels: ({ agentIds, modelId }, ctx) => {
    const value = modelId.trim()
    const model = modelInfo(value)
    if (!model?.id) throw new Error(L('Escolha um modelo válido.', 'Choose a valid model.'))
    const agents = [...new Set(agentIds)].map((id) => {
      const agent = db.agent(id)
      if (!agent) throw new Error(L('Um dos agentes não existe mais. Atualize a lista.', 'An agent no longer exists. Refresh the list.'))
      return agent
    })
    const changed = agents.filter((a) => a.modelId !== value).map((a): Agent => ({
      ...a,
      modelId: value,
      ...(modelInfo(a.modelId)?.engine !== model.engine ? { accountId: undefined } : {})
    }))
    db.tx(() => {
      for (const agent of changed) {
        db.saveAgent(agent)
        record(ctx, 'agent.updated', agent.id, { name: agent.name, modelId: value })
      }
    })
    for (const agent of changed) emit({ type: 'agent', agent: db.agent(agent.id)! })
    return changed.length
  },

  saveAgent: ({ agent, channelIds }, ctx) => {
    const before = db.agent(agent.id)
    // Archived changes only through archiveAgent, which also stops what the agent was doing.
    // Its owner changes only with the removal hand-over, never by an edit (one with none is the
    // Tucano owner's, as db.agent reads it): a new one is whoever made it.
    const clean: Agent = { ...cleanLook(agent), name: agent.name.trim(), handle: agent.handle.trim().toLowerCase(), archived: before?.archived ?? false, owner: before ? (before.owner ?? db.ownerId()) : ctx.person.id }
    // One handle per agent (archived ones keep theirs), and none that reads as a person's (People.agentNameError).
    const taken = people.agentNameError({ id: clean.id, name: clean.name, handle: clean.handle })
    if (taken) throw new Error(taken)
    // How far it goes on its own: only known rules and levels (saving an agent is an admin's, policy-people.ts).
    clean.actionRules = cleanRules(clean.actionRules)
    if (!isAutonomy(clean.autonomy)) delete clean.autonomy
    if (typeof clean.outsideGuard !== 'boolean') delete clean.outsideGuard
    // Whom it answers to (src/shared/org.ts): another agent that isn't itself, below it, archived or the Tuca. Anything else: no one.
    // One that already answered to the same agent keeps doing so: only a change is checked.
    if (!clean.reportsTo || clean.kind === 'tuca' || (db.agent(clean.id)?.reportsTo !== clean.reportsTo && !possibleBosses(db.agents(), clean.id).some((a) => a.id === clean.reportsTo))) delete clean.reportsTo
    const linux = (a?: Agent): boolean => !!a?.computer && a.computerKind !== 'mac'
    const mac = (a?: Agent): boolean => !!a?.computer && a.computerKind === 'mac'
    db.saveAgent(clean)
    // A Linux computer starts right away when turned on (the first time downloads the system) and stops when
    // turned off or moved to the Mac; a computer on the Mac has nothing to start, only its services to stop.
    if (linux(clean) && !linux(before)) void computers.ensure(clean.id).catch(() => {})
    if (linux(before) && !linux(clean))
      bg(computers.stopLinux(clean.id).then(() => {
        if (mac(clean)) db.removeServices(clean.id) // the container's services don't exist on the Mac
        return computers.refresh(clean)
      }), 'saveAgent')
    if (mac(before) && !mac(clean)) bg(computers.mac.stopAll(clean.id).then(() => computers.refresh(clean)), 'saveAgent')
    if (mac(clean) && !mac(before)) bg(computers.refresh(clean), 'saveAgent')
    if (before?.browser && !clean.browser) bg(browser.close(clean.id), 'saveAgent') // its logins stay, for when it's turned back on
    const changed = db.setAgentChannels(clean.id, channelIds)
    emit({ type: 'agent', agent: db.agent(clean.id)! })
    emitConversations(changed)
    record(ctx, before ? 'agent.updated' : 'agent.created', clean.id, { name: clean.name })
  },

  // Archived, an agent keeps its history and receipts but stops: replies running end,
  // its routines turn off, its browser closes. Its channels and settings stay for when it comes back.
  archiveAgent: ({ id, archived }, ctx) => {
    const agent = db.agent(id)
    if (!agent || agent.archived === archived) return
    record(ctx, archived ? 'agent.archived' : 'agent.restored', id, { name: agent.name })
    if (archived) {
      for (const m of db.messagesWithRun(['working', 'waiting_approval'])) if (m.author.kind === 'agent' && m.author.id === id) runner.stop(m.id)
      routines.pauseAgent(id)
      runner.forgetSessions({ agentId: id })
      if (agent.browser) bg(browser.close(id), 'archiveAgent')
    }
    db.saveAgent({ ...agent, archived })
    emit({ type: 'agent', agent: db.agent(id)! })
    emitConversations()
  },
  renameChannel: ({ id, name }, ctx) => {
    const conv = db.conversation(id)
    if (conv?.kind !== 'channel') return
    if (!mayEditChannel(ctx.person, conv, db.ownerId())) throw new Error(channelEditError())
    const clean = channelName(name)
    if (!clean) throw new Error(L('Dê um nome ao canal.', 'Give the channel a name.'))
    if (db.conversations().some((c) => c.kind === 'channel' && c.name === clean && c.id !== id)) throw new Error(L(`Já existe o canal #${clean}.`, `There's already a #${clean} channel.`))
    db.renameConversation(id, clean)
    emitConversations([id])
  },
  setTopic: ({ id, topic }, ctx) => {
    const conv = db.conversation(id)
    if (conv?.kind !== 'channel') return
    if (!mayEditChannel(ctx.person, conv, db.ownerId())) throw new Error(channelEditError())
    db.setTopic(id, topic.trim() || undefined)
    emitConversations([id])
  },
  setChannelMembers: ({ id, agentIds }, ctx) => {
    const conv = db.conversation(id)
    if (conv?.kind !== 'channel') return
    if (!mayEditChannel(ctx.person, conv, db.ownerId())) throw new Error(channelEditError())
    const known = new Set(db.agents().filter((a) => !a.archived).map((a) => a.id))
    db.setMembers(id, agentIds.filter((a) => known.has(a)))
    emitConversations([id])
  },
  // Everything that only made sense there goes too: replies still running stop,
  // its routines, its pending approvals.
  localPath: ({ messageId, path }, ctx) => {
    reachMessage(ctx, messageId)
    const reach = localReach(messageId)
    const found = reach && resolveLocal(path, reach)
    if (!found) return null
    const base = serverMode ? '/local' : undefined
    // On a server, signed for this person: the address opens nothing for anyone else.
    const whose = serverMode ? ctx.person.id : undefined
    const seen = (found.kind === 'image' || found.kind === 'video') && localKey ? { url: localUrl(localKey, found.path, base, whose) } : {}
    // On a server the file isn't on the person's computer: showing it in Finder means nothing, saving it does.
    const saved = serverMode && localKey && found.kind !== 'folder' ? { download: `${localUrl(localKey, found.path, base, whose)}?download=1` } : {}
    return { kind: found.kind, ...seen, ...saved }
  },
  openLocal: ({ messageId, path, how }, ctx) => {
    reachMessage(ctx, messageId)
    const reach = localReach(messageId)
    const found = reach && resolveLocal(path, reach)
    if (found) toMain({ type: 'open_local', path: found.path, how: how === 'open' && (found.kind === 'folder' || found.kind === 'pdf') ? 'open' : 'reveal' })
  },

  deleteConversation: ({ id }, ctx) => {
    const c = db.conversation(id)
    if (!c) return
    reach(ctx, id)
    if (c.kind === 'channel') must(ctx.person, { kind: 'admin' })
    record(ctx, c.kind === 'channel' ? 'channel.deleted' : 'dm.deleted', id, c.kind === 'channel' ? { name: c.name } : undefined)
    for (const m of db.messagesWithRun(['working', 'waiting_approval'])) if (m.conversationId === id) runner.stop(m.id)
    for (const r of db.routines()) if (r.conversationId === id) routines.remove(r.id)
    for (const a of db.approvals()) if (a.conversationId === id && a.state === 'pending' && db.decideApproval(a.id, 'expired', L('O canal foi excluído.', 'The channel was deleted.'))) emit({ type: 'approval', approval: db.approvals().find((x) => x.id === a.id)! })
    runner.forgetSessions({ conversationId: id })
    db.deleteConversation(id)
    emit({ type: 'conversation_removed', id, ...(c.kind === 'dm' ? { for: dmOwner(c, db.ownerId()) } : {}) })
  },

  createChannel: ({ name, threads }, ctx) => {
    const clean = channelName(name)
    if (!clean) throw new Error(L('Dê um nome ao canal.', 'Give the channel a name.'))
    if (db.conversations().some((c) => c.kind === 'channel' && c.name === clean)) throw new Error(L(`Já existe o canal #${clean}.`, `There's already a #${clean} channel.`))
    const id = randomUUID()
    db.createConversation({ id, kind: 'channel', name: clean, members: [], createdBy: ctx.person.id, ...(threads ? { threads } : {}) })
    emitConversations([id])
    record(ctx, 'channel.created', id, { name: clean })
    return id
  },

  ensureTuca: ({ modelId, fresh }, ctx) => ensureTuca(modelId, fresh, ctx.person.id),
  createFromDraft: ({ messageId }, ctx) => {
    reachMessage(ctx, messageId)
    const d = db.message(messageId)?.run?.agentDraft
    if (!d) throw new Error(L('Essa proposta não existe mais.', 'That proposal no longer exists.'))
    if (d.state === 'created' && d.agentId) throw new Error(L('Esse agente já foi criado.', 'That agent was already created.'))
    const agent = { ...agentFromDraft(d, db.agents().map((a) => a.handle), settings().defaultLimit), owner: ctx.person.id }
    db.saveAgent(agent)
    emit({ type: 'agent', agent })
    record(ctx, 'agent.created', agent.id, { name: agent.name })
    settleDraft(messageId, agent.id)
    const conversationId = randomUUID()
    db.createConversation({ id: conversationId, kind: 'dm', name: agent.id, members: [agent.id], owner: ctx.person.id })
    emitConversations([conversationId])
    return { agentId: agent.id, conversationId }
  },
  settleDraft: ({ messageId, agentId }, ctx) => (reachMessage(ctx, messageId), settleDraft(messageId, agentId)),
  // What a Tuca's card proposed, done the way the screens do it (and checked the same way).
  applyProposal: ({ messageId, index = 0 }, ctx) => {
    if (!people.forwarded(ctx.person, messageId, index)) reachMessage(ctx, messageId)
    try {
      return applyOne(ctx, messageId, index)
    } catch (e) {
      if (!(e instanceof Forwarded)) patchProposal(messageId, index, { error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  },
  // Every card of the reply still open, in an order that makes agents first. One failing (or sent to
  // the admins) doesn't stop the others; the admins hear once about what a member sent them.
  applyProposals: ({ messageId, draft }, ctx) => {
    reachMessage(ctx, messageId)
    const m = db.message(messageId)
    const list = proposalsOf(m?.run)
    if (!m?.run || (!list.length && !m.run.agentDraft)) throw new Error(L('Essas propostas não existem mais.', 'Those proposals no longer exist.'))
    const out: ProposalsResult = { applied: [], failed: [], forwarded: [] }
    const d = m.run.agentDraft
    if (draft && d && !d.state) {
      try {
        if (!isAdmin(ctx.person)) throw new Error(adminError()) // as createFromDraft checks it at the door
        out.draft = { agentId: api.createFromDraft({ messageId }, ctx).agentId }
      } catch (e) {
        out.draft = { error: e instanceof Error ? e.message : String(e) }
      }
    }
    for (const index of applyOrder(list)) {
      if (proposalsOf(db.message(messageId)?.run)[index]?.state) continue
      try {
        out.applied.push({ index, id: applyOne(ctx, messageId, index, true).id })
      } catch (e) {
        if (e instanceof Forwarded) {
          out.forwarded.push(index)
          continue
        }
        const error = e instanceof Error ? e.message : String(e)
        patchProposal(messageId, index, { error })
        out.failed.push({ index, error })
      }
    }
    if (out.forwarded.length) {
      const n = out.forwarded.length
      notifyAll(L(`${ctx.person.name} pede pra aplicar ${n === 1 ? 'uma proposta' : `${n} propostas`} do Tuca`, `${ctx.person.name} asks to apply ${n === 1 ? 'a Tuca proposal' : `${n} Tuca proposals`}`), L('Mudanças em agentes que só um admin aplica.', 'Changes to agents only an admin can apply.'), undefined, undefined, { to: db.people().filter(isAdmin).map((x) => x.id) })
      emit({ type: 'inbox' })
    }
    record(ctx, 'proposals.applied', messageId, { applied: out.applied.length, failed: out.failed.length, forwarded: out.forwarded.length })
    return out
  },
  dismissProposal: ({ messageId, index = 0 }, ctx) => (people.forwarded(ctx.person, messageId, index) || reachMessage(ctx, messageId), settleProposal(messageId, index)),
  dismissProposals: ({ messageId, draft }, ctx) => {
    reachMessage(ctx, messageId)
    const m = db.message(messageId)
    proposalsOf(m?.run).forEach((p, i) => p.state || settleProposal(messageId, i))
    if (draft && m?.run?.agentDraft && !m.run.agentDraft.state) settleDraft(messageId)
  },
  // One DM per agent and person.
  openDm: ({ agentId }, ctx) => {
    const existing = db.conversations().find((c) => c.kind === 'dm' && c.name === agentId && dmOwner(c, db.ownerId()) === ctx.person.id)
    if (existing) return existing.id
    const id = randomUUID()
    db.createConversation({ id, kind: 'dm', name: agentId, members: [agentId], owner: ctx.person.id })
    emitConversations([id])
    return id
  },

  saveSkill: ({ skill }, ctx) => {
    const saved = skills.save(skill)
    record(ctx, skill.id ? 'skill.updated' : 'skill.created', saved.id, { name: saved.name })
    return saved
  },
  localSkills: () => findLocalSkills(),
  linkSkill: ({ source, agents }, ctx) => {
    if (!findLocalSkills().some((k) => k.source === source)) throw new Error(L('Essa skill não está mais no seu Claude Code nem no Codex.', "That skill is no longer in your Claude Code or Codex."))
    const linked = skills.link(source, agents)
    record(ctx, 'skill.created', linked.id, { name: linked.name, source })
    return linked
  },
  decideSkill: ({ id, approve }, ctx) => (record(ctx, 'skill.decided', id, { approve }), void skills.decide(id, approve)),
  restoreSkill: ({ skillId, versionId }, ctx) => (record(ctx, 'skill.updated', skillId, { restored: versionId }), void skills.restore(skillId, versionId)),
  archiveSkill: ({ id, archived }, ctx) => (record(ctx, archived ? 'skill.archived' : 'skill.restored', id), void skills.archive(id, archived)),
  removeSkill: ({ id }, ctx) => (record(ctx, 'skill.removed', id), skills.remove(id)),
  skillVersions: ({ skillId }) => db.skillVersions(skillId),

  checkTrigger: ({ trigger }) => routines.preview(trigger),

  setTelegramToken: ({ token }) => {
    if (!telegram) throw new Error(L('O Telegram fica no workspace padrão.', 'Telegram belongs to the default workspace.'))
    return telegram.setToken(token)
  },
  exportTeam: (_, ctx) => exportTeam(db, ctx.person.id),
  importTeam: ({ text }, ctx) => {
    const r = importTeam(db, text, settings().defaultLimit, ctx.person.id)
    record(ctx, 'team.imported')
    for (const a of db.agents()) emit({ type: 'agent', agent: a })
    emitConversations()
    for (const k of db.skills()) emit({ type: 'skill', skill: k })
    for (const r2 of db.routines()) emit({ type: 'routine', routine: r2 })
    return r
  },
  importAgents: ({ path, data }, ctx) => {
    record(ctx, 'team.imported')
    if (!path && !data) throw new Error(L('Escolha um arquivo .zip.', 'Choose a .zip file.'))
    const zip = path ? zipFromFile(path) : zipFromBuffer(Buffer.from(data!, 'base64'))
    try {
      const s = settings()
      const r = applyForeignTeam(db, readForeignZip(zip), { defaultLimit: s.defaultLimit, defaultModel: readyModel(s) ?? 'sonnet', works: worksWith(s) })
      for (const id of r.agents) emit({ type: 'agent', agent: db.agent(id)! })
      emitConversations()
      for (const k of db.skills()) emit({ type: 'skill', skill: k })
      for (const r2 of db.routines()) emit({ type: 'routine', routine: r2 })
      for (const m of r.memories) emit({ type: 'memory', memory: m })
      return r.summary
    } finally {
      zip.close()
    }
  },
  backupNow: () => backup(db, backups, workspaceLabel(db.getSettings(DEFAULTS))),
  // Everything in one .zip in Downloads, shown in the Finder: to take to a server, which restores it.
  exportBackup: () => {
    if (serverMode) throw new Error(L('O backup completo sai do app do computador.', 'The full backup comes from the desktop app.'))
    const downloads = join(homedir(), 'Downloads')
    const dir = existsSync(downloads) ? downloads : backups
    const day = new Date().toISOString().slice(0, 10)
    let out = join(dir, `Tucano-backup-${day}.zip`)
    for (let n = 2; existsSync(out); n++) out = join(dir, `Tucano-backup-${day} (${n}).zip`)
    const summary = writeBackup({ db, dataDir, wikiDir: wiki.dir, wikiIndex: wikiIndex(wiki.dir), out, app: appVersion })
    toMain({ type: 'open_local', path: out, how: 'reveal' })
    return { path: out, ...summary }
  },
  // On a server: a backup the owner sent up, only from the uploads folder; checked and set apart.
  restoreCheck: ({ path }) => {
    const uploads = join(dataDir, 'uploads')
    if (!serverMode || typeof path !== 'string' || !resolve(path).startsWith(uploads + sep)) throw new Error(L('Envie o backup pelo navegador, no Tucano do servidor.', 'Send the backup through the browser, on the server’s Tucano.'))
    return stageRestore({ file: path, dataDir, schemaMax: MIGRATIONS.length, app: appVersion })
  },
  // The swap happens at the next start (src/server applies it before the core opens anything).
  restoreApply: () => {
    if (!serverMode) throw new Error(L('Só um Tucano num servidor restaura um backup.', 'Only a Tucano on a server restores a backup.'))
    markRestoreReady(dataDir)
    setTimeout(() => toMain({ type: 'restart' }), 500)
  },
  restoreCancel: () => cancelRestore(dataDir),
  restoreInfo: () => {
    const at = Number(db.meta('restoredAt') ?? 0)
    return at ? { at, routines: Number(db.meta('restoredRoutines') ?? 0) } : null
  },
  openBackups: () => {
    mkdirSync(backups, { recursive: true })
    toMain({ type: 'open_path', path: backups })
  },
  report: ({ week }) => report(db, Date.now(), week),
  usage: () => {
    refreshCodexQuota()
    return usage(db)
  },
  unpairTelegram: () => void (telegram && bg(telegram.unpair(), 'unpairTelegram')),

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
    if (!engineCheck.known) await enginesReady
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
    await enginesReady
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
    return { ok: true, seconds: (Date.now() - started) / 1000, message: L(`${m.id} respondeu em ${secs} s: “${text.trim().slice(0, 60)}”`, `${m.id} answered in ${secs} s: “${text.trim().slice(0, 60)}”`) }
  },

  voiceStatus: () => dictation(),
  transcribe: async ({ id, audio }) => {
    const voice = settings().voice
    return { text: await transcriber.transcribe(id, audio, await dictation(), voice?.detect ? undefined : settings().language) }
  },
  voiceDownload: ({ model }) => {
    if (!Object.hasOwn(VOICE_MODELS, model)) throw new Error(L('Esse modelo de voz não existe.', "That voice model doesn't exist."))
    bg(modelDownload.start(model), 'voiceDownload')
  },
  voiceCancelDownload: () => modelDownload.cancel(),
  voiceRemoveModel: ({ model }) => modelDownload.remove(model),
  cancelTranscribe: ({ id }) => transcriber.cancel(id),

  updateSettings: ({ patch: { jevKey: _computed, telegram: _phone, accounts: _own, ...all } }, ctx) => {
    // Only the settings there are, each of its kind and size: what's kept goes to everyone, every snapshot.
    const bad = settingsPatchError(all)
    if (bad) throw new Error(bad)
    must(ctx.person, { kind: 'settings', keys: Object.keys(all) })
    // The settings' name is the owner's own: only they change it, and never to someone else's.
    // Kept as typed (spaces too: the field saves at each key), less what can't be seen; the person's
    // name is the same, cleaned, under the same rules as setMyName.
    if (all.workspaceName !== undefined) {
      if (ctx.person.role !== 'owner') throw new Error(L('Só o dono muda o próprio nome.', 'Only the owner changes their own name.'))
      if (typeof all.workspaceName !== 'string') throw new Error('Invalid workspaceName')
      all.workspaceName = stripInvisible(all.workspaceName)
      const clean = cleanName(all.workspaceName)
      if (clean.length > MAX_NAME) throw new Error(nameLongError())
      if (clean && people.nameTaken(clean, ctx.person.id)) throw new Error(nameTakenError())
    }
    if (all.theme !== undefined && !isTheme(all.theme)) throw new Error('Invalid theme')
    if (all.language !== undefined && all.language !== 'pt' && all.language !== 'en') throw new Error('Invalid language')
    // Someone else's display preferences are theirs: kept on them, the rest is the Tucano's.
    const patch = people.takePrefs(ctx.person, all)
    if (Object.keys(patch).length === 0) return void emit({ type: 'settings', settings: settings() })
    const why = voiceRefusal(patch.voice)
    if (why) throw new Error(why)
    if (patch.actionRules) patch.actionRules = cleanRules(patch.actionRules)
    db.setSettings(patch)
    // The settings' name is the owner's: what the agents call them.
    if (patch.workspaceName && cleanName(patch.workspaceName)) {
      db.renamePerson(db.ownerId(), cleanName(patch.workspaceName))
      emitPeople()
    }
    if (!serverMode && patch.theme !== undefined) toMain({ type: 'theme', theme: patch.theme })
    if (patch.paused !== undefined) runner.setPaused(patch.paused)
    if (patch.openAtLogin !== undefined) toMain({ type: 'login_item', open: patch.openAtLogin })
    if (patch.onboarding?.done) bg(enginesReady.then(() => ensureTuca()), 'ensureTuca') // skipping the introduction still gets the Tuca
    if (patch.language) toMain({ type: 'lang', lang: patch.language })
    if (!serverMode && patch.notice !== undefined) toMain({ type: 'notice-pref', ...noticePrefs() })
    emit({ type: 'settings', settings: settings() })
  },

  // Validation errors come back to the form; connecting continues in the background.
  addConnector: async ({ input }, ctx) => {
    const id = await connectors.add(input, !serverMode) // a server hands the sign-in page over with Authorize instead
    record(ctx, 'connector.created', id, { name: input.name })
    return id
  },

  removeConnector: ({ id }, ctx) => (record(ctx, 'connector.removed', id, { name: connectors.list().find((c) => c.id === id)?.name }), bg(connectors.remove(id), 'removeConnector')),
  reconnectConnector: ({ id }) => {
    if (!connectors.list().some((c) => c.id === id)) throw new Error(L('Esse conector não existe mais.', 'That connector no longer exists.'))
    bg(connectors.connect(id), 'reconnectConnector')
  },
  setConnectorToken: ({ id, token }) => connectors.setToken(id, token),
  // The store for a screen without the catalog's file (the iPhone app): its entries as data, in the
  // person's language; a connector added by its entry and the values asked, filled in here.
  connectorCatalog: () => ({ categories: CATEGORIES(), entries: catalogView(), added: connectors.list().map((c) => entryOf(c)?.id).filter((id): id is string => !!id) }),
  addCatalogConnector: async ({ id, values }, ctx) => {
    const entry = CATALOG.find((c) => c.id === id)
    if (!entry) throw new Error(L('Esse conector não está mais na loja.', 'That connector is no longer in the store.'))
    const input = catalogInput(entry, Object.fromEntries(Object.entries(values ?? {}).filter((v): v is [string, string] => typeof v[1] === 'string')))
    const added = await connectors.add(input, !serverMode)
    record(ctx, 'connector.created', added, { name: input.name })
    return added
  },
  ownAppGuide: async ({ provider }) => {
    const app = await connectors.ownApp(provider)
    return { guide: ownAppGuide(provider, app.redirectUrl), ...(app.clientId ? { clientId: app.clientId } : {}) }
  },
  ownApp: ({ provider }) => connectors.ownApp(provider),
  setOwnApp: ({ provider, clientId, clientSecret }) => connectors.setOwnApp(provider, { clientId, clientSecret }),
  authorizeConnector: async ({ id }) => {
    const url = await connectors.authorize(id)
    return serverMode && url ? { url } : {}
  },
  finishConnectorAuth: ({ url }) => connectors.finishOAuthFromUrl(url),
  harnessMcps: async () => (await foundMcps()).map(publicMcp),
  importHarnessMcp: async ({ key }, ctx) => {
    const m = (await foundMcps()).find((x) => x.key === key)
    if (!m) throw new Error(L('Esse servidor não está mais na configuração do harness.', "That server is no longer in the harness's configuration."))
    if (m.added) throw new Error(L(`${m.name} já é um conector.`, `${m.name} is already a connector.`))
    const id = await connectors.add(m.input)
    record(ctx, 'connector.created', id, { name: m.name })
    return id
  },
  updateTool: ({ connectorId, name, patch }, ctx) => (record(ctx, 'connector.updated', connectorId, { tool: name, ...patch }), connectors.updateTool(connectorId, name, patch)),
  // The agent's person, admins, and whoever covers for that person now.
  decideApproval: ({ id, decision, reason, always }, ctx) => {
    const a = db.approval(id)
    if (!a) return
    if (!people.canSeeApproval(ctx.person, a)) throw new Error(L('Esse pedido não existe mais.', 'That request no longer exists.'))
    must(ctx.person, { kind: 'approval', agentOwner: agentOwner(db, a.agentId) })
    bg(runner.decide(id, decision, reason?.trim() || undefined, always, ctx.person.id), 'decideApproval')
  },

  // "About me" ('me', from screens of before people) is the person's own scope; no one writes in another's.
  addMemory: ({ scope, text }, ctx) => {
    const of = scope === 'me' ? ctx.person.id : scopePerson(scope)
    if (of && of !== ctx.person.id) throw new Error(L('Só a própria pessoa guarda memórias sobre ela.', 'Only a person keeps memories about themselves.'))
    const final = of ? personScope(of) : scope
    must(ctx.person, { kind: 'memory', scope: final })
    memory.add(final, text)
  },
  editMemory: ({ id, text }, ctx) => (ownMemory(ctx, id), memory.edit(id, text)),
  confirmMemory: ({ id }, ctx) => (ownMemory(ctx, id), memory.confirm(id)),
  decideMemory: ({ id, accept }, ctx) => (ownMemory(ctx, id), memory.decide(id, accept)),
  forgetMemory: ({ id, reason }, ctx) => (ownMemory(ctx, id), memory.forget(id, reason?.trim() || undefined)),
  purgeMemory: ({ id }, ctx) => (ownMemory(ctx, id), memory.purge(id)),
  // The agents read it as the conversation so far: a channel's is its managers' to write.
  editSummary: ({ conversationId, text }, ctx) => {
    manage(ctx, conversationId)
    memory.editSummary(conversationId, text)
    if (db.conversationOwner(conversationId)?.kind === 'channel') record(ctx, 'channel.summary_edited', conversationId)
  },
  summarizeNow: ({ conversationId }, ctx) => (manage(ctx, conversationId), bg(memory.consolidate(conversationId, true), 'summarizeNow')),
  // A thread's summary goes by its conversation's rule: a channel's, its managers'.
  editThreadSummary: ({ rootId, text }, ctx) => (manage(ctx, db.messageConversation(rootId) ?? ''), reachMessage(ctx, rootId), memory.editThreadSummary(rootId, text)),
  summarizeThreadNow: ({ rootId }, ctx) => (manage(ctx, db.messageConversation(rootId) ?? ''), reachMessage(ctx, rootId), bg(memory.consolidateThread(rootId, 'now'), 'summarizeThreadNow')),

  computerAction: ({ agentId, action }, ctx) => {
    admitComputer(ctx.person, action)
    const agent = db.agent(agentId)
    if (!agent) return
    if (action === 'open_folder') {
      mkdirSync(computers.folder(agentId), { recursive: true })
      return toMain({ type: 'open_path', path: computers.folder(agentId) })
    }
    const run = { start: () => computers.ensure(agentId), restart: () => computers.restart(agentId), erase: () => computers.erase(agentId), refresh: () => computers.refresh(agent) }[action]
    void run().catch((e: unknown) => console.error('[computer]', e))
  },
  stopService: ({ agentId, name }) => {
    if (!db.agent(agentId)) throw new Error(L('Esse agente não existe mais.', 'That agent no longer exists.'))
    bg(computers.stopService(agentId, name), 'stopService')
  },
  // Driving a taken-over browser from the panel (Tucano as a server: no window to open).
  browserInput: async ({ agentId, input }, ctx) => {
    if (!serverMode || !chrome) throw new Error(L('Só no Tucano em servidor.', 'Only on Tucano as a server.'))
    mayBrowser(ctx, agentId)
    await chrome.run(agentId, 'input', input)
  },

  browserAction: ({ agentId, action }, ctx) => {
    if (action === 'clear') must(ctx.person, { kind: 'admin' })
    else mayBrowser(ctx, agentId)
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

  // A person's own routine is anyone's to make for themselves; a channel's, the admins'. A connector
  // check (a trigger reading a connector) is the admins' too: connectors are.
  saveRoutine: ({ routine }, ctx) => {
    const prev = people.routineSave(ctx.person, routine)
    const saved = routines.save(routine, ctx.person.id)
    record(ctx, prev ? 'routine.updated' : 'routine.created', saved.id, routineDetail(db, saved))
    return saved
  },
  removeRoutine: ({ id }, ctx) => {
    const r = db.routine(id)
    reach(ctx, r?.conversationId)
    mayRoutine(ctx, r)
    record(ctx, 'routine.removed', id, routineDetail(db, r))
    routines.remove(id)
  },
  // "Me avise": told of a channel routine's runs (one's own routine always tells its person).
  watchRoutine: ({ id, on }, ctx) => {
    people.watch(ctx.person, id)
    db.watchRoutine(id, ctx.person.id, on)
    emit({ type: 'routine', routine: db.routine(id)! })
  },
  wiki: (_, ctx) => {
    const w = wikiFor(ctx)
    const owner = ctx.person.role === 'owner' && heritageAt() > 0
    return {
      dir: ctx.person.role === 'owner' ? wiki.dir : '', // a path on the owner's machine
      pages: w.list(),
      kinds: w.kinds(),
      log: w.log(),
      pending: [...wiki.changes('pending'), ...wiki.changes('conflict')].filter((c) => c.by !== 'review' && seesChange(ctx, c)).length,
      findings: wiki.findings().filter((f) => !f.pages.some((t) => heldFrom(ctx, t))).length,
      server: serverMode,
      graph: w.graph(),
      recent: w.recent(12, seesSource(ctx), historySince(ctx)),
      sources: wikiSourcesFor(ctx, 100_000).length,
      // The owner's, after the heritage: the pages still held for them, and the notice until they've read it.
      ...(owner ? { held: wiki.held(ctx.person.id) } : {}),
      ...(owner && !db.meta('heritageSeen') ? { heritage: { at: heritageAt() } } : {}),
      ...(gitSync.connected ? { git: (({ readOnly, state, lastSync }) => ({ readOnly, state, ...(lastSync ? { lastSync } : {}) }))(gitSync.status()) } : {})
    }
  },
  wikiPage: ({ title }, ctx) => wikiFor(ctx).page(title) ?? null,
  wikiSearch: ({ q }, ctx) => wikiFor(ctx).search(q, 20),
  // A page held for someone else is as good as taken: its name isn't free, and it isn't there to change.
  wikiSave: ({ title, body, kind, expectedHash, rename }, ctx) => {
    if (heldFrom(ctx, rename)) throw new Error(L('Essa página não existe mais.', 'That page no longer exists.'))
    if (heldFrom(ctx, title)) throw new Error(titleUnavailable(title))
    return wiki.save({ title, body, by: ctx.person.id, byName: nameOf(ctx), ...(kind !== undefined ? { kind } : {}), ...(expectedHash !== undefined ? { expectedHash } : {}), ...(rename ? { rename } : {}) })
  },
  wikiRemove: ({ title }, ctx) => (heldFrom(ctx, title) ? undefined : wiki.remove(title, ctx.person.id, nameOf(ctx))),
  wikiHistory: ({ title }, ctx) => (heldFrom(ctx, title) ? [] : wiki.history(title, seesSource(ctx), historySince(ctx), ctx.person.id)),
  // Like editing the page (anyone), but never a version this person can't see: from a source they
  // don't see, of a page held for someone else, or from before the heritage (the owner's).
  wikiRestore: ({ id }, ctx) => {
    const from = wiki.versionSource(id)
    const v = wiki.versionInfo(id)
    if (!v || (from && !seesSource(ctx)(from)) || wiki.heldTitles(ctx.person.id).has(v.key) || (v.heldFor && v.heldFor !== ctx.person.id) || v.at < historySince(ctx)) throw new Error(L('Essa versão não existe mais.', 'That version no longer exists.'))
    const { reheld, ...page } = wiki.restore(id, ctx.person.id, nameOf(ctx))
    // Text from a DM put back on a page the team could read: the page is held again (never published
    // in silence), and its owner hears why.
    if (reheld) {
      notifyAll(L('Página guardada pra você', 'Page held for you'), L(`"${page.title}" tem texto que veio de uma conversa privada: ficou só sua até você liberar pro time.`, `"${page.title}" has text from a private conversation: it's yours alone until you release it to the team.`), undefined, undefined, { to: [db.ownerId()] })
      emit({ type: 'wiki' })
    }
    return page
  },
  // "Liberar pro time": a page held for this person is everyone's from now on.
  wikiRelease: ({ title }, ctx) => {
    const page = wiki.held(ctx.person.id).find((h) => pageKey(h.title) === pageKey(title))
    if (!page) throw new Error(L('Essa página não está guardada pra você.', "That page isn't held for you."))
    wiki.release(page.title)
    record(ctx, 'wiki.released', undefined, { title: page.title })
  },
  heritageSeen: (_, ctx) => {
    must(ctx.person, { kind: 'owner' })
    db.setMeta('heritageSeen', '1')
    emit({ type: 'wiki' })
  },
  wikiSchema: () => wiki.schema(),
  wikiSaveSchema: ({ text }) => wiki.saveSchema(text),
  wikiChanges: ({ state }, ctx) => wiki.changes(state).filter((c) => seesChange(ctx, c)),
  wikiChange: ({ id }, ctx) => {
    const c = wiki.change(id)
    return c && seesChange(ctx, c) ? c : null
  },
  wikiApplyChange: ({ id }, ctx) => (changeInReach(ctx, id), wiki.applyChange(id, nameOf(ctx))),
  wikiRefuseChange: ({ id }, ctx) => (changeInReach(ctx, id), wiki.refuseChange(id)),
  wikiApplyWaiting: (_, ctx) => wiki.applyWaiting(nameOf(ctx), (c) => seesChange(ctx, c)),
  // Undoing puts back what the pages were: from before the heritage, that's the owner's history to restore.
  wikiUndoChange: ({ id }, ctx) => {
    // Said in so many words (before the reach check hides the change as the owner's history).
    if ((wiki.change(id)?.decidedAt ?? Infinity) < historySince(ctx)) throw new Error(L('Só o dono desfaz uma mudança de antes de o Tucano ter mais gente.', 'Only the owner undoes a change from before the Tucano had more people.'))
    changeInReach(ctx, id)
    wiki.undoChange(id, nameOf(ctx), ctx.person.id)
  },
  // A source that came from a conversation is for whoever can see that conversation. An admin sees
  // that one from someone's DM exists (decision 1), and may delete it, never what it says.
  wikiSources: (_, ctx) => wikiSourcesFor(ctx),
  wikiSource: ({ id }, ctx) => {
    const src = wiki.source(id)
    if (!src) return null
    if (people.canSeeFrom(ctx.person, src.origin.conversationId)) return src
    return isAdmin(ctx.person) ? { ...privateSource(src), text: '' } : null
  },
  // The admins', and a DM's own person's for a source from their DM.
  wikiRemoveSource: ({ id }, ctx) => {
    const src = wiki.source(id)
    if (!src) return
    const c = src.origin.conversationId ? db.conversationOwner(src.origin.conversationId) : undefined
    const theirs = !!c && dmOwner(c, db.ownerId()) === ctx.person.id
    if (!isAdmin(ctx.person) && !theirs) throw new Error(L('Só um admin pode fazer isso.', 'Only an admin can do that.'))
    if (!wiki.removeSource(src.id)) return
    // A DM's source leaves no title in the log (its words are the DM's); any other, its title.
    record(ctx, 'wiki.source_removed', src.id, c?.kind === 'dm' ? { private: true } : { title: src.title })
  },
  wikiKeepMessage: async ({ messageId }, ctx) => (reachMessage(ctx, messageId), (await curator.keepMessage(messageId)).length),
  wikiRedoChange: async ({ id }, ctx) => (changeInReach(ctx, id), (await curator.redo(id)).length),
  wikiAddFile: async ({ name: given, data }, ctx) => {
    const name = cleanTitle(given)
    if (!name || /[\u0000-\u001f]/.test(given)) throw new Error(L('Esse nome de arquivo tem caracteres que não valem.', 'That file name has characters that are not allowed.'))
    const buf = Buffer.from(data, 'base64')
    const text = await extractFile(name, buf)
    const src = wiki.addSource({ title: name, text, kind: 'file', file: { name, data: buf }, by: ctx.person.id, status: 'reading' })
    bg(curator.ingest(src.id), 'wikiIngest')
    return src
  },
  wikiAddLink: async ({ url }, ctx) => {
    // The desktop's owner reads any link, a local one too, as always; on a server, or for anyone
    // else, the machine's own network (loopback, LAN, the cloud's metadata) is out of reach.
    const page = await extractLink(url.trim(), !serverMode && ctx.person.role === 'owner' ? fetch : undefined)
    const src = wiki.addSource({ title: page.title, text: `${url.trim()}\n\n${page.text}`, kind: 'link', origin: { url: url.trim() }, by: ctx.person.id, status: 'reading' })
    bg(curator.ingest(src.id), 'wikiIngest')
    return src
  },
  wikiAddNote: ({ text, title }, ctx) => {
    if (title && /\u0000/.test(title)) throw new Error(L('Esse título tem caracteres que não valem.', 'That title has characters that are not allowed.'))
    const first = cleanTitle(text.trim().split('\n')[0]!.replace(/^#+\s*/, '')).slice(0, 60)
    const src = wiki.addSource({ title: cleanTitle(title ?? '') || first || L('Anotação', 'Note'), text, kind: 'note', by: ctx.person.id, status: 'reading' })
    bg(curator.ingest(src.id), 'wikiIngest')
    return src
  },
  wikiOpenOriginal: ({ id }, ctx) => {
    if (!people.canSeeFrom(ctx.person, wiki.source(id)?.origin.conversationId)) return null
    const p = wiki.originalPath(id)
    if (!p || !existsSync(p)) return null
    if (serverMode) return { name: basename(p), data: readFileSync(p).toString('base64') }
    toMain({ type: 'open_path', path: p })
    return null
  },
  wikiIngestAgain: ({ id }, ctx) => {
    if (people.canSeeFrom(ctx.person, wiki.source(id)?.origin.conversationId)) bg(curator.ingest(id), 'wikiIngest')
  },
  wikiReview: (_, ctx) => {
    const r = reviewer.status()
    return { ...r, findings: r.findings.filter((f) => !f.pages.some((t) => heldFrom(ctx, t)) && !(f.change && !seesChange(ctx, f.change))) }
  },
  wikiRunReview: () => {
    bg(reviewer.review().then(() => emit({ type: 'wiki' })), 'wikiRunReview')
    emit({ type: 'wiki' })
  },
  wikiDismissFinding: ({ id }) => wiki.dismissFinding(id),
  wikiImport: ({ dir }, ctx) => wiki.importVault(dir, nameOf(ctx)),
  // On a server: a vault zipped on the person's computer and sent up. Only from the uploads folder
  // the server writes to; unpacked apart, copied in as any vault, then both go.
  wikiImportZip: ({ path }, ctx) => {
    const uploads = join(dataDir, 'uploads')
    if (!serverMode || typeof path !== 'string' || !resolve(path).startsWith(uploads + sep) || !path.toLowerCase().endsWith('.zip')) throw new Error(L('Envie o vault como um arquivo .zip.', 'Send the vault as a .zip file.'))
    const unpacked = mkdtempSync(join(uploads, 'vault-'))
    const zip = zipFromFile(path)
    try {
      return wiki.importVault(extractZip(zip, unpacked), nameOf(ctx))
    } finally {
      zip.close()
      rmSync(unpacked, { recursive: true, force: true })
      rmSync(path, { force: true })
    }
  },
  setWikiCapture: ({ conversationId, on }, ctx) => {
    manage(ctx, conversationId)
    db.setWikiCapture(conversationId, on)
    const c = db.conversation(conversationId)
    if (c) emit({ type: 'conversation', conversation: c })
  },
  setThreads: ({ conversationId, on }, ctx) => {
    manage(ctx, conversationId)
    db.setThreads(conversationId, on)
    const c = db.conversation(conversationId)
    if (c) emit({ type: 'conversation', conversation: c })
  },
  setWikiDir: async ({ dir }) => {
    if (gitSync.connected) throw new Error(L('A pasta da wiki é a do repositório git. Desconecte o git antes de trocar de pasta.', "The wiki's folder is the git repository's. Disconnect git before changing folders."))
    const next = dir?.trim() || wikiHome
    if (!existsSync(next)) throw new Error(L('Essa pasta não existe.', "That folder doesn't exist."))
    db.setSettings({ wikiDir: next === wikiHome ? undefined : next })
    wiki.relocate(next, wikiIndex(next))
    toMain({ type: 'wiki_dir', path: next })
    emit({ type: 'settings', settings: settings() })
    return next
  },
  openWikiFolder: () => (serverMode ? undefined : toMain({ type: 'open_path', path: wiki.dir })),
  wikiGitStatus: () => gitSync.status(),
  wikiGitSetup: ({ url }) => gitSync.setup(url),
  wikiGitTest: () => gitSync.test(),
  // The tested clone becomes the wiki's folder; the folder it had stays as it was (the backup).
  wikiGitConnect: async ({ how }, ctx) => {
    if (process.env['TUCANO_WIKI']) throw new Error(L('A pasta da wiki vem de TUCANO_WIKI: tire a variável pra sincronizar com git.', "The wiki's folder comes from TUCANO_WIKI: unset it to sync with git."))
    if (how !== 'repo' && how !== 'merge') throw new Error(L('Escolha como conectar.', 'Choose how to connect.'))
    const before = { root: wiki.pagesRoot, dir: wiki.dir, held: wiki.heldKeys(), pages: wiki.count() }
    const dir = await gitSync.adopt()
    if (wiki.dir !== dir) {
      db.setSettings({ wikiDir: dir })
      wiki.relocate(dir, wikiIndex(dir))
      toMain({ type: 'wiki_dir', path: dir })
      emit({ type: 'settings', settings: settings() })
    }
    let message: string | undefined
    if (how === 'merge' && before.pages) {
      const m = mergeWiki(before)
      if (m.copies.length) wiki.addNotice({ key: `git-merge:${Date.now()}`, pages: m.copies.filter((c) => c.endsWith('.md')).map((c) => c.split('/').pop()!.replace(/\.md$/i, '')), text: L(`Ao juntar, ${m.copies.length === 1 ? 'um arquivo da wiki antiga tinha' : `${m.copies.length} arquivos da wiki antiga tinham`} o mesmo nome de um do repositório, com outro conteúdo. O do repositório ficou; o da wiki antiga entrou como "(versão do Tucano)".`, `While merging, ${m.copies.length === 1 ? 'a file from the old wiki had' : `${m.copies.length} files from the old wiki had`} the name of one in the repository, with something else in it. The repository's stayed; the old wiki's came in as "(Tucano’s version)".`) })
      message = L(`Tucano: juntou ${m.copied} ${m.copied === 1 ? 'arquivo' : 'arquivos'} da wiki anterior (${nameOf(ctx)})`, `Tucano: merged ${m.copied} ${m.copied === 1 ? 'file' : 'files'} from the previous wiki (${nameOf(ctx)})`)
    }
    record(ctx, 'wiki.git_connected', undefined, { how })
    const st = await gitSync.sync(message ? { message, who: nameOf(ctx) } : {})
    gitSync.start(false)
    return st
  },
  wikiGitSync: ({ write }) => gitSync.sync({ write: !!write }),
  wikiGitDisconnect: async (_, ctx) => {
    await gitSync.disconnect()
    record(ctx, 'wiki.git_disconnected')
    return gitSync.status()
  },

  // The owner's name is also the settings' (what the agents have always called them).
  setMyName: ({ name, about }, ctx) => {
    const clean = cleanName(name)
    if (!clean) throw new Error(L('Diga seu nome.', 'Tell us your name.'))
    if (clean.length > MAX_NAME) throw new Error(nameLongError())
    if (people.nameTaken(clean, ctx.person.id)) throw new Error(nameTakenError())
    db.renamePerson(ctx.person.id, clean)
    if (typeof about === 'string') db.setAbout(ctx.person.id, about.trim().slice(0, 500))
    if (ctx.person.role === 'owner') {
      db.setSettings({ workspaceName: clean })
      emit({ type: 'settings', settings: settings() })
    }
    emitPeople()
  },
  setDelegation: ({ to, until }, ctx) => {
    people.setDelegation(ctx.person, to, until)
    emitPeople()
    emit({ type: 'inbox' })
  },
  createInvite: (p, ctx) => {
    const invite = people.createInvite(ctx.person, p)
    inherit()
    return invite
  },
  revokeInvite: ({ id }, ctx) => people.revokeInvite(ctx.person, id),
  listInvites: () => db.invites(),
  removedPeople: () => db.removedPeople(),
  myDevices: (_, ctx) => db.personKeys(ctx.person.id).map((k) => ({ id: k.hash, label: k.label, createdAt: k.createdAt, ...(k.seenAt ? { seenAt: k.seenAt } : {}), ...(k.hash === ctx.device ? { current: true } : {}) })),
  // One of my devices signs out: its open pages lose the line (a moment after the answer, which may
  // be going down that very line: this page's own device), and the server asks again for my keys.
  // This phone's push handle (from the relay, src/core/push.ts), or none: kept on its device key.
  setPush: ({ handle, tag }, ctx) => {
    if (!ctx.device) throw new Error(L('Só um aparelho conectado com a própria chave recebe avisos.', 'Only a device signed in with its own key gets notifications.'))
    db.setKeyPush(ctx.person.id, ctx.device, handle ? { handle, ...(tag ? { tag } : {}) } : null)
    return { on: push.on }
  },
  removeDevice: ({ id }, ctx) => {
    if (!db.removePersonKey(ctx.person.id, id)) throw new Error(L('Esse aparelho já foi desconectado.', 'That device was already disconnected.'))
    toMain({ type: 'person-changed', id: ctx.person.id })
    emitPeople()
    setTimeout(() => hub.closeDevice(id), 200)
  },
  // Access ends now: keys, open connections, the server's remembered sign-ins. Their agents and
  // routines go to the owner; their DMs and memories wait 30 days for a re-invite (the daily sweep).
  removePerson: ({ id }, ctx) => {
    const { agents, routines: given } = people.remove(ctx.person, id)
    hub.closeFor(id)
    viewing.delete(id)
    toMain({ type: 'person-removed', id })
    for (const a of agents) emit({ type: 'agent', agent: db.agent(a)! })
    for (const r of given) emit({ type: 'routine', routine: db.routine(r)! })
    emitPeople()
    emit({ type: 'inbox' })
  },
  setRole: ({ id, role }, ctx) => {
    people.setRole(ctx.person, id, role)
    // The server's remembered sign-in carries the role: it asks again on the next request.
    toMain({ type: 'person-changed', id })
    emitPeople()
    emit({ type: 'inbox' })
  },
  purgePerson: ({ id }, ctx) => purged([people.purge(ctx.person, id)]),
  // Leaving on one's own: gone now, with what was theirs alone. Their own line closes a moment after
  // the answer, so the app hears that it worked.
  leave: (_, ctx) => {
    const id = ctx.person.id
    const { agents, routines: given, purged: gone } = people.leave(ctx.person)
    purged([gone])
    for (const a of agents) emit({ type: 'agent', agent: db.agent(a)! })
    for (const r of given) emit({ type: 'routine', routine: db.routine(r)! })
    setTimeout(() => {
      hub.closeFor(id)
      viewing.delete(id)
      toMain({ type: 'person-removed', id })
      emitPeople()
      emit({ type: 'inbox' })
    }, 200)
  },
  activity: ({ personId, kind, before }) => db.activity({ personId, kind, before }),
  inbox: (_, ctx) => people.inbox(ctx.person),
  // The window over every window (src/main/notice.ts) reads nothing else: its rules, what waits on
  // this person with the buttons to decide it, and the names to say where each card happened.
  noticeFeed: (_, ctx) => {
    const mine = people.settingsFor(ctx.person, settings())
    return {
      rules: noticeOf(mine),
      language: mine.language,
      agents: db.agents().map((a) => ({ id: a.id, name: a.name, color: a.color, ...(a.customColor ? { customColor: a.customColor } : {}), ...(a.picture ? { picture: a.picture } : {}), ...(a.avatar ? { avatar: a.avatar } : {}) })),
      // Only the conversations this person may see: a card never says the name of someone else's DM.
      conversations: db.conversations().filter((c) => people.canSeeConversation(ctx.person, c)).map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
      inbox: people.inbox(ctx.person)
    }
  },
  answerQuestion: ({ id, text }, ctx) => runner.answer(id, text, ctx.person),
  confirmQuestion: ({ id, ok }, ctx) => runner.confirm(id, ok, ctx.person),
  // A question's decisions, answered on the card one at a time and then sent: by whoever may answer it (Runner.decidable).
  answerDecision: ({ messageId, index, answer }, ctx) => runner.answerDecision(messageId, index, answer, ctx.person),
  submitDecisions: ({ messageId }, ctx) => runner.submitDecisions(messageId, ctx.person),
  runRoutine: ({ id }, ctx) => {
    const r = db.routine(id)
    if (!r) throw new Error(L('Essa rotina não existe mais.', 'That routine no longer exists.'))
    reach(ctx, r.conversationId)
    mayRoutine(ctx, r)
    return routines.runNow(id)
  },

  // While a sign-in or an install is being watched, only that harness: the screens ask every few seconds.
  refreshEngines: () => {
    bg(watched ? engineCheck.recheck(watched) : detect(), 'refreshEngines')
  },

  // Login always happens in the CLI's own flow; the app never sees credentials.
  // Codex and Cline log into the app's own folders (see codexEnv, clineLoginEnv), separate from the user's.
  loginEngine: ({ engine, screen }) => {
    // On a server, for a page or a phone that can show it: the sign-in in a terminal of the server's.
    const shown = screen && engines[engine].installed ? loginTerminal.start(engine) : undefined
    if (shown) return { opened: true, command: ENGINES[engine].login, screen: shown }
    // The sign-in happens in a terminal: check again until it lands, wherever the person is.
    watchEngine(engine, (s) => s.loggedIn)
    return openLogin(engine, engine === 'codex' ? { HOME: codexHome, CODEX_HOME: join(codexHome, '.codex'), ...asdfEnv(engines.codex.path) } : engine === 'cline' ? clineLoginEnv(clineLogin) : {})
  },

  // The introduction's setup with no terminal: Codex or Claude Code downloaded into the app's folder,
  // then the CLI's own sign-in in the browser. The screen asks how it goes every moment.
  setupEngine: ({ engine }) => {
    if (!SETUP_ENGINES.includes(engine as SetupEngine)) throw new Error(L('Só dá pra preparar o Codex ou o Claude Code daqui.', 'Only Codex or Claude Code can be set up from here.'))
    if (serverMode) throw new Error(L('Num servidor, o login é feito no terminal dele.', "On a server, the sign-in happens in its terminal."))
    return fake ? fakeSetup(engine as SetupEngine) : engineSetup.start(engine as SetupEngine)
  },
  // The sign-in on the server's terminal (loginEngine with screen): how it looks now, keys to it, its end.
  loginScreen: () => loginTerminal.current(),
  loginInput: ({ id, text, key, enter }) => loginTerminal.send(id, { ...(text ? { text } : {}), ...(key ? { key: key as LoginKey } : {}), ...(enter ? { enter } : {}) }),
  stopLogin: ({ id }) => loginTerminal.stop(id),
  engineSetupState: () => (fake ? fakeSetupState : engineSetup.current),
  cancelEngineSetup: () => {
    if (fake) return void (fakeSetupState = fakeSetupState && { ...fakeSetupState, state: 'cancelled' })
    engineSetup.cancel()
  },

  // Another login of Claude Code or Codex: a folder of its own, signed into in a terminal like the first.
  addAccount: ({ engine, name }) => {
    if (!ACCOUNT_ENGINES.includes(engine)) throw new Error(L('Só dá pra ter outra conta do Claude Code ou do Codex.', 'Only Claude Code or Codex can have another account.'))
    const account: Account = { id: randomUUID().slice(0, 8), engine, name: name.trim() || ENGINES[engine].label }
    mkdirSync(join(accountDir(dataDir, account.id), '.codex'), { recursive: true })
    db.setSettings({ accounts: [...savedAccounts(), account] })
    bg(
      checkAccounts(account.id).then(() => {
        engineCheck.setAccounts(Object.fromEntries(accountLogins))
        emit({ type: 'settings', settings: settings() })
      }),
      'addAccount'
    )
    emit({ type: 'settings', settings: settings() })
    return account
  },
  loginAccount: ({ id, screen }) => {
    const a = savedAccounts().find((x) => x.id === id)
    if (!a) return { opened: false, command: '' }
    const shown = screen && engines[a.engine].installed ? loginTerminal.start(a.engine, a.id) : undefined
    if (shown) return { opened: true, command: ENGINES[a.engine].login, screen: shown }
    const dir = accountDir(dataDir, a.id)
    watchAccount(a.id)
    return openLogin(a.engine, a.engine === 'claude' ? { CLAUDE_CONFIG_DIR: dir } : { HOME: dir, CODEX_HOME: join(dir, '.codex'), ...asdfEnv(engines.codex.path) })
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
    bg(desktopApps.guide(), 'desktopPermissions')
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

// What a call leaves running in the background: a failure there is logged, never a crash (an
// unhandled rejection ends the process: on a server, everyone's Tucano).
function bg(p: Promise<unknown>, what: string): void {
  p.catch((e: unknown) => console.error(`[core] ${what}`, e))
}
// The last line of defense, for one that slipped through: logged, the core goes on.
process.on('unhandledRejection', (e) => console.error('[core] unhandled rejection', e))

function handle(port: MessagePortMain, req: Request): void {
  const reply = (r: Omit<Extract<Wire, { id: number }>, 'id'>): void => port.postMessage({ id: req.id, ...r } satisfies Wire)
  const fn = api[req.method as Method] as ((p: unknown, ctx: Ctx) => unknown) | undefined
  if (!fn) return reply({ error: `unknown method ${req.method}` })
  if (closing) return reply({ error: L('Este workspace está sendo excluído.', 'This workspace is being deleted.') })
  // Who asks is read now: a person removed since doesn't act anymore.
  const person = hub.personOf(port)
  if (!person) return reply({ error: L('Seu acesso a este Tucano terminou.', 'Your access to this Tucano has ended.') })
  // The params must have the shape the contract says, before any handler reads them.
  const wrong = paramsError(req.method as Method, req.params) ?? limitError(req.method as Method, req.params)
  if (wrong) return reply({ error: wrong })
  Promise.resolve()
    .then(() => (admit(person, req.method as Method), fn(req.params ?? {}, { person, device: hub.deviceOf(port) })))
    .then(
      (result) => reply({ result }),
      (e: unknown) => {
        console.error(`[core] ${req.method}`, e)
        // The page shows it as it comes: in people's words, the raw text stays in the log above
        // (and for anyone but the owner, no path on this machine).
        reply({ error: errorFor(e, person.role === 'owner') })
      }
    )
}

// A desktop's window sends no data (the owner); a server names the person it signed in.
process.parentPort.on('message', (e) => {
  const port = e.ports[0]
  if (!port) return
  if (!hub.add(port, e.data)) return
  port.on('message', (m) => handle(port, m.data as Request))
  port.on('close', () => hub.delete(port))
  port.start()
})

process.on('exit', () => {
  for (const e of Object.values(engineImpls)) e.dispose?.() // the Claude Code processes kept open between replies
  db.close()
})
// The app stops the core with SIGTERM, which by default skips the 'exit' handlers
// above and leaves the agents' Chromes running with nothing to drive them.
process.on('SIGTERM', () => process.exit(0))
