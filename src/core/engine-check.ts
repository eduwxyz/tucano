// What the harnesses' CLIs say about themselves (installed, signed in, the models they list),
// checked without holding anything up: the last check is kept on disk, so the app opens on
// it, and the next one runs behind. A check takes seconds and starts a dozen processes, so
// whoever asks while one runs shares it instead of starting another.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { ENGINE_IDS, type EngineId, type EngineStatus } from '../shared/types'
import { codexModels, detectClaude, detectCodex, detectCursor, detectAntigravity, detectGrok, detectCline, detectHermes, detectOpenCode, detectPi, type CodexModel } from './engines/detect'
import { withInstallDirs } from './platform'

export interface AccountLogin {
  loggedIn: boolean
  detail?: string
}

export interface EngineFindings {
  engines: Record<EngineId, EngineStatus>
  listed: Partial<Record<EngineId, string[]>>
  codexCatalog: CodexModel[]
  accounts?: Record<string, AccountLogin> // the other logins of Settings › Accounts
}

// One harness, checked again on its own (after a sign-in or an install in a terminal).
export interface OneFinding {
  status: EngineStatus
  listed?: string[]
  codexCatalog?: CodexModel[]
}

// Every harness this version knows: a list written out by hand here left the newest one out, and the
// screens read a status that wasn't there until the first check ended.
const IDS: EngineId[] = ENGINE_IDS

// Before the first check ever: nothing known yet, and the screens can say so.
export const checkingFindings = (): EngineFindings => ({
  engines: Object.fromEntries(IDS.map((e) => [e, { installed: false, loggedIn: false, checking: true }])) as Record<EngineId, EngineStatus>,
  listed: {},
  codexCatalog: []
})

export interface EngineCheckDeps {
  all: () => Promise<Omit<EngineFindings, 'accounts'>>
  one: (engine: EngineId) => Promise<OneFinding>
  // Runs inside the same check, so whoever waits on it gets the accounts too.
  after?: (found: EngineFindings, engine?: EngineId) => Promise<Partial<EngineFindings> | void>
  file?: string // where the last check is kept
}

export class EngineCheck {
  current: EngineFindings
  // Whether `current` came from a check, this run's or the last one's, rather than a guess.
  known: boolean
  private all?: Promise<EngineFindings>
  private one = new Map<EngineId, Promise<EngineFindings>>()

  constructor(private deps: EngineCheckDeps) {
    const kept = deps.file ? readKept(deps.file) : undefined
    this.current = kept ?? checkingFindings()
    this.known = !!kept
  }

  // Every harness. A call while a check runs gets that check.
  detect(): Promise<EngineFindings> {
    return (this.all ??= this.run(async () => ({ ...(await this.deps.all()), accounts: this.current.accounts })).finally(() => (this.all = undefined)))
  }

  // Only this harness, unless every one is being checked already.
  recheck(engine: EngineId): Promise<EngineFindings> {
    if (this.all) return this.all
    let p = this.one.get(engine)
    if (!p) {
      p = this.run(async () => {
        const f = await this.deps.one(engine)
        const listed = { ...this.current.listed }
        // As detectEngines lists them: Codex only with a catalog, Claude Code never.
        if (f.listed && (engine !== 'codex' || f.listed.length)) listed[engine] = f.listed
        else delete listed[engine]
        return { ...this.current, engines: { ...this.current.engines, [engine]: f.status }, listed, ...(engine === 'codex' ? { codexCatalog: f.codexCatalog ?? [] } : {}) }
      }, engine).finally(() => this.one.delete(engine))
      this.one.set(engine, p)
    }
    return p
  }

  // Kept as the latest (and on disk) once `after` has had its say.
  private async run(find: () => Promise<EngineFindings>, engine?: EngineId): Promise<EngineFindings> {
    const found = await find()
    const more = (await this.deps.after?.(found, engine)) ?? {}
    this.current = { ...found, ...more }
    this.known = true
    this.save()
    return this.current
  }

  // The accounts change apart from a check too (one signed in, one added).
  setAccounts(accounts: Record<string, AccountLogin>): void {
    this.current = { ...this.current, accounts }
    if (this.known) this.save()
  }

  private save(): void {
    if (!this.deps.file) return
    try {
      // Written aside and moved in: a crash mid-write can't leave half a file to read next time.
      writeFileSync(`${this.deps.file}.tmp`, JSON.stringify(this.current))
      renameSync(`${this.deps.file}.tmp`, this.deps.file)
    } catch (e) {
      console.warn('[engines] could not keep the last check', e)
    }
  }
}

function readKept(file: string): EngineFindings | undefined {
  try {
    const f = JSON.parse(readFileSync(file, 'utf8')) as Partial<EngineFindings>
    if (!f.engines || typeof f.engines !== 'object') return undefined
    // A harness this version knows and the last check didn't: unknown until checked.
    const engines = Object.fromEntries(IDS.map((e) => [e, f.engines![e] ?? { installed: false, loggedIn: false, checking: true }])) as Record<EngineId, EngineStatus>
    return { engines, listed: f.listed ?? {}, codexCatalog: f.codexCatalog ?? [], ...(f.accounts ? { accounts: f.accounts } : {}) }
  } catch {
    return undefined
  }
}

// One harness's own check, the same detectEngines runs for each.
export async function detectEngine(engine: EngineId, codexHome: string, clineLogin: string): Promise<OneFinding> {
  // A CLI installed while the app is open may have created its folder just now.
  process.env['PATH'] = withInstallDirs(process.env['PATH'] ?? '')
  switch (engine) {
    case 'claude':
      return { status: await detectClaude() }
    case 'codex': {
      const status = await detectCodex(codexHome)
      // A gateway serves its own list (asked when picking); a plan or an API key gets Codex's catalog.
      const codexCatalog = status.loggedIn && status.route !== 'gateway' && status.path ? await codexModels(status.path, codexHome) : []
      return { status, codexCatalog, listed: codexCatalog.map((m) => m.slug) }
    }
    case 'opencode':
      return found(await detectOpenCode())
    case 'pi':
      return found(await detectPi())
    case 'antigravity':
      return found(await detectAntigravity())
    case 'cursor':
      return found(await detectCursor())
    case 'grok':
      return found(await detectGrok())
    case 'cline':
      return found(await detectCline(clineLogin))
    case 'hermes':
      return found(await detectHermes())
  }
}
const found = (r: { status: EngineStatus; models: string[] }): OneFinding => ({ status: r.status, listed: r.models })
