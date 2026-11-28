// The consolidated behaviour over the real runner with fake engines: one mode per member, a deliberate
// room opened by pedir, silent witnesses, inherited privacy and one return task for the asker.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { TEAM_UP_CHARS, TEAM_UP_MESSAGES, TEAM_UP_NAME_MAX, TEAM_UP_WITNESSES } from '../src/shared/types'
import { TEAM_UP_REUSE_MS } from '../src/core/team-up'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id[0]!.toUpperCase() + id.slice(1), handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', archived: false, computer: false, ...extra })

let db: Db
let gateway: Gateway
let turns: { agent: string; prompt: string }[]

const runner = (): Runner => {
  const engines = Object.fromEntries((['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok', 'cline', 'hermes', 'endpoint'] as EngineId[]).map((id) => {
    const base = fakeEngine(id, { delayMs: 1 })
    // Keep the fake's real stream: the runner needs its events; record the prompt on the way in.
    return [id, { id, run: (t) => {
      turns.push({ agent: id, prompt: t.prompt })
      return base.run(t)
    } } as Engine]
  })) as Record<EngineId, Engine>
  const settings = { workspaceName: 'Edu', context: '', engines: Object.fromEntries(Object.keys(engines).map((id) => [id, ready])), routerModel: 'haiku', memoryModel: 'haiku', memory: 'auto' } as unknown as Settings
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ac-work-')), gateway })
}

const by = (id: string, conversationId?: string): Message[] => db.messages().filter((m) => m.author.kind === 'agent' && m.author.id === id && (!conversationId || m.conversationId === conversationId))

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ac-db-')), 'test.db'))
  turns = []
  db.saveAgent(agent('orion', { modelId: 'gpt-5.6-luna' }))
  db.saveAgent(agent('clara', { reportsTo: 'orion' }))
  db.saveAgent(agent('bento', { reportsTo: 'orion' }))
  db.saveAgent(agent('nina', { reportsTo: 'orion' }))
  db.createConversation({ id: 'dm', kind: 'dm', name: 'orion', members: ['orion'] })
  db.createConversation({ id: 'private', kind: 'dm', name: 'orion', owner: 'ana', members: ['orion'] })
  db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['clara', 'bento'] })
  gateway = new Gateway()
  await gateway.start()
  return () => gateway.stop()
})

describe('one mode per member', () => {
  it('keeps modes when an ordinary membership call only names members', () => {
    db.setMembers('ch', ['clara', 'bento'], { clara: 'mention' })
    expect(db.conversation('ch')?.modes).toEqual({ clara: 'mention', bento: 'answer' })
    db.setMembers('ch', ['clara', 'bento', 'nina'])
    expect(db.conversation('ch')?.modes).toEqual({ clara: 'mention', bento: 'answer', nina: 'answer' })
    db.setMembers('ch', ['clara'])
    expect(db.conversation('ch')?.modes?.['clara']).toBe('mention')
  })

  it('leaves a mention-mode agent out of the unmentioned roster, and a mention wakes it', async () => {
    db.setMembers('ch', ['clara', 'bento'], { clara: 'mention' })
    const r = runner()
    await r.send('ch', 'revise o build de ontem')
    await r.idle()
    expect(by('clara', 'ch')).toEqual([])
    expect(by('bento', 'ch')).toHaveLength(1)

    await r.send('ch', '@clara revise o build de ontem')
    await r.idle()
    expect(by('clara', 'ch')).toHaveLength(1)
  })

  it('posts one hint per thread when everyone is silent, even after another message', async () => {
    db.setMembers('ch', ['clara', 'bento'], { clara: 'mention', bento: 'mention' })
    const r = runner()
    await r.send('ch', 'alguém pode olhar isto?')
    await r.idle()
    await r.send('ch', 'e agora?')
    await r.idle()
    const hints = db.messages().filter((m) => m.conversationId === 'ch' && m.author.kind === 'system' && m.text.includes('Escreva @nome'))
    expect(hints).toHaveLength(1)
    expect(by('clara', 'ch')).toEqual([])
    expect(by('bento', 'ch')).toEqual([])
  })
})

describe('a room opened by pedir', () => {
  it('carries the work, keeps witnesses silent and returns once to the asker', async () => {
    const r = runner()
    await r.send('dm', 'delegue a clara na sala auditoria com @bento: veja o retry')
    await r.idle()
    const room = db.conversations().find((c) => c.teamUp)!
    expect(room.kind).toBe('channel')
    expect(room.name.length).toBeLessThanOrEqual(TEAM_UP_NAME_MAX) // 22 characters
    expect(room.teamUp).toMatchObject({ from: 'dm', by: 'orion', title: 'auditoria' })
    expect(room.members).toEqual(expect.arrayContaining(['orion', 'clara', 'bento']))
    expect(room.modes?.['bento']).toBe('mention')
    expect(room.modes?.['clara']).toBe('answer')

    const handoff = db.messages().filter((m) => m.conversationId === room.id && m.author.kind === 'agent' && m.author.id === 'orion')
    expect(handoff[0]!.text).toContain('Trouxe para cá')
    expect(handoff[0]!.text.length).toBeLessThan(TEAM_UP_CHARS) // 12,000 characters
    const d = db.delegation(handoff[1]!.run!.delegation!.id)!
    expect(d.participants).toEqual([{ agentId: 'clara', role: 'do' }, { agentId: 'bento', role: 'watch' }])
    expect(TEAM_UP_MESSAGES).toBe(24)
    expect(TEAM_UP_WITNESSES).toBe(3)
    expect(TEAM_UP_REUSE_MS).toBe(6 * 3_600_000)

    expect(turns.filter((t) => t.prompt.includes('Testemunhas neste pedido')).length).toBeGreaterThan(0)
    expect(by('beto', room.id)).toEqual([]) // a witness reads and does not start a reply
    expect(by('orion', 'dm')).toHaveLength(2) // the asking reply and one return task
  })

  it('reuses the room for the same caller, source and guests inside six hours', async () => {
    const r = runner()
    await r.send('dm', 'delegue a clara na sala auditoria com @bento: primeiro')
    await r.idle()
    await r.send('dm', 'delegue a clara na sala auditoria com @bento: segundo')
    await r.idle()
    const rooms = db.conversations().filter((c) => c.teamUp)
    expect(rooms).toHaveLength(1)
    const delegated = db.messages().filter((m) => m.author.kind === 'agent' && m.run?.delegation).map((m) => db.delegation(m.run!.delegation!.id)!)
    expect(delegated).toHaveLength(2) // two requests, one reused room
    expect(new Set(delegated.map((d) => d.conversationId)).size).toBe(1)
  })

  it('passes a private source audience into the room', async () => {
    const r = runner()
    await r.send('private', 'delegue a clara na sala auditoria: isto é privado')
    await r.idle()
    const room = db.conversations().find((c) => c.teamUp)!
    expect(room.teamUp?.privateTo).toBe('ana')
  })
})
