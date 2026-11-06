import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Connector, EngineId, Routine, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { GUIDE, guideIndex, readGuide, type GuidePage } from '../src/core/guide'
import { Runner } from '../src/core/runs'
import { teamFrom, tucaAgent, tucaInstructions, tucaUpToDate } from '../src/core/tuca'
import { proposalFrom, workspaceState } from '../src/core/tuca-help'
import { screenOf } from '../src/shared/screens'

const ready = { installed: true, loggedIn: true }
const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: { installed: true, loggedIn: false }, opencode: ready, pi: ready, gemini: ready, cursor: ready, grok: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
const linear: Connector = { id: 'c-lin', name: 'Linear', kind: 'remote', url: 'https://mcp.linear.app/mcp', auth: 'oauth', status: 'needs_auth', error: 'O Linear pediu pra entrar de novo.', tools: [] }
const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({ id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: 'Você tria tickets.', modelId: 'sonnet', effort: 'low', limit: 100_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
const lia = agent('a1', 'lia', { grants: { 'c-lin': 'read' } })
const theo = agent('a2', 'theo')
const ctx = {
  agents: [lia, theo],
  conversations: [
    { id: 'dm1', kind: 'dm' as const, name: 'a1', members: ['a1'] },
    { id: 'eng', kind: 'channel' as const, name: 'engenharia', members: ['a1'] }
  ],
  connectors: [linear],
  usable: (id: string) => id === 'sonnet' || id === 'haiku'
}

describe("the Tuca's proposals for what exists", () => {
  it('proposes only what changes in an agent, checked like the screens check it', () => {
    const r = proposalFrom('propor_ajuste', { agente: '@lia', modelo: 'haiku', esforco: 'low', instrucoes: 'Você tria tickets.', conectores: [{ conector: 'linear', nivel: 'escrita' }], limite: 200000, motivo: 'Mais barato' }, ctx)
    expect(r.proposal).toEqual({ kind: 'agent', agentId: 'a1', changes: { modelId: 'haiku', grants: { 'c-lin': 'read_write' }, limit: 200000 }, before: { modelId: 'sonnet', grants: { 'c-lin': 'read' }, limit: 100000 }, reason: 'Mais barato' })
    expect(proposalFrom('propor_ajuste', { agente: 'lia', esforco: 'low' }, ctx).error).toContain('Nada mudaria')
    expect(proposalFrom('propor_ajuste', { agente: 'nina', web: false }, ctx).error).toContain('"nina"')
    expect(proposalFrom('propor_ajuste', { agente: 'lia', modelo: 'gpt-5.5' }, ctx).error).toContain('não dá pra usar')
    expect(proposalFrom('propor_ajuste', { agente: 'lia', conectores: [{ conector: 'Jira' }] }, ctx).error).toContain('"Jira"')
    // An empty list takes every connector away.
    expect(proposalFrom('propor_ajuste', { agente: 'lia', conectores: [] }, ctx).proposal).toMatchObject({ changes: { grants: {} } })
  })

  it('proposes a routine in the DM or a channel the agent is in', () => {
    const dm = proposalFrom('propor_rotina', { agente: 'lia', nome: 'Resumo', pedido: 'Resuma os tickets do dia.', dias: [1, 2, 3, 4, 5, 5, 9], hora: '09:00' }, ctx)
    expect(dm.proposal).toEqual({ kind: 'routine', routine: { name: 'Resumo', agentId: 'a1', conversationId: 'dm1', prompt: 'Resuma os tickets do dia.', schedule: { days: [1, 2, 3, 4, 5], time: '09:00' }, enabled: true } })
    expect(proposalFrom('propor_rotina', { agente: 'lia', nome: 'R', pedido: 'p', dias: [1], hora: '9h', onde: '#engenharia' }, ctx).error).toContain('HH:MM')
    expect(proposalFrom('propor_rotina', { agente: 'lia', nome: 'R', pedido: 'p', dias: [1], hora: '09:30', onde: '#engenharia', uma_vez: true }, ctx).proposal).toMatchObject({ routine: { conversationId: 'eng', schedule: { once: true } } })
    expect(proposalFrom('propor_rotina', { agente: 'theo', nome: 'R', pedido: 'p', dias: [1], hora: '09:30', onde: 'engenharia' }, ctx).error).toContain('não está em #engenharia')
    // Theo has no DM yet: it opens when the routine is applied.
    expect(proposalFrom('propor_rotina', { agente: 'theo', nome: 'R', pedido: 'p', dias: [0], hora: '18:00' }, ctx).proposal).toMatchObject({ routine: { conversationId: '' } })
  })

  it('proposes a channel with agents that exist and a name that is free', () => {
    expect(proposalFrom('propor_canal', { nome: 'Suporte VIP', agentes: ['lia', '@theo', 'lia'], tema: 'Clientes grandes' }, ctx).proposal).toEqual({ kind: 'channel', name: 'suporte-vip', members: ['a1', 'a2'], topic: 'Clientes grandes' })
    expect(proposalFrom('propor_canal', { nome: 'Engenharia', agentes: ['lia'] }, ctx).error).toContain('Já existe')
    expect(proposalFrom('propor_canal', { nome: 'novo', agentes: [] }, ctx).error).toContain('quais agentes')
  })
})

describe('a team, proposed at once', () => {
  const each = (nome: string, extra: Record<string, unknown> = {}) => ({ nome, funcao: 'Pesquisa', instrucoes: `Você é ${nome}.`, ...extra })
  const tctx = { usable: (id: string) => id === 'sonnet', fallbackModel: 'sonnet', connectors: [linear], channels: ['geral'] }

  it('makes each agent like propor_agente, and the channel they share', () => {
    const r = teamFrom({ agentes: [each('Rafa', { conectores: [{ conector: 'Linear' }] }), each('Bia', { modelo: 'opus' })], canal: { nome: 'Lançamento', tema: 'O lançamento do app' }, motivo: 'Dividir o trabalho' }, tctx)
    expect(r.proposal).toMatchObject({ kind: 'team', channel: { name: 'lancamento', topic: 'O lançamento do app' }, reason: 'Dividir o trabalho' })
    const team = r.proposal as Extract<typeof r.proposal, { kind: 'team' }>
    expect(team.agents.map((a) => [a.name, a.modelId, a.grants])).toEqual([['Rafa', 'sonnet', { 'c-lin': 'read' }], ['Bia', 'sonnet', {}]])
  })

  it('says what to fix', () => {
    expect(teamFrom({ agentes: [each('Rafa')] }, tctx).error).toContain('de 2 a 8')
    expect(teamFrom({ agentes: [each('Rafa'), each('rafa')] }, tctx).error).toContain('Dois agentes')
    expect(teamFrom({ agentes: [each('Rafa'), { nome: 'Bia' }] }, tctx).error).toContain('Agente 2')
    expect(teamFrom({ agentes: [each('Rafa'), each('Bia')], canal: { nome: 'Geral' } }, tctx).error).toContain('#geral')
    expect(teamFrom({ agentes: [each('Rafa'), each('Bia')] }, tctx).proposal).not.toHaveProperty('channel') // a team without a channel
  })
})

describe('what the Tuca sees of the workspace', () => {
  const routine: Routine = { id: 'r1', name: 'Bom dia', agentId: 'a1', conversationId: 'eng', prompt: 'p', schedule: { days: [1], time: '09:00' }, enabled: true, nextAt: Date.UTC(2026, 10, 10, 12), lastAt: Date.UTC(2026, 10, 3, 12), lastMessageId: 'm9', createdAt: 1 }
  const state = (area?: string): string =>
    workspaceState(area, {
      settings: { ...settings, paused: true },
      connectors: [linear],
      agents: [lia, { ...theo, used: 120_000 }],
      conversations: ctx.conversations,
      routines: [routine],
      approvals: [],
      failures: [{ agentId: 'a1', conversationId: 'eng', at: Date.UTC(2026, 10, 5, 12), status: 'failed', error: 'O Linear pediu pra entrar de novo.' }],
      lastRun: () => ({ status: 'failed', error: 'Sem acesso ao Linear.' }),
      now: Date.UTC(2026, 10, 5, 13)
    })

  it('says what is wrong: sign-ins, connector errors, used-up limits, failed routines and replies', () => {
    const all = state()
    expect(all).toContain('PAUSADO')
    expect(all).toContain('Codex: instalado, sem login')
    expect(all).toContain('Linear: pede login · O Linear pediu pra entrar de novo.')
    expect(all).toContain('Theo (@theo): Claude Code · Sonnet')
    expect(all).toContain('(ESGOTADO)')
    expect(all).toContain('Bom dia (Lia, #engenharia): ligada')
    expect(all).toContain('(failed: Sem acesso ao Linear.)')
    expect(all).toContain('Lia · #engenharia · failed: O Linear pediu pra entrar de novo.')
  })

  it('shows one area when asked', () => {
    const only = state('conectores')
    expect(only).toContain('## Conectores')
    expect(only).not.toContain('## Agentes')
    expect(only).not.toContain('## Motores')
  })
})

describe('the guide and the screen links', () => {
  const pages: GuidePage[] = [{ slug: 'rotinas', title: 'Rotinas', summary: 'Pedidos que rodam sozinhos.', body: 'Em **Rotinas**…' }]
  it('lists the pages and reads one, or says which exist', () => {
    expect(guideIndex(pages)).toBe('- rotinas: Rotinas. Pedidos que rodam sozinhos.')
    expect(readGuide('Rotinas', pages)).toEqual({ text: '# Rotinas\n\nEm **Rotinas**…' })
    expect(readGuide('nada', pages)).toMatchObject({ error: true, text: expect.stringContaining('rotinas') })
    for (const p of GUIDE) expect(p.title && p.summary && p.body).toBeTruthy()
  })

  it('turns #abrir/ links into screens, and nothing else', () => {
    expect(screenOf('#abrir/conectores')?.screen?.view).toBe('connectors')
    expect(screenOf('#abrir/configuracoes/modelos')?.screen).toMatchObject({ view: 'settings', tab: 'modelos' })
    expect(screenOf('#abrir/agente/lia')).toEqual({ agentHandle: 'lia' })
    expect(screenOf('#abrir/nada')).toBeUndefined()
    expect(screenOf('https://example.com')).toBeUndefined()
    expect(screenOf('#wiki/Pessoas')).toBeUndefined()
  })
})

it('brings a Tuca made before up to date, unless his instructions were rewritten', () => {
  const old = { ...tucaAgent('sonnet', [], 1000), role: 'Monta agentes', instructions: 'Você é o Tuca, quem monta os agentes deste time. A pessoa te conta…' }
  expect(tucaUpToDate(old)).toMatchObject({ role: 'Te ajuda com o Tucano', instructions: tucaInstructions() })
  expect(tucaUpToDate({ ...old, role: 'Meu ajudante', instructions: 'Outra coisa.' })).toBeUndefined()
  expect(tucaUpToDate(tucaAgent('sonnet', [], 1000))).toBeUndefined() // already current
})

it('finds the replies that failed lately, with their error and nothing they said', () => {
  const db = new Db(':memory:')
  db.createConversation({ id: 'c', kind: 'channel', name: 'c', members: [] })
  const now = Date.now()
  db.saveMessage({ id: 'ok', conversationId: 'c', author: { kind: 'agent', id: 'a1' }, text: 'tudo certo', at: now - 1000, run: { status: 'done', steps: [] } })
  db.saveMessage({ id: 'bad', conversationId: 'c', author: { kind: 'agent', id: 'a1' }, text: 'SEGREDO DA CONVERSA', at: now - 500, run: { status: 'failed', steps: [], error: 'O motor caiu.' } })
  db.saveMessage({ id: 'old', conversationId: 'c', author: { kind: 'agent', id: 'a1' }, text: 'x', at: now - 10 * 86_400_000, run: { status: 'failed', steps: [], error: 'Antigo.' } })
  expect(db.recentFailures(now - 7 * 86_400_000)).toEqual([{ agentId: 'a1', conversationId: 'c', at: now - 500, status: 'failed', error: 'O motor caiu.' }])
})

describe('the Tuca helping, in a conversation', () => {
  let db: Db
  let gateway: Gateway
  let runner: Runner
  const turns: Turn[] = []
  const results: unknown[] = []
  let calls: { tool: string; args: Record<string, unknown> }[] = []

  // Calls each planned tool through the gateway, as a model would.
  const scripted: Engine = {
    id: 'claude',
    async *run(turn) {
      turns.push(turn)
      if (turn.mcpUrl && calls.length) {
        const client = new Client({ name: 'scripted', version: '0' })
        await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl)))
        for (const c of calls) results.push(await client.callTool({ name: c.tool, arguments: c.args }))
        await client.close()
      }
      yield { type: 'done', text: 'pronto', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
    }
  }

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
    gateway = new Gateway()
    await gateway.start()
    turns.length = 0
    results.length = 0
    calls = []
    const engines: Record<EngineId, Engine> = { claude: scripted, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok') }
    runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), gateway, connectors: { list: () => [linear], call: async () => ({ content: [] }) } })
    db.saveAgent(lia)
    const tuca = tucaAgent('sonnet', ['lia'], 1000)
    db.saveAgent(tuca)
    db.createConversation({ id: 'd1', kind: 'dm', name: tuca.id, members: [tuca.id] })
  })

  afterEach(async () => {
    await gateway.stop()
  })

  it('has the guide, the screens and the team with handles in his prompt, and reads the guide and the workspace', async () => {
    calls = [
      { tool: 'ler_guia', args: { pagina: GUIDE[0]?.slug ?? 'nada' } },
      { tool: 'ver_estado', args: { area: 'conectores' } }
    ]
    await runner.send('d1', 'por que a Lia não responde?')
    await runner.idle()
    expect(turns[0]!.prompt).toContain('## O guia do Tucano')
    expect(turns[0]!.prompt).toContain('(#abrir/conectores)')
    expect(turns[0]!.prompt).toContain('Lia (@lia)')
    const texts = results.map((r) => (r as { content: { text: string }[] }).content[0]!.text)
    if (GUIDE.length) expect(texts[0]).toContain(`# ${GUIDE[0]!.title}`)
    expect(texts[1]).toContain('Linear: pede login')
    const reply = db.messages().find((m) => m.author.kind === 'agent' && m.text === 'pronto')!
    expect(reply.run?.steps.map((s) => s.label)).toEqual(expect.arrayContaining(['Olhou o workspace']))
  })

  it('proposes a change as a card, and nothing changes', async () => {
    calls = [{ tool: 'propor_ajuste', args: { agente: 'lia', modelo: 'haiku', motivo: 'Mais barato pra triagem' } }]
    await runner.send('d1', 'a Lia está cara')
    await runner.idle()
    const reply = db.messages().find((m) => m.author.kind === 'agent' && m.text === 'pronto')!
    expect(reply.run?.proposal).toEqual({ kind: 'agent', agentId: 'a1', changes: { modelId: 'haiku' }, before: { modelId: 'sonnet' }, reason: 'Mais barato pra triagem' })
    expect(db.agent('a1')?.modelId).toBe('sonnet')
  })

  it('lets any agent propose, but only the Tuca reads the guide and the workspace', async () => {
    db.createConversation({ id: 'd2', kind: 'dm', name: 'a1', members: ['a1'] })
    calls = [
      { tool: 'ver_estado', args: {} },
      { tool: 'ler_guia', args: { pagina: 'rotinas' } },
      { tool: 'propor_canal', args: { nome: 'suporte', agentes: ['lia'] } }
    ]
    await runner.send('d2', 'cria um canal de suporte comigo')
    await runner.idle()
    expect(turns[0]!.prompt).not.toContain('## O guia do Tucano')
    expect(results.slice(0, 2).map((r) => (r as { isError?: boolean }).isError)).toEqual([true, true])
    const reply = db.messages().find((m) => m.author.kind === 'agent' && m.text === 'pronto')!
    expect(reply.run?.proposal).toMatchObject({ kind: 'channel', name: 'suporte', members: ['a1'] })
  })
})
