// A person's @ names an agent who is reachable but outside the conversation. The card asks once;
// Include uses setChannelMembers and the original mention wakes the agent in the same turn. Reach is
// resolved again on approval, with the room's private audience, and a witness still reads silently.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { questionsOf } from '../src/shared/questions'
import type { Agent, EngineId, Message, Person, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id[0]!.toUpperCase() + id.slice(1), handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', archived: false, computer: false, ...extra })

let db: Db
let gateway: Gateway
let turns: { agent: string; prompt: string }[]

const runner = (): Runner => {
  const engines = Object.fromEntries((['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok', 'cline', 'hermes', 'endpoint'] as EngineId[]).map((id) => {
    const base = fakeEngine(id, { delayMs: 1 })
    return [id, { id, run: (t) => {
      turns.push({ agent: id, prompt: t.prompt })
      return base.run(t)
    } } as Engine]
  })) as Record<EngineId, Engine>
  const settings = { workspaceName: 'Edu', context: '', engines: Object.fromEntries(Object.keys(engines).map((id) => [id, ready])), routerModel: 'haiku', memoryModel: 'haiku', memory: 'auto' } as unknown as Settings
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'inc-work-')), gateway })
}

const by = (id: string, conversationId: string): Message[] => db.messages().filter((m) => m.author.kind === 'agent' && m.author.id === id && m.conversationId === conversationId)
const cards = (): Message[] => db.messages().filter((m) => !!m.run?.inclusion)
const lastCard = (): Message => cards().at(-1)!
const approve = async (r: Runner, index: number, byId = db.ownerId()): Promise<void> => {
  const card = lastCard()
  r.answerDecision(card.id, 0, { chosen: [index] }, db.person(byId)!)
  await r.submitDecisions(card.id, db.person(byId)!)
  await r.idle()
}

beforeEach(async () => {
  setLang('en')
  db = new Db(join(mkdtempSync(join(tmpdir(), 'inc-db-')), 'test.db'))
  turns = []
  db.saveAgent(agent('orion'))
  db.saveAgent(agent('clara'))
  db.saveAgent(agent('bento'))
  db.saveAgent(agent('nina'))
  db.saveAgent(agent('tuca', { kind: 'tuca' }))
  db.createConversation({ id: 'dm', kind: 'dm', name: 'orion', members: ['orion'] })
  db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['clara'] })
  gateway = new Gateway()
  await gateway.start()
})
afterEach(async () => {
  await gateway.stop()
  setLang('pt')
})

describe('the @-to-include card', () => {
  it('offers one card with Include recommended and Skip for a reachable agent outside the room', async () => {
    const r = runner()
    await r.send('ch', '@nina olhe o build', [], undefined, db.ownerId())
    await r.idle()
    expect(cards()).toHaveLength(1) // one card for the message
    const [decision] = questionsOf(lastCard().run)
    expect(decision?.kind).toBe('single') // one decision
    expect(decision?.options?.map((o) => o.label)).toEqual(['Include', 'Skip'])
    expect(decision?.options?.[0]?.recommended).toBe(true)
    expect(decision?.question).toContain('Nina')
    expect(db.question(lastCard().id)).toMatchObject({ state: 'open', askedTo: db.ownerId() })
    expect(db.conversation('ch')?.members).toEqual(['clara']) // nothing changes before approval
    expect(by('nina', 'ch')).toHaveLength(0)
  })

  it('Include adds both named agents and their answer follows in that one approval turn', async () => {
    const r = runner()
    await r.send('ch', '@nina e @bento olhem o build', [], undefined, db.ownerId())
    await r.idle()
    expect(cards()).toHaveLength(1) // one card for 2 non-members: one approval round
    expect(lastCard().run?.inclusion?.agentIds).toEqual(expect.arrayContaining(['nina', 'bento']))
    await approve(r, 0)
    expect(db.conversation('ch')?.members).toEqual(expect.arrayContaining(['clara', 'nina', 'bento']))
    expect(db.conversation('ch')?.modes?.['nina']).toBe('answer') // included agents answer normally
    expect(by('nina', 'ch')).toHaveLength(1) // 1 reply from the included agent
    expect(by('bento', 'ch')).toHaveLength(1)
    expect(by('clara', 'ch')).toHaveLength(0) // the mention called the two outsiders, not the member
    expect(turns.some((t) => t.prompt.includes('olhem o build'))).toBe(true) // the original mention reached the reply
    expect(db.question(lastCard().id)?.state).toBe('answered')
  })

  it('Skip leaves membership unchanged and the mention calls no one', async () => {
    const r = runner()
    await r.send('ch', '@nina olhe o build', [], undefined, db.ownerId())
    await r.idle()
    await approve(r, 1)
    expect(db.conversation('ch')?.members).toEqual(['clara'])
    expect(by('nina', 'ch')).toHaveLength(0)
    expect(by('clara', 'ch')).toHaveLength(0)
    expect(db.question(lastCard().id)?.state).toBe('answered')
  })

  it('applies in a DM as well as a channel', async () => {
    const r = runner()
    await r.send('dm', '@nina ajude aqui', [], undefined, db.ownerId())
    await r.idle()
    expect(cards()).toHaveLength(1)
    await approve(r, 0)
    expect(db.conversation('dm')?.members).toEqual(expect.arrayContaining(['orion', 'nina']))
    expect(by('nina', 'dm')).toHaveLength(1)
  })

  it('gives a hidden agent no card at all', async () => {
    const member: Person = { id: 'bia', name: 'Bia', role: 'member', about: '', access: { mode: 'picked', sectors: [], agents: ['clara'], channels: ['ch'] } }
    db.addPerson(member)
    const r = runner()
    await r.send('ch', '@nina olhe o build', [], undefined, 'bia')
    await r.idle()
    expect(cards()).toHaveLength(0) // a restricted writer cannot name a hidden agent
    expect(by('nina', 'ch')).toHaveLength(0)
  })

  it('does not widen a private audience between the card and its approval', async () => {
    db.addPerson({ id: 'ana', name: 'Ana', role: 'member', about: '', access: { mode: 'picked', sectors: [], agents: ['clara', 'nina'], channels: ['private'] } })
    db.createConversation({
      id: 'private', kind: 'channel', name: 'closed', members: ['clara'], createdBy: db.ownerId(),
      teamUp: { from: 'dm', title: 'closed', by: 'clara', at: Date.now(), guests: ['clara'], privateTo: 'ana' }
    })
    const r = runner()
    await r.send('private', '@nina olhe isto', [], undefined, db.ownerId())
    await r.idle()
    expect(cards()).toHaveLength(1) // visible to the writer and to the room's audience when parsed
    db.setPersonAccess('ana', { mode: 'picked', sectors: [], agents: ['clara'], channels: ['private'] })
    await approve(r, 0)
    expect(db.conversation('private')?.members).toEqual(['clara']) // the approval cannot pull Nina in
    expect(by('nina', 'private')).toHaveLength(0)
  })

  it('leaves a deliberate delegation to the Tuca with pedir, not an inclusion card', async () => {
    db.createConversation({ id: 'tuca-dm', kind: 'dm', name: 'tuca', members: ['tuca'] })
    const r = runner()
    await r.send('tuca-dm', 'delegue a @nina: escreva o aviso', [], undefined, db.ownerId())
    await r.idle()
    expect(cards()).toHaveLength(0) // a delegation names the doer, it does not ask to add them here
    const steps = by('tuca', 'tuca-dm').flatMap((m) => m.run?.steps.map((s) => s.label) ?? [])
    expect(steps.some((s) => /Pediu a Nina|Asked Nina/.test(s))).toBe(true) // pedir went out
    expect(by('nina', 'tuca-dm')).toEqual([]) // no direct reply from the named agent in the Tuca's DM
  })

  it('keeps a pedir witness silent when a person writes in the room', async () => {
    const r = runner()
    await r.send('dm', 'delegue a clara na sala auditoria com @bento: veja o retry', [], undefined, db.ownerId())
    await r.idle()
    const room = db.conversations().find((c) => c.teamUp)!
    expect(room.members).toEqual(expect.arrayContaining(['bento']))
    expect(room.modes?.['bento']).toBe('mention') // 1 silent witness
    expect(by('bento', room.id)).toEqual([])
    await r.send(room.id, 'nota sem menção', [], undefined, db.ownerId())
    await r.idle()
    expect(by('bento', room.id)).toEqual([]) // a witness reads and never starts a second reply
    expect(cards()).toHaveLength(0) // no mention in that message: no card
  })
})
