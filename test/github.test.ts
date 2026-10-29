import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { GitHub, githubRepo, pushedRefs } from '../src/core/github'
import { Runner } from '../src/core/runs'

const pkt = (s: string): string => (s.length + 4).toString(16).padStart(4, '0') + s
const Z = '0'.repeat(40)
const A = 'a'.repeat(40)
const push = (...refs: string[]): Buffer => Buffer.concat([Buffer.from(refs.map((r, i) => pkt(`${Z} ${A} ${r}${i === 0 ? '\0report-status' : ''}\n`)).join('') + '0000'), Buffer.from('PACK…')])

describe('reading the repository', () => {
  it('finds the GitHub repo of a folder from its config, worktrees included', () => {
    const main = mkdtempSync(join(tmpdir(), 'repo-'))
    mkdirSync(join(main, '.git', 'worktrees', 'agentes'), { recursive: true })
    writeFileSync(join(main, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/eduwxyz/simula-oab.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')
    writeFileSync(join(main, '.git', 'worktrees', 'agentes', 'commondir'), '../..\n')
    const wt = mkdtempSync(join(tmpdir(), 'wt-'))
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'agentes')}\n`)
    expect(githubRepo(main)).toBe('eduwxyz/simula-oab')
    expect(githubRepo(wt)).toBe('eduwxyz/simula-oab')
    writeFileSync(join(main, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:eduwxyz/outro.git\n')
    expect(githubRepo(main)).toBe('eduwxyz/outro')
  })

  it('reads the branches a push updates', () => {
    expect(pushedRefs(push('refs/heads/agent/x', 'refs/heads/main'))!.map((r) => r.ref)).toEqual(['refs/heads/agent/x', 'refs/heads/main'])
    expect(pushedRefs(Buffer.from('garbage'))).toBeUndefined()
  })
})

describe('the proxy and the PR', () => {
  let db: Db
  let gh: GitHub
  let base: string
  let upstream: { url: string; auth?: string; body?: number }[]
  let posted: string[]
  let folder: string
  let store: Map<string, string>

  const agent = (id: string, handle: string): Agent => ({ id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: true, archived: false })

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-gh-')), 'test.db'))
    folder = mkdtempSync(join(tmpdir(), 'proj-'))
    mkdirSync(join(folder, '.git'))
    writeFileSync(join(folder, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/eduwxyz/simula-oab.git\n')
    db.saveAgent(agent('staff', 'staff'))
    db.saveAgent(agent('rev', 'revisor'))
    db.createConversation({ id: 'c1', kind: 'channel', name: 'simula-oab', members: ['staff', 'rev'] })
    db.saveMessage({ id: 'm0', conversationId: 'c1', author: { kind: 'agent', id: 'staff' }, text: 'Corrigindo.', at: 1 }) // the push notice goes where it's working
    db.setFolders('staff', [{ name: 'simula-oab', path: folder, readOnly: false }])
    db.setFolders('rev', [{ name: 'simula-oab', path: folder, readOnly: true }])
    upstream = []
    posted = []
    store = new Map([['github:token', 'ghp_test']])
    const f = (async (url: string, init?: RequestInit) => {
      if (url === 'https://api.github.com/user') return Response.json({ login: 'eduwxyz' })
      if (url.endsWith('/pulls')) {
        upstream.push({ url, body: JSON.parse(String(init?.body)) })
        return Response.json({ html_url: 'https://github.com/eduwxyz/simula-oab/pull/7', number: 7 }, { status: 201 })
      }
      upstream.push({ url, auth: (init?.headers as Record<string, string>)['Authorization'], body: init?.body ? (init.body as Uint8Array).length : 0 })
      return new Response('ok-from-github', { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result' } })
    }) as unknown as typeof fetch
    gh = new GitHub({ secrets: { get: async (k) => store.get(k), set: async (k, v) => void (v === undefined ? store.delete(k) : store.set(k, v)) }, db, post: (_c, t) => posted.push(t), changed: () => {}, fetch: f })
    await gh.start()
    const server = gh.listen(0)
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(() => gh.stop())

  const url = (agentId: string, path: string): string => `${base}/git/${gh.agentToken(agentId)}/eduwxyz/simula-oab.git/${path}`

  it('adds the token on the way out, and lets through only agent/* branches', async () => {
    const ok = await fetch(url('staff', 'git-receive-pack'), { method: 'POST', body: new Uint8Array(push('refs/heads/agent/lembrete')) })
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('ok-from-github')
    expect(upstream[0]!.url).toBe('https://github.com/eduwxyz/simula-oab.git/git-receive-pack')
    expect(upstream[0]!.auth).toBe(`Basic ${Buffer.from('x-access-token:ghp_test').toString('base64')}`)
    expect(posted).toEqual(['**Staff** publicou `agent/lembrete` no GitHub (eduwxyz/simula-oab).'])

    const main = await fetch(url('staff', 'git-receive-pack'), { method: 'POST', body: new Uint8Array(push('refs/heads/agent/ok', 'refs/heads/main')) })
    const report = await main.text()
    expect(report).toContain('ng refs/heads/main o Tucano aceita so branches agent/<assunto>')
    expect(report).toContain('ng refs/heads/agent/ok o push tinha outra branch fora de agent/*')
    expect(upstream).toHaveLength(1) // nothing reached GitHub
  })

  it('a read-only agent fetches but never pushes; other repos and unknown agents get nothing', async () => {
    expect((await fetch(url('rev', 'info/refs?service=git-upload-pack'))).status).toBe(200)
    expect((await fetch(url('rev', 'info/refs?service=git-receive-pack'))).status).toBe(403)
    expect((await fetch(url('rev', 'git-receive-pack'), { method: 'POST', body: new Uint8Array(push('refs/heads/agent/x')) })).status).toBe(403)
    expect((await fetch(`${base}/git/${gh.agentToken('staff')}/eduwxyz/outro.git/info/refs?service=git-upload-pack`)).status).toBe(403)
    expect((await fetch(`${base}/git/${'0'.repeat(32)}/eduwxyz/simula-oab.git/info/refs`)).status).toBe(403)
  })

  it('abrir_pr becomes an approval; approved, the app opens the PR with the cost of the issue', async () => {
    const ready = { installed: true, loggedIn: true }
    const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
    const gateway = new Gateway()
    await gateway.start()
    const claude: Engine = {
      id: 'claude',
      async *run(turn) {
        if (!turn.prompt.includes('abriu a PR')) await callTool(turn.mcpUrl!, 'abrir_pr', { branch: 'agent/lembrete', titulo: 'Corrige lembrete duplicado', descricao: 'Testado no Core.' })
        yield { type: 'done', text: 'ok', usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 10 } }
      }
    }
    const r = new Runner({ db, engines: { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi') }, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'w-')), gateway, github: gh, computers: { call: async () => ({ result: { content: [] } }) } })
    await r.send('c1', '@staff corrige a OAB-66')
    await r.idle()
    const [ap] = db.approvals()
    expect(ap).toMatchObject({ connectorName: 'GitHub', tool: 'abrir_pr', args: { repo: 'eduwxyz/simula-oab', head: 'agent/lembrete', base: 'main', title: 'Corrige lembrete duplicado' } })
    expect(upstream).toHaveLength(0)
    await r.decide(ap!.id, 'approved')
    await r.idle()
    expect(upstream[0]).toMatchObject({ url: 'https://api.github.com/repos/eduwxyz/simula-oab/pulls', body: { head: 'agent/lembrete', base: 'main' } })
    expect((upstream[0]!.body as unknown as { body: string }).body).toMatch(/Testado no Core\.\n\n---\nFeita por Staff no Tucano · OAB-66: \d+ mil tokens em 1 resposta até aqui\./)
    expect(db.approval(ap!.id)!.outcome).toBe('Abriu a PR #7.')
    const last = db.messages().filter((m: Message) => m.author.kind === 'agent').at(-1)!
    expect(last.run?.work).toBe('OAB-66')
    await gateway.stop()
  })
})
