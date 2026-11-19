// A goal ("/objetivo …" in a channel): the agents pass the turn to each other past the usual replies in a
// row, until one marks it done, or it stops by itself (src/core/goals.ts).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { GOAL_MAX_TURNS, goalText, sameReply } from '../src/core/goals'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const agent = (id: string): Agent => ({ id, name: id[0]!.toUpperCase() + id.slice(1), handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 10_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false })

let db: Db
let settings: Settings
let gateway: Gateway
let turns: Turn[]

// Each agent's replies, in order: a string is said as is; a function may call tools first.
type Line = string | ((t: Turn) => Promise<string>)
function team(script: Record<string, (n: number) => Line>): Runner {
  const counts: Record<string, number> = {}
  const claude: Engine = {
    id: 'claude',
    async *run(t) {
      const who = Object.keys(script).find((id) => t.system.includes(`Você é ${id[0]!.toUpperCase() + id.slice(1)} (@${id})`))
      if (!who) return yield* fakeEngine('claude', { delayMs: 1 }).run(t) // the router, the memory, the title
      turns.push(t)
      const n = (counts[who] = (counts[who] ?? 0) + 1)
      const line = script[who]!(n)
      const text = typeof line === 'string' ? line : await line(t)
      yield { type: 'text', delta: text }
      yield { type: 'done', text, usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 1 } }
    }
  }
  const engines = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes'), endpoint: fakeEngine('endpoint') } as Record<EngineId, Engine>
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-goal-')), gateway })
}

const notes = (): string[] => db.messages().filter((m) => m.author.kind === 'system').map((m) => m.text)
const said = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  turns = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'off', chainDepth: 3 } as unknown as Settings
  db.saveAgent(agent('dev'))
  db.saveAgent(agent('rev'))
  db.createConversation({ id: 'c', kind: 'channel', name: 'site', members: ['dev', 'rev'] })
  gateway = new Gateway()
  await gateway.start()
})

afterEach(async () => {
  await gateway.stop()
})

describe('reading a goal', () => {
  it('takes /objetivo and /goal at the start, and tells a reply apart from the same one said again', () => {
    expect(goalText('/objetivo landing page aprovada')).toBe('landing page aprovada')
    expect(goalText('  /Goal ship it')).toBe('ship it')
    expect(goalText('/objetivo')).toBe('')
    expect(goalText('o objetivo é outro')).toBeUndefined()
    expect(sameReply('Corrigi. @rev', 'corrigi @rev!')).toBe(true)
    expect(sameReply('Corrigi o botão. @rev', 'Corrigi o título. @rev')).toBe(false)
  })
})

describe('a goal in a channel', () => {
  it('goes back and forth past the usual replies in a row until one marks it done', async () => {
    const r = team({
      dev: (n) => (n === 1 ? 'Fiz a página. @rev revisa?' : 'Corrigi o botão. @rev confere?'),
      rev: (n) =>
        n === 1
          ? 'Falta o botão de inscrição. @dev corrige?'
          : async (t) => {
              await callTool(t.mcpUrl!, 'concluir_objetivo', { resultado: 'Página com botão, revisada.' })
              return 'Aprovado: página com botão de inscrição.'
            }
    })
    await r.send('c', '/objetivo @dev faz a landing page; o revisor revisa até aprovar')
    await r.idle()
    expect(said().map((m) => m.text)).toEqual(['Fiz a página. @rev revisa?', 'Falta o botão de inscrição. @dev corrige?', 'Corrigi o botão. @rev confere?', 'Aprovado: página com botão de inscrição.'])
    expect(notes().some((n) => n.startsWith('**Objetivo**: os agentes trabalham nele sozinhos'))).toBe(true)
    expect(notes().at(-1)).toBe('**Objetivo cumprido**, por Rev, em 4 respostas.')
    expect(notes().some((n) => n.includes('Parei a conversa entre agentes'))).toBe(false)
    // Each reply was told the goal and given the tool to end it.
    expect(turns.every((t) => t.prompt.includes('Isto é um objetivo que Edu deu ao time') && t.prompt.includes('landing page'))).toBe(true)
  })

  it('stops when an agent says the same as before: the team is going in circles', async () => {
    const r = team({ dev: () => 'Corrigi. @rev', rev: (n) => `Ainda falta, rodada ${n}. @dev` })
    await r.send('c', '/objetivo @dev conserta o formulário')
    await r.idle()
    expect(said()).toHaveLength(3)
    expect(notes().at(-1)).toContain('Parei o objetivo: Dev repetiu a mesma resposta')
  })

  it(`stops at ${GOAL_MAX_TURNS} replies with nobody marking it done`, async () => {
    const r = team({ dev: (n) => `Versão ${n}. @rev`, rev: (n) => `Revisão ${n}: falta mais. @dev` })
    await r.send('c', '/objetivo @dev melhora o texto')
    await r.idle()
    expect(said()).toHaveLength(GOAL_MAX_TURNS)
    expect(notes().at(-1)).toContain(`Parei o objetivo em ${GOAL_MAX_TURNS} respostas, o limite`)
  })

  it('stops when a reply neither passes the turn nor ends it, and asks for the goal when there is none', async () => {
    const r = team({ dev: () => 'Fiz o que deu.', rev: () => 'ok' })
    await r.send('c', '/objetivo @dev faz a landing')
    await r.idle()
    expect(said()).toHaveLength(1)
    expect(notes().at(-1)).toContain('O objetivo parou sem ser cumprido: Dev não passou a vez')

    await r.send('c', '/objetivo')
    await r.idle()
    expect(notes().at(-1)).toContain('Escreva o objetivo depois de /objetivo')
    expect(said()).toHaveLength(1)
  })

  it('outside a goal, the usual replies in a row still stop the agents', async () => {
    const r = team({ dev: (n) => `Versão ${n}. @rev`, rev: (n) => `Revisão ${n}. @dev` })
    await r.send('c', '@dev melhora o texto')
    await r.idle()
    expect(said()).toHaveLength(3)
    expect(notes().at(-1)).toContain('Parei a conversa entre agentes aqui')
  })
})
