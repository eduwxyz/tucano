// "Seu iPhone" in Settings › Celular: the home link (home-link.ts) wired to the desktop app. It
// serves one workspace, the one on screen when it was turned on, as its owner; stays on across
// restarts until turned off; and keeps its certificate (so a phone paired once stays paired) and
// its port in the app's data folder.
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MessageChannelMain, type UtilityProcess } from 'electron'
import type { Person } from '../shared/types'
import { HomeLink, type HomeCore } from './home-link'
import { homeHost } from './home-phone-net'
import { fingerprintOf, makeCertificate, matches } from './self-signed'

export type HomePhoneState = { on: boolean; address: string; connected: number; workspace: string; error?: string }

type Saved = { on: boolean; port: number; workspace?: string }
const FIRST_PORT = 7350

export function homePhone(deps: {
  dir: string // the app's data folder
  selected: () => { id: string; name: string; dataDir: string }
  workspace: (id: string) => { id: string; name: string; dataDir: string } | undefined
  child: (id: string) => Promise<UtilityProcess | undefined> // the workspace's core, started if needed
  publish: (state: HomePhoneState) => void
}) {
  const configFile = join(deps.dir, 'home-link.json')
  const tlsDir = join(deps.dir, 'home-link')
  let saved: Saved = { on: false, port: FIRST_PORT }
  try {
    saved = { ...saved, ...(JSON.parse(readFileSync(configFile, 'utf8')) as Partial<Saved>) }
  } catch {}
  const save = (): void => writeFileSync(configFile, JSON.stringify(saved), { mode: 0o600 })

  // The certificate, made once: a new one would leave every paired phone talking to a stranger.
  function tls(): { key: string; cert: string; fingerprint: string } {
    mkdirSync(tlsDir, { recursive: true, mode: 0o700 })
    const keyFile = join(tlsDir, 'key.pem')
    const certFile = join(tlsDir, 'cert.pem')
    if (existsSync(keyFile) && existsSync(certFile)) {
      const pair = { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') }
      if (matches(pair)) return { ...pair, fingerprint: fingerprintOf(pair.cert) }
    }
    const made = makeCertificate('Tucano', [homeHost()])
    writeFileSync(keyFile, made.key, { mode: 0o600 })
    writeFileSync(certFile, made.cert, { mode: 0o600 })
    chmodSync(keyFile, 0o600)
    return made
  }

  // Questions to the core that wait for its answer (a key's person, a phone's key): by id.
  const waits = new Map<string, (msg: Record<string, unknown>) => void>()
  async function ask(msg: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown> | undefined> {
    const child = await deps.child(current())
    if (!child) return undefined
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => waits.delete(id) && resolve(undefined), timeoutMs)
      waits.set(id, (m) => (clearTimeout(timer), waits.delete(id), resolve(m)))
      child.postMessage({ ...msg, id })
    })
  }

  const current = (): string => saved.workspace ?? deps.selected().id
  let child: UtilityProcess | undefined // the served workspace's core, once known
  const core: HomeCore = {
    auth: async (key) => {
      const r = await ask({ type: 'auth', key })
      return r?.['person'] ? (r['person'] as Person) : r?.['removed'] ? { removed: true } : undefined
    },
    deviceKey: async (label) => {
      const r = await ask({ type: 'device-key', person: null, label })
      return (r?.['data'] as { key?: string } | undefined)?.key
    },
    open: (person, onMessage) => {
      const { port1, port2 } = new MessageChannelMain()
      port2.on('message', (e) => onMessage(e.data))
      port2.start()
      child?.postMessage({ person }, [port1])
      return { post: (data) => port2.postMessage(data), close: () => port2.close() }
    },
    dataDir: () => deps.workspace(current())?.dataDir ?? deps.selected().dataDir
  }

  let link: HomeLink | undefined
  let error: string | undefined
  const state = (): HomePhoneState => ({
    on: saved.on && !!link?.running,
    address: link?.running ? `${homeHost()}:${link.port}` : '',
    connected: link?.connected ?? 0,
    workspace: deps.workspace(current())?.name ?? '',
    ...(error ? { error } : {})
  })
  const changed = (): void => deps.publish(state())

  async function start(): Promise<void> {
    child = await deps.child(current())
    if (!child) throw new Error('workspace not running')
    link ??= new HomeLink({ tls: tls(), codesFile: join(deps.dir, 'home-link-codes.json'), core: () => core, onChange: changed })
    saved.port = await link.start(saved.port, homeHost())
  }

  return {
    state,
    async set(on: boolean): Promise<HomePhoneState> {
      error = undefined
      if (on) {
        saved = { ...saved, on: true, workspace: saved.on ? current() : deps.selected().id }
        try {
          await start()
        } catch (e) {
          error = e instanceof Error ? e.message : String(e)
          saved.on = false
        }
      } else {
        saved = { ...saved, on: false, workspace: undefined }
        await link?.stop()
      }
      save()
      changed()
      return state()
    },
    // A one-time code for the owner's phone: the QR code's link.
    async code(): Promise<{ link: string; expiresAt: number }> {
      if (!link?.running) await this.set(true)
      if (!link?.running) throw new Error(error ?? 'not running')
      return link.makeCode()
    },
    // The core's answers to the questions above; true when the message was one.
    fromCore(msg: { type?: string; id?: string }): boolean {
      if ((msg.type === 'auth-result' || msg.type === 'device-key-result') && msg.id && waits.has(msg.id)) {
        waits.get(msg.id)!(msg as Record<string, unknown>)
        return true
      }
      return false
    },
    // A notification of the served workspace: to the phones on the line.
    notify(workspaceId: string, msg: { title?: string; body?: string; conversationId?: string }): void {
      if (link?.running && workspaceId === current()) link.deliver({ notify: { title: String(msg.title ?? ''), body: String(msg.body ?? ''), conversationId: msg.conversationId } })
    },
    // The served workspace's core started again (it crashed, or the app restarted it): the link follows.
    coreStarted(workspaceId: string, c: UtilityProcess): void {
      if (workspaceId === current()) child = c
    },
    // At launch: back on if it was.
    async restore(): Promise<void> {
      if (!saved.on) return
      try {
        await start()
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      changed()
    },
    async quit(): Promise<void> {
      await link?.stop()
    }
  }
}
