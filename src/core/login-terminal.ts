// A harness's sign-in on a server, from the page or the phone: the CLI's own login command runs in
// a terminal of the server's (a pseudo-terminal, via `script`), and its screen goes to whoever asked,
// as text (vt-screen.ts), with what they type going back. The person signs in on the provider's own
// page, as in a terminal: Tucano passes keys and shows the screen, and never handles the login
// itself (the CLI saves it where it always does).
//
// Per harness, the way in that works with no browser on this machine: a device code where the CLI
// has one (Codex, Grok), a code to paste back (Claude Code, Gemini, OpenCode's providers), or a page
// the CLI watches on its own (Cursor). Pi signs in inside its own screen, with /login.
import { randomUUID } from 'node:crypto'
import { L } from '../shared/lang'
import type { EngineId, LoginKey, LoginScreen } from '../shared/types'

export type { LoginKey, LoginScreen }
import { Screen, signInHints } from './vt-screen'


export interface Pty {
  write: (data: string) => void
  output: (on: (text: string) => void) => void
  exit: Promise<number>
  kill: () => void
}

// The command, the variables and the first hint, per harness.
export function loginCommand(engine: EngineId): { args: string[]; env: Record<string, string>; hint?: string } {
  switch (engine) {
    case 'claude':
      return { args: ['auth', 'login'], env: {} }
    case 'codex':
      return { args: ['login', '--device-auth'], env: {} }
    case 'hermes':
      return { args: ['setup'], env: {}, hint: L('Escolha o provedor com as setas e toque em Enter; a chave vai no prompt seguinte.', 'Pick the provider with the arrows and tap Enter; the key goes in the next prompt.') }
    case 'grok':
      return { args: ['login', '--device-auth'], env: {} }
    case 'cursor':
      return { args: ['login'], env: { NO_OPEN_BROWSER: '1' } }
    case 'cline':
      return { args: ['auth'], env: {}, hint: L('Escolha o provedor com as setas e toque em Enter: Cline (a conta, no navegador) ou um provedor com a sua chave.', 'Pick the provider with the arrows and tap Enter: Cline (the account, in the browser) or a provider with your key.') }
    case 'opencode':
      return { args: ['auth', 'login'], env: {}, hint: L('Escolha o provedor com as setas e toque em Enter.', 'Pick the provider with the arrows and tap Enter.') }
    case 'antigravity':
      return { args: [], env: {}, hint: L('Abra o link, entre com sua conta Google e cole aqui o código que a página mostrar.', 'Open the link, sign in with your Google account and paste here the code the page shows.') }
    case 'pi':
      return { args: [], env: {}, hint: L('Escreva /login e toque em Enter (de novo, se aparecer a lista de comandos); depois escolha o provedor com as setas.', 'Type /login and tap Enter (again, if the list of commands shows up); then pick the provider with the arrows.') }
  }
}

export const KEYS: Record<LoginKey, string> = { enter: '\r', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', esc: '\x1b', tab: '\t', backspace: '\x7f', space: ' ' }

export const COLS = 64
export const ROWS = 24

export interface LoginDeps {
  // The CLI in a pseudo-terminal of this size; undefined when this system has none to offer.
  spawn: (bin: string, args: string[], env: NodeJS.ProcessEnv, size: { cols: number; rows: number }) => Pty | undefined
  bin: (engine: EngineId) => string
  env: (engine: EngineId, account?: string) => NodeJS.ProcessEnv // where the login goes
  signedIn: (engine: EngineId, account?: string) => Promise<boolean>
  timeoutMs?: number
  pollMs?: number
  pasteGapMs?: number
}

export class LoginTerminal {
  private screen?: Screen
  private session?: Omit<LoginScreen, 'lines' | 'url' | 'code'>
  private pty?: Pty
  private poll?: ReturnType<typeof setInterval>
  private late?: ReturnType<typeof setTimeout>

  constructor(private deps: LoginDeps) {}

  current(): LoginScreen | null {
    if (!this.session || !this.screen) return null
    return { ...this.session, lines: this.screen.lines(), ...signInHints(this.screen) }
  }

  // A new sign-in; one at a time (a second one ends the first). Undefined: no terminal here.
  start(engine: EngineId, account?: string): LoginScreen | undefined {
    this.stop()
    const cmd = loginCommand(engine)
    const screen = new Screen(COLS, ROWS)
    const pty = this.deps.spawn(this.deps.bin(engine), cmd.args, { ...this.deps.env(engine, account), ...cmd.env }, { cols: COLS, rows: ROWS })
    if (!pty) return undefined
    const id = randomUUID()
    this.screen = screen
    this.pty = pty
    this.session = { id, engine, ...(account ? { account } : {}), ...(cmd.hint ? { hint: cmd.hint } : {}), state: 'running' }
    pty.output((text) => this.session?.id === id && screen.write(text))
    // Signed in: done, whatever the CLI does next (Gemini and Pi stay open on their own screens).
    this.poll = setInterval(() => {
      void this.deps.signedIn(engine, account).then((yes) => yes && this.finish(id, 'done'), () => {})
    }, this.deps.pollMs ?? 4_000)
    this.poll.unref?.()
    this.late = setTimeout(() => this.finish(id, 'failed', L('O login passou de 15 minutos. Comece de novo.', 'The sign-in went past 15 minutes. Start again.')), this.deps.timeoutMs ?? 15 * 60_000)
    this.late.unref?.()
    void pty.exit.then(async () => {
      if (this.session?.id !== id || this.session.state !== 'running') return
      const yes = await this.deps.signedIn(engine, account).catch(() => false)
      if (yes) return this.finish(id, 'done')
      const last = screen.lines().filter(Boolean).slice(-2).join(' ').trim()
      this.finish(id, 'failed', last ? L(`O login não terminou: ${last}`, `The sign-in didn't finish: ${last}`) : L('O login não terminou.', "The sign-in didn't finish."))
    })
    return this.current()!
  }

  // What the person typed: text (a code, a /login), then Enter when asked; or one key.
  async send(id: string, input: { text?: string; key?: LoginKey; enter?: boolean }): Promise<LoginScreen | null> {
    if (this.session?.id !== id || this.session.state !== 'running' || !this.pty) return this.current()
    if (input.text) this.pty.write(input.text.replace(/[\r\n]+/g, ' ').trim())
    // Enter on its own, a moment later: a program reading keys takes text and Enter together as a paste.
    if (input.text && input.enter) await new Promise((r) => setTimeout(r, this.deps.pasteGapMs ?? 150))
    if (input.enter) this.pty?.write(KEYS.enter)
    if (input.key && KEYS[input.key]) this.pty.write(KEYS[input.key])
    return this.current()
  }

  stop(id?: string): void {
    if (!this.session || (id && this.session.id !== id)) return
    if (this.session.state === 'running') this.finish(this.session.id, 'cancelled')
  }

  private finish(id: string, state: LoginScreen['state'], error?: string): void {
    if (this.session?.id !== id || this.session.state !== 'running') return
    clearInterval(this.poll)
    clearTimeout(this.late)
    this.session = { ...this.session, state, ...(error ? { error } : {}) }
    this.pty?.kill()
    this.pty = undefined
  }
}
