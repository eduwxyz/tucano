// How far an agent goes on its own, for what isn't a connector: a risky click in its browser and a risky
// action in one of the person's apps. Through the real runner and gateway; the page and the app are fakes.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, BrowserElement, BrowserReply, Settings } from '../src/shared/types'
import { Browser, type BrowserHost } from '../src/core/browser'
import { DesktopApps, type Cli, type Envelope } from '../src/core/apps'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const base: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' } as unknown as Settings

const lia = (extra: Partial<Agent> = {}): Agent => ({ id: 'lia-0001', name: 'Lia', handle: 'lia', role: 'Vídeos', color: 'rose', instructions: '', modelId: 'opus', effort: 'high', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false, ...extra })

// A page in memory with a "Publicar" button: what Chromium would do, recorded.
function fakePage(): { host: BrowserHost; clicks: () => number } {
  const page = { url: '', title: '' }
  const elements: BrowserElement[] = [{ ref: 3, role: 'botão', label: 'Publicar', inView: true }]
  const calls: string[] = []
  const host: BrowserHost = async (_agentId, op, args) => {
    calls.push(op)
    const here: BrowserReply = { url: page.url, title: page.title, frame: Buffer.from('jpeg').toString('base64'), w: 1280, h: 800, shown: false }
    if (op === 'open') Object.assign(page, { url: String(args?.['url']), title: 'Studio' })
    if (op === 'snapshot') return { ...here, frame: undefined, elements }
    return { ...here, url: page.url, title: page.title }
  }
  return { host, clicks: () => calls.filter((c) => c === 'click').length }
}

// The Notes app with an "Apagar" button, as agent-desktop describes it.
function fakeNotes(): { cli: Cli; clicks: () => number } {
  let snap = 0
  const calls: string[][] = []
  const cli: Cli = async (args) => {
    calls.push(args)
    const ok = (data: Record<string, unknown>): Envelope => ({ ok: true, data })
    if (args[0] === 'snapshot') {
      snap++
      return ok({ snapshot_id: `s${snap}`, window: { title: 'Notas' }, tree: { role: 'window', name: 'Notas', children: [{ role: 'button', name: 'Apagar', ref_id: `@s${snap}:e1` }] } })
    }
    if (args[0] === 'click' || args[0] === 'press') return ok({})
    if (args[0] === 'list-apps') return ok({ apps: [{ name: 'Notas' }] })
    return { ok: false, error: { message: 'unknown' } }
  }
  return { cli, clicks: () => calls.filter((c) => c[0] === 'click').length }
}

let db: Db
let gateway: Gateway
let settings: Settings
let results: unknown[]
const textOf = (r: unknown): string => ((r as { content: { type: string; text: string }[] }).content.find((c) => c.type === 'text')?.text ?? '')
const stepLabels = (): string[] => db.messages().filter((m) => m.author.kind === 'agent').flatMap((m) => m.run?.steps.map((s) => s.label) ?? [])

// A "model" that does the calls given, once per reply that isn't the one after a decision.
const scripted = (calls: [string, Record<string, unknown>][]): Engine => ({
  id: 'claude',
  async *run(turn) {
    if (!/aprovou|recusou/.test(turn.prompt)) for (const [name, args] of calls) results.push(await callTool(turn.mcpUrl!, name, args))
    yield { type: 'done', text: 'ok', usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 } }
  }
})
const others = { codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-auto-'))
  db = new Db(join(dir, 'test.db'))
  settings = { ...base }
  results = []
  gateway = new Gateway()
  await gateway.start()
})
afterEach(async () => {
  await gateway.stop()
})

describe('a risky click in the browser', () => {
  const publish: [string, Record<string, unknown>][] = [
    ['navegador_abrir', { url: 'https://studio.youtube.com/video/1' }],
    ['navegador_clicar', { alvo: 'Publicar' }]
  ]
  const run = async (agent: Agent): Promise<{ clicks: number }> => {
    db.saveAgent(agent)
    db.createConversation({ id: 'd1', kind: 'dm', name: 'lia-0001', members: ['lia-0001'] })
    const page = fakePage()
    const browser = new Browser({ host: page.host, db, dataDir: mkdtempSync(join(tmpdir(), 'ad-auto-nav-')), emit: () => {}, me: () => 'Edu' })
    const r = new Runner({ db, engines: { claude: scripted(publish), ...others }, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'w-')), gateway, browser })
    await r.send('d1', 'publica o vídeo')
    await r.idle()
    return { clicks: page.clicks() }
  }

  it('asks on normal, as it always did', async () => {
    const { clicks } = await run(lia({ browser: true }))
    expect(db.approvals()[0]).toMatchObject({ connectorId: 'navegador', tool: 'navegador_clicar', state: 'pending' })
    expect(clicks).toBe(0)
  })

  it('with no guardrails and the guard off, clicks right away and says so in the step', async () => {
    const { clicks } = await run(lia({ browser: true, autonomy: 'free', outsideGuard: false }))
    expect(db.approvals()).toEqual([])
    expect(clicks).toBe(1)
    expect(stepLabels()).toContain('Clicou (sem pedir: autonomia)')
    expect(textOf(results[1])).not.toMatch(/aprovação/)
  })

  it('with no guardrails and the guard on, still asks: a page is someone else\'s text', async () => {
    const { clicks } = await run(lia({ browser: true, autonomy: 'free' }))
    expect(db.approvals()[0]).toMatchObject({ tool: 'navegador_clicar', state: 'pending' })
    expect(clicks).toBe(0)
  })

  it('"faz sozinho" for risky clicks, with the guard off, clicks on normal too', async () => {
    const { clicks } = await run(lia({ browser: true, actionRules: { browser: 'auto' }, outsideGuard: false }))
    expect(db.approvals()).toEqual([])
    expect(clicks).toBe(1)
  })

  it('"nunca" never clicks and asks nothing', async () => {
    const { clicks } = await run(lia({ browser: true, autonomy: 'free', actionRules: { browser: 'off' } }))
    expect(db.approvals()).toEqual([])
    expect(clicks).toBe(0)
    expect(textOf(results[1])).toMatch(/desligados pra você/)
  })
})

describe('a risky action in an app', () => {
  const remove: [string, Record<string, unknown>][] = [
    ['app_ver', { app: 'Notas' }],
    ['app_clicar', { app: 'Notas', alvo: 'Apagar' }]
  ]
  const run = async (agent: Agent): Promise<{ clicks: number }> => {
    db.saveAgent(agent)
    db.createConversation({ id: 'd1', kind: 'dm', name: 'lia-0001', members: ['lia-0001'] })
    const notes = fakeNotes()
    const apps = new DesktopApps(notes.cli, { platform: 'darwin' })
    const r = new Runner({ db, engines: { claude: scripted(remove), ...others }, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'w-')), gateway, apps })
    await r.send('d1', 'apaga a nota')
    await r.idle()
    return { clicks: notes.clicks() }
  }
  const notesRw: Agent['apps'] = [{ name: 'Notas', level: 'read_write' }]

  it('asks on normal, as it always did', async () => {
    const { clicks } = await run(lia({ apps: notesRw }))
    expect(db.approvals()[0]).toMatchObject({ connectorId: 'apps', tool: 'app_clicar', state: 'pending' })
    expect(clicks).toBe(0)
  })

  it('with no guardrails and the guard off, does it right away, once', async () => {
    const { clicks } = await run(lia({ apps: notesRw, autonomy: 'free', outsideGuard: false }))
    expect(db.approvals()).toEqual([])
    expect(clicks).toBe(1)
    expect(stepLabels()).toContain('Fez (sem pedir: autonomia)')
  })

  it('with no guardrails and the guard on, still asks: what an app shows is someone else\'s text', async () => {
    const { clicks } = await run(lia({ apps: notesRw, autonomy: 'free' }))
    expect(db.approvals()[0]).toMatchObject({ tool: 'app_clicar', state: 'pending' })
    expect(clicks).toBe(0)
  })

  it('"nunca" never does it and asks nothing', async () => {
    const { clicks } = await run(lia({ apps: notesRw, autonomy: 'free', actionRules: { apps: 'off' } }))
    expect(db.approvals()).toEqual([])
    expect(clicks).toBe(0)
  })
})
