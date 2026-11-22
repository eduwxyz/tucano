import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, BrowserElement, BrowserReply, Settings } from '../src/shared/types'
import { Browser, browserTools, CHAT_ONLY_BROWSER_TOOLS, type BrowserHost } from '../src/core/browser'
import { Vault } from '../src/core/vault'
import { loginOrigin, pageOrigin } from '../src/shared/vault'
import { systemPrompt } from '../src/core/context'
import { Db } from '../src/core/db'
import { downloaded, downloadsFolder, freeName, land, listDownloads, partialFolder, refuse, safeName } from '../src/core/downloads'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { plainCipher, Secrets } from '../src/core/secrets'

const PASSWORD = 'luz-S3nha!secreta'

const lia = (extra: Partial<Agent> = {}): Agent => ({
  id: 'lia-0001',
  name: 'Lia',
  handle: 'lia',
  role: 'Contas',
  color: 'rose',
  instructions: '',
  modelId: 'opus',
  effort: 'high',
  limit: 1_000_000,
  used: 0,
  grants: {},
  memory: 'read',
  computer: false,
  browser: true,
  archived: false,
  ...extra
})

const el = (ref: number, role: string, label: string, extra: Partial<BrowserElement> = {}): BrowserElement => ({ ref, role, label, inView: true, ...extra })
const text = (r: { content: unknown[] }): string => (r.content.filter((c) => (c as { type: string }).type === 'text') as { text: string }[]).map((c) => c.text).join('\n')
const ctx = { conversationId: 'c1', messageId: 'm1' }

// A sign-in page in memory; a click on "Baixar fatura" downloads, the way the hosts do (through .partial).
function fakeHost(dataDir: string): { host: BrowserHost; calls: { op: string; args?: Record<string, unknown> }[]; page: { url: string; download?: { name: string; bytes: number } } } {
  const page: { url: string; download?: { name: string; bytes: number } } = { url: 'https://conta.luz.com.br/entrar' }
  const calls: { op: string; args?: Record<string, unknown> }[] = []
  const elements = [el(1, 'campo', 'Email'), el(2, 'campo', 'Senha'), el(3, 'botão', 'Entrar'), el(4, 'link', 'Baixar fatura')]
  const host: BrowserHost = async (agentId, op, args) => {
    calls.push({ op, args })
    const here: BrowserReply = { url: page.url, title: 'Luz', w: 1280, h: 800 }
    if (op === 'open') page.url = String(args?.['url'])
    if (op === 'snapshot') return { ...here, elements }
    if (op === 'click' && args?.['ref'] === 4 && page.download) {
      const folder = downloadsFolder(dataDir, agentId)
      const { name, bytes } = page.download
      if (bytes > 1000) refuse(folder, name, bytes)
      else {
        mkdirSync(partialFolder(folder), { recursive: true })
        const part = join(partialFolder(folder), 'guid-1')
        writeFileSync(part, Buffer.alloc(bytes, 7))
        // It lands a moment after the click returns: the action waits for it.
        setTimeout(() => land(folder, part, name, 'https://conta.luz.com.br/fatura.pdf?token=abc', 1000), 150)
      }
    }
    return here
  }
  return { host, calls, page }
}

describe("an agent's downloads folder", () => {
  let folder: string
  beforeEach(() => {
    folder = join(mkdtempSync(join(tmpdir(), 'ad-dl-')), 'lia')
    mkdirSync(partialFolder(folder), { recursive: true })
  })

  it('lands a whole file under its own name, never over another, and refuses one over the limit', () => {
    const part = (n: string, bytes: number): string => {
      const p = join(partialFolder(folder), n)
      writeFileSync(p, Buffer.alloc(bytes, 1))
      return p
    }
    expect(land(folder, part('a', 10), 'fatura.pdf', 'https://x.com/f.pdf?sig=1', 100)).toMatchObject({ name: 'fatura.pdf', size: 10, url: 'https://x.com/f.pdf' })
    expect(land(folder, part('b', 20), 'fatura.pdf', undefined, 100)).toMatchObject({ name: 'fatura (2).pdf' })
    expect(land(folder, part('c', 101), 'enorme.zip', undefined, 100)).toMatchObject({ refused: 'too-big', name: 'enorme.zip' })
    expect(existsSync(join(partialFolder(folder), 'c'))).toBe(false)
    expect(listDownloads(folder).map((f) => f.name).sort()).toEqual(['fatura (2).pdf', 'fatura.pdf'])
    expect(safeName('../../etc/passwd')).toBe('passwd')
    expect(safeName('.bashrc')).toBe('bashrc')
    expect(freeName(folder, 'novo.pdf')).toBe('novo.pdf')
  })

  it('gives back only a plain file right in the folder, by its listed name', () => {
    writeFileSync(join(folder, 'fatura.pdf'), 'pdf')
    const outside = join(folder, '..', 'tucano.db')
    writeFileSync(outside, 'db')
    symlinkSync(outside, join(folder, 'atalho.pdf'))
    expect(downloaded(folder, 'fatura.pdf')).toMatchObject({ size: 3 })
    for (const name of ['../tucano.db', outside, 'sub/fatura.pdf', '.log', '', 'atalho.pdf']) expect(downloaded(folder, name), name).toEqual({ error: 'outside' })
    expect(downloaded(folder, 'nada.pdf')).toEqual({ error: 'missing' })
    expect(downloaded(folder, 'fatura.pdf', 2)).toEqual({ error: 'too-big' })
  })
})

describe('downloads and files in the browser tools', () => {
  let db: Db
  let dataDir: string
  let events: CoreEvent[]
  let fake: ReturnType<typeof fakeHost>
  let browser: Browser

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ad-nav-files-'))
    db = new Db(join(dataDir, 'test.db'))
    db.saveAgent(lia())
    events = []
    fake = fakeHost(dataDir)
    browser = new Browser({ host: fake.host, db, dataDir, emit: (e) => events.push(e), me: () => 'Edu', downloadWaitMs: 3000 })
  })

  it('a click that downloads says what landed, after waiting for it; one over the limit is refused', async () => {
    fake.page.download = { name: 'fatura-nov.pdf', bytes: 500 }
    const r = await browser.call(lia(), 'navegador_clicar', { alvo: '#4' }, ctx)
    expect(text(r.result)).toContain('Baixou: fatura-nov.pdf')
    expect(text(r.result)).toContain('navegador_anexar')
    expect(readFileSync(join(downloadsFolder(dataDir, 'lia-0001'), 'fatura-nov.pdf'))).toHaveLength(500)

    fake.page.download = { name: 'gigante.zip', bytes: 5000 }
    expect(text((await browser.call(lia(), 'navegador_clicar', { alvo: '#4' }, ctx)).result)).toContain('Download recusado: gigante.zip')
    expect(existsSync(join(downloadsFolder(dataDir, 'lia-0001'), 'gigante.zip'))).toBe(false)

    const list = text((await browser.call(lia(), 'navegador_baixados', {}, ctx)).result)
    expect(list).toContain('fatura-nov.pdf')
    expect(list).toContain('https://conta.luz.com.br/fatura.pdf') // where it came from, without its token
    expect(list).not.toContain('token=abc')
    expect(list).toContain('gigante.zip') // among the refused
  })

  it('posts a downloaded file in the chat as an artifact, and nothing from outside its folder', async () => {
    const folder = downloadsFolder(dataDir, 'lia-0001')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'fatura-nov.pdf'), '%PDF-1.4 fatura')
    const r = await browser.call(lia(), 'navegador_anexar', { arquivo: 'fatura-nov.pdf', titulo: 'Fatura de novembro' }, ctx)
    expect(r.result.isError).toBeFalsy()
    expect(r.artifact).toMatchObject({ kind: 'pdf', name: 'fatura-nov.pdf', title: 'Fatura de novembro', conversationId: 'c1', messageId: 'm1', agentId: 'lia-0001', size: 15 })
    expect(readFileSync(join(dataDir, 'artifacts', r.artifact!.id, 'fatura-nov.pdf'), 'utf8')).toBe('%PDF-1.4 fatura')
    expect(events.some((e) => e.type === 'artifact' && e.artifact.id === r.artifact!.id)).toBe(true)

    // Another agent's downloads, the app's data, a link out of the folder: none of it.
    mkdirSync(downloadsFolder(dataDir, 'theo-001'), { recursive: true })
    writeFileSync(join(downloadsFolder(dataDir, 'theo-001'), 'dele.pdf'), 'x')
    symlinkSync(join(dataDir, 'test.db'), join(folder, 'banco.pdf'))
    for (const arquivo of ['../theo-001/dele.pdf', '../../test.db', join(dataDir, 'test.db'), 'banco.pdf', '.log', 'nada.pdf']) {
      const no = await browser.call(lia(), 'navegador_anexar', { arquivo }, ctx)
      expect(no.result.isError, arquivo).toBe(true)
      expect(no.artifact, arquivo).toBeUndefined()
    }
  })

  it('clearing the browser takes its downloads too', async () => {
    const folder = downloadsFolder(dataDir, 'lia-0001')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'fatura.pdf'), 'x')
    await browser.action(lia(), 'clear')
    expect(existsSync(folder)).toBe(false)
  })

  it('is not offered on a computer lent to a server, where there is no chat or saved login to use', () => {
    expect(browserTools().map((t) => t.name)).toEqual(expect.arrayContaining(['navegador_baixados', 'navegador_anexar', 'navegador_login']))
    expect([...CHAT_ONLY_BROWSER_TOOLS].sort()).toEqual(['navegador_anexar', 'navegador_baixados', 'navegador_login'])
  })
})

const owner = { id: 'owner', admin: true, team: false }

describe('saved logins', () => {
  let db: Db
  let dataDir: string
  let logins: Vault
  let events: CoreEvent[]
  let fake: ReturnType<typeof fakeHost>
  let browser: Browser
  const logged: string[] = []

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ad-nav-login-'))
    db = new Db(join(dataDir, 'test.db'))
    db.saveAgent(lia())
    logins = new Vault({ db, secrets: new Secrets(db, plainCipher), readOp: async (ref) => (ref === 'op://Casa/Luz/senha' ? PASSWORD : '') })
    await logins.saveLogin(owner, { site: 'conta.luz.com.br/entrar', username: 'edu@exemplo.com', password: PASSWORD, agents: ['lia-0001'] })
    events = []
    fake = fakeHost(dataDir)
    browser = new Browser({ host: fake.host, db, dataDir, emit: (e) => events.push(e), me: () => 'Edu', logins })
    logged.length = 0
    for (const m of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')))
  })
  afterEach(() => vi.restoreAllMocks())

  it('binds a login to one exact origin, https only', () => {
    expect(loginOrigin('conta.luz.com.br/entrar?x=1')).toBe('https://conta.luz.com.br')
    expect(loginOrigin('https://conta.luz.com.br:8443/a')).toBe('https://conta.luz.com.br:8443')
    expect(loginOrigin('http://conta.luz.com.br')).toBeUndefined() // a password never over plain http
    expect(loginOrigin('http://localhost:3000')).toBe('http://localhost:3000')
    expect(loginOrigin('javascript:alert(1)')).toBeUndefined()
    expect(pageOrigin('https://conta.luz.com.br/entrar#a')).toBe('https://conta.luz.com.br')
  })

  it('the person sees sites and usernames; the agent only which sites', async () => {
    expect(logins.logins(owner)).toMatchObject([{ origin: 'https://conta.luz.com.br', username: 'edu@exemplo.com', agents: ['lia-0001'] }])
    expect(logins.loginSites('lia-0001')).toEqual(['https://conta.luz.com.br'])
    expect(logins.loginSites('theo-001')).toEqual([])
    expect(JSON.stringify(db.secretKeys('vault-login:'))).not.toContain(PASSWORD)
    expect(JSON.stringify(db.vaultLogins())).not.toContain(PASSWORD)

    const settings = { workspaceName: 'Edu', context: '' }
    const conv = { id: 'c1', kind: 'channel' as const, name: 'contas', members: ['lia-0001'], createdAt: 0 }
    const p = systemPrompt({ agent: lia(), settings, conversation: conv, peers: [], browser: true, browserLogins: browser.loginSites('lia-0001') })
    expect(p).toContain('https://conta.luz.com.br')
    expect(p).toContain('navegador_login')
    expect(p).toContain('código de verificação por email')
    expect(p).toContain('navegador_anexar')
    expect(p).not.toContain(PASSWORD)
    expect(p).not.toContain('edu@exemplo.com')
  })

  it('types the saved login into the fields named by number, and the password never comes back', async () => {
    const r = await browser.call(lia(), 'navegador_login', { usuario: '#1', senha: '#2' }, ctx)
    expect(r.result.isError).toBeFalsy()
    const fills = fake.calls.filter((c) => c.op === 'fill').map((c) => c.args)
    expect(fills).toEqual([
      { ref: 1, text: 'edu@exemplo.com', origin: 'https://conta.luz.com.br', password: false },
      { ref: 2, text: PASSWORD, origin: 'https://conta.luz.com.br', password: true }
    ])
    expect(r.detail).toBe('https://conta.luz.com.br')
    const everything = JSON.stringify({ r, events, views: browser.list(), logged })
    expect(everything).not.toContain(PASSWORD)
  })

  it('reads a 1Password reference only when it types it', async () => {
    const [l] = logins.logins(owner)
    await logins.saveLogin(owner, { id: l!.id, site: 'https://conta.luz.com.br', password: 'op://Casa/Luz/senha', agents: l!.agents })
    expect(logins.logins(owner)).toMatchObject([{ username: 'edu@exemplo.com' }]) // the username kept
    await browser.call(lia(), 'navegador_login', { senha: '2' }, ctx)
    expect(fake.calls.find((c) => c.op === 'fill')!.args).toMatchObject({ ref: 2, text: PASSWORD, password: true })
  })

  it('refuses any origin but the exact one it was saved for', async () => {
    for (const url of ['https://conta.luz.com.br.golpe.com/entrar', 'https://luz.com.br/entrar', 'http://conta.luz.com.br/entrar', 'https://conta.luz.com.br:444/entrar', 'about:blank']) {
      fake.page.url = url
      const r = await browser.call(lia(), 'navegador_login', { usuario: '#1', senha: '#2' }, ctx)
      expect(r.result.isError, url).toBe(true)
      expect(text(r.result), url).toContain('https://conta.luz.com.br') // says where it has one
    }
    expect(fake.calls.some((c) => c.op === 'fill')).toBe(false)
  })

  it('each sign-in goes in the Cofre’s log, for whoever the work was', async () => {
    await browser.call(lia(), 'navegador_login', { usuario: '#1', senha: '#2' }, { ...ctx, personId: 'owner' })
    expect(db.vaultUses()).toMatchObject([{ name: 'https://conta.luz.com.br', agentId: 'lia-0001', via: 'login', personId: 'owner' }])
  })

  it('removed, it is gone for good', async () => {
    await logins.removeLogin(owner, logins.logins(owner)[0]!.id)
    expect(logins.loginSites('lia-0001')).toEqual([])
    expect(await logins.loginFor('lia-0001', 'https://conta.luz.com.br', {})).toBeUndefined()
    expect(db.secretKeys('vault-login:')).toEqual([])
  })
})

describe('the runner with a saved login', () => {
  it('the password reaches the page and nothing else: not the prompt, the tool results, the steps or the messages', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ad-nav-login-run-'))
    const db = new Db(join(dataDir, 'test.db'))
    db.saveAgent(lia())
    db.createConversation({ id: 'c1', kind: 'channel', name: 'contas', members: ['lia-0001'] })
    const logins = new Vault({ db, secrets: new Secrets(db, plainCipher) })
    await logins.saveLogin(owner, { site: 'https://conta.luz.com.br', username: 'edu@exemplo.com', password: PASSWORD, agents: ['lia-0001'] })
    const fake = fakeHost(dataDir)
    const browser = new Browser({ host: fake.host, db, dataDir, emit: () => {}, me: () => 'Edu', logins })
    const ready = { installed: true, loggedIn: true }
    const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
    const gateway = new Gateway()
    await gateway.start()
    const turns: Turn[] = []
    const results: unknown[] = []
    const claude: Engine = {
      id: 'claude',
      async *run(turn) {
        turns.push(turn)
        results.push(await callTool(turn.mcpUrl!, 'navegador_abrir', { url: 'https://conta.luz.com.br/entrar' }))
        results.push(await callTool(turn.mcpUrl!, 'navegador_login', { usuario: '#1', senha: '#2' }))
        results.push(await callTool(turn.mcpUrl!, 'navegador_ler', {}))
        yield { type: 'done', text: 'Entrei.', usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 10 } }
      }
    }
    const r = new Runner({ db, engines: { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes'), endpoint: fakeEngine('endpoint') }, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'w-')), gateway, browser })
    await r.send('c1', '@lia entra na conta de luz')
    await r.idle()
    await gateway.stop()

    expect(fake.calls.filter((c) => c.op === 'fill').map((c) => c.args?.['text'])).toEqual(['edu@exemplo.com', PASSWORD])
    expect(turns[0]!.system).toContain('https://conta.luz.com.br')
    const reply = db.messages().filter((m) => m.conversationId === 'c1').at(-1)!
    expect(reply.run!.steps.map((s) => s.label)).toContain('Preencheu o login salvo')
    expect(reply.run!.steps.find((s) => s.label === 'Preencheu o login salvo')!.detail).toBe('https://conta.luz.com.br')
    const seen = JSON.stringify({ turns: turns.map(({ signal: _s, ...t }) => t), results, messages: db.messages(), approvals: db.approvals() })
    expect(seen).not.toContain(PASSWORD)
  })
})
