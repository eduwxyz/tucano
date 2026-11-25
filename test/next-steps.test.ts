// Next steps: an agent proposes the work that comes after its reply as a card of checkboxes.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { hasOpenSteps, MAX_STEPS, parseNextSteps, type Decision } from '../src/shared/questions'
import type { Agent, EngineId, Message, Person, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { People } from '../src/core/people'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }

const agent = (id: string, handle: string): Agent => ({
  id,
  name: handle[0]!.toUpperCase() + handle.slice(1),
  handle,
  role: '',
  color: 'sky',
  instructions: '',
  modelId: 'sonnet',
  effort: 'low',
  limit: 1_000_000,
  used: 0,
  grants: {},
  memory: 'auto',
  computer: false,
  archived: false
})

const four = (): Decision => {
  const r = parseNextSteps({
    question: 'O que vem agora?',
    steps: [
      { label: 'Rodar a suíte inteira', description: 'o que já está escrito' },
      { label: 'Traduzir os rótulos novos' },
      { label: 'Escrever o teste do card' },
      { label: 'Publicar as capturas' }
    ]
  })
  if ('error' in r) throw new Error(r.error)
  return r.decision
}

describe('what next_steps takes', () => {
  it('makes one multiple decision, marked as steps, with the question it was given', () => {
    const d = four()
    expect(d).toMatchObject({ question: 'O que vem agora?', kind: 'multiple', nextSteps: true })
    expect(d.options?.map((o) => o.label)).toEqual(['Rodar a suíte inteira', 'Traduzir os rótulos novos', 'Escrever o teste do card', 'Publicar as capturas'])
    expect(d.options?.[0]?.description).toBe('o que já está escrito')
  })

  it('takes a step as a bare string, and titles the card when it is not told one', () => {
    const r = parseNextSteps({ steps: ['Rodar os testes', 'Traduzir os rótulos'] })
    expect('decision' in r && r.decision.question).toBe('Por onde eu sigo?')
    expect('decision' in r && r.decision.options?.map((o) => o.label)).toEqual(['Rodar os testes', 'Traduzir os rótulos'])
  })

  it('refuses an empty list, too many steps, a repeated step and a label that is too long', () => {
    expect(parseNextSteps({ steps: [] })).toMatchObject({ error: expect.any(String) })
    expect(parseNextSteps({ steps: Array.from({ length: MAX_STEPS + 1 }, (_, i) => `Passo ${i + 1}`) })).toMatchObject({ error: expect.any(String) })
    expect(parseNextSteps({ steps: ['Rodar os testes', 'rodar OS testes'] })).toMatchObject({ error: expect.any(String) })
    expect(parseNextSteps({ steps: [{ label: 'x'.repeat(81) }] })).toMatchObject({ error: expect.any(String) })
    expect(parseNextSteps({ steps: [{ description: 'sem label' }] })).toMatchObject({ error: expect.any(String) })
  })
})

describe('the card an agent gets', () => {
  let db: Db
  let settings: Settings
  let gateway: Gateway

  const engines = (claude: Engine): Record<EngineId, Engine> => ({
    claude,
    codex: fakeEngine('codex', { delayMs: 1 }),
    opencode: fakeEngine('opencode'),
    pi: fakeEngine('pi'),
    antigravity: fakeEngine('antigravity'),
    cursor: fakeEngine('cursor'),
    grok: fakeEngine('grok'),
    cline: fakeEngine('cline'),
    hermes: fakeEngine('hermes'),
    endpoint: fakeEngine('endpoint')
  })
  const asked = (): Message | undefined => db.messages().find((m) => m.author.kind === 'agent' && hasOpenSteps(m.run))

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'steps-')), 'test.db'))
    settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    gateway = new Gateway()
    await gateway.start()
    return () => gateway.stop()
  })

  const runner = (emit: ConstructorParameters<typeof Runner>[0]['emit'] = () => {}): Runner =>
    new Runner({
      db,
      engines: engines(fakeEngine('claude', { delayMs: 1 })),
      settings: async () => settings,
      emit,
      workDir: mkdtempSync(join(tmpdir(), 'steps-work-')),
      gateway
    })

  it('puts the steps on one card', async () => {
    const r = runner()
    await r.send('d1', '@lia me dá os próximos passos')
    await r.idle()
    const q = asked()
    expect(q?.run?.questions).toHaveLength(1)
    expect(q?.run?.questions?.[0]).toMatchObject({ nextSteps: true, kind: 'multiple' })
    expect(q?.run?.questions?.[0]?.options).toHaveLength(4)
  })

  it('what stays ticked comes back as the next message, and nothing else does', async () => {
    const r = runner()
    await r.send('d1', '@lia me dá os próximos passos')
    await r.idle()
    const q = asked()!
    r.answerDecision(q.id, 0, { chosen: [0, 2] }, db.owner())
    await r.submitDecisions(q.id, db.owner())
    await r.idle()
    const mine = db.messages().filter((m) => m.author.kind === 'person').pop()
    expect(mine?.text).toContain('O que vem agora?')
    expect(mine?.text).toContain('Rodar a suíte inteira')
    expect(mine?.text).toContain('Escrever o teste do card')
    expect(mine?.text).not.toContain('Traduzir os rótulos novos')
    expect(mine?.text).not.toContain('Publicar as capturas')
  })

  it('a step written by hand comes back as another step, not as something else', async () => {
    const r = runner()
    await r.send('d1', '@lia me dá os próximos passos')
    await r.idle()
    const q = asked()!
    r.answerDecision(q.id, 0, { chosen: [0], other: 'Escrever a nota de lançamento' }, db.owner())
    await r.submitDecisions(q.id, db.owner())
    await r.idle()
    const mine = db.messages().filter((m) => m.author.kind === 'person').pop()
    expect(mine?.text).toContain('Rodar a suíte inteira')
    expect(mine?.text).toContain('Outro passo: Escrever a nota de lançamento')
    expect(mine?.text).not.toContain('Outra coisa')
  })

  it('holds nothing: the reply is done, with no question, no inbox item and nothing in the field', async () => {
    const r = runner()
    await r.send('d1', '@lia me dá os próximos passos')
    await r.idle()
    const q = asked()!
    expect(q.run?.status).toBe('done')
    expect(q.run?.question).toBeUndefined()
    expect(db.question(q.id)).toBeUndefined()
    expect(db.openQuestions()).toHaveLength(0)
    expect(db.waitingQuestion('d1', null)).toBeUndefined()
    expect(new People(db).inbox(db.owner()).questions).toHaveLength(0)
  })

  it('a message written instead is a new request: the card is not answered by it', async () => {
    const r = runner()
    await r.send('d1', '@lia me dá os próximos passos')
    await r.idle()
    const q = asked()!
    // Something ticked on the card and not sent stays out of what the person wrote.
    r.answerDecision(q.id, 0, { chosen: [1] }, db.owner())
    await r.send('d1', 'outra coisa: qual a capital da França?')
    await r.idle()
    const mine = db.messages().filter((m) => m.author.kind === 'person').pop()
    expect(mine?.text).toBe('outra coisa: qual a capital da França?')
    const card = db.message(q.id)!
    expect(hasOpenSteps(card.run)).toBe(true)
    expect(card.run?.answerMessage).toBeUndefined()
    expect(card.run?.answeredInText).toBeUndefined()
    // And it can still be answered afterwards.
    await r.submitDecisions(q.id, db.owner())
    await r.idle()
    expect(hasOpenSteps(db.message(q.id)!.run)).toBe(false)
    expect(db.messages().filter((m) => m.author.kind === 'person').pop()?.text).toContain('Traduzir os rótulos novos')
  })

  it('takes no slot: with one reply at a time, the next prompt starts right away', async () => {
    settings = { ...settings, repliesAtOnce: 1 }
    db.saveAgent({ ...agent('a1', 'lia'), oneAtATime: true })
    const r = runner()
    await r.send('d1', '@lia me dá os próximos passos')
    await r.idle()
    const before = db.messages().filter((m) => m.author.kind === 'agent').length
    await r.send('d1', 'segue com outra coisa')
    await r.idle()
    const replies = db.messages().filter((m) => m.author.kind === 'agent')
    expect(replies.length).toBe(before + 1)
    expect(replies.at(-1)?.run?.status).toBe('done')
    expect(db.queuedMessages()).toHaveLength(0)
  })

  it('in a team, only whoever it was proposed to, or an admin, may answer it', async () => {
    const ana: Person = { id: 'p-ana', name: 'Ana', about: '', role: 'member' }
    const bia: Person = { id: 'p-bia', name: 'Bia', about: '', role: 'member' }
    db.addPerson(ana)
    db.addPerson(bia)
    db.createConversation({ id: 'c1', kind: 'channel', name: 'geral', members: ['a1'] })
    const r = runner()
    await r.send('c1', '@lia me dá os próximos passos', [], undefined, ana.id)
    await r.idle()
    const q = asked()!
    expect(q.run?.askedTo).toBe(ana.id)
    expect(() => r.answerDecision(q.id, 0, { chosen: [0] }, bia)).toThrow()
    await expect(r.submitDecisions(q.id, bia)).rejects.toThrow()
    expect(() => r.cancelQuestion(q.id, bia)).toThrow()
    expect(hasOpenSteps(db.message(q.id)!.run)).toBe(true)
    r.answerDecision(q.id, 0, { chosen: [0] }, ana)
    await r.submitDecisions(q.id, ana)
    await r.idle()
    expect(db.message(q.id)!.run).toMatchObject({ status: 'done', answeredBy: ana.id })
    expect(hasOpenSteps(db.message(q.id)!.run)).toBe(false)
  })

  it('survives a restart, and dismissing it wakes no one', async () => {
    const r = runner()
    await r.send('d1', '@lia me dá os próximos passos')
    await r.idle()
    const q = asked()!
    const again = runner()
    await again.resumeQueued()
    expect(hasOpenSteps(db.message(q.id)!.run)).toBe(true)
    const replies = db.messages().filter((m) => m.author.kind === 'agent').length
    again.cancelQuestion(q.id, db.owner())
    await again.idle()
    expect(db.message(q.id)!.run).toMatchObject({ status: 'done', cancelled: true })
    expect(hasOpenSteps(db.message(q.id)!.run)).toBe(false)
    expect(db.messages().filter((m) => m.author.kind === 'agent')).toHaveLength(replies)
  })

  it('has no Skip: one sent anyway keeps nothing, sends nothing and wakes no one', async () => {
    const r = runner()
    await r.send('d1', '@lia me dá os próximos passos')
    await r.idle()
    const q = asked()!
    const before = db.messages().length
    r.answerDecision(q.id, 0, { skipped: true }, db.owner())
    await r.submitDecisions(q.id, db.owner())
    await r.idle()
    expect(db.messages()).toHaveLength(before)
    expect(db.message(q.id)!.run?.answers).toBeUndefined()
    expect(hasOpenSteps(db.message(q.id)!.run)).toBe(true)
  })

  it('keeps Skip on a plain question', async () => {
    const r = runner()
    await r.send('d1', '@lia pergunte algo')
    await r.idle()
    const q = db.messages().find((m) => m.run?.status === 'waiting_input')!
    r.answerDecision(q.id, 0, { skipped: true }, db.owner())
    expect(db.message(q.id)!.run?.answers?.[0]).toEqual({ skipped: true })
  })

  describe('a new card from the same agent in the same place', () => {
    const PROMPT = '@lia me dá os próximos passos'
    const open = (): Message[] => db.messages().filter((m) => hasOpenSteps(m.run))

    it('closes the one before it quietly: no turn, no message, and it reads as replaced', async () => {
      const events: Message[] = []
      const r = runner((e) => {
        if (e.type === 'message') events.push(e.message)
      })
      await r.send('d1', PROMPT)
      await r.idle()
      const first = asked()!
      r.answerDecision(first.id, 0, { chosen: [1] }, db.owner()) // ticked and never sent
      const people = db.messages().filter((m) => m.author.kind === 'person').length
      const agents = db.messages().filter((m) => m.author.kind === 'agent').length
      events.length = 0
      await r.send('d1', PROMPT)
      await r.idle()

      // One prompt, one reply: closing the old card added nothing to the conversation.
      expect(db.messages().filter((m) => m.author.kind === 'person')).toHaveLength(people + 1)
      expect(db.messages().filter((m) => m.author.kind === 'agent')).toHaveLength(agents + 1)
      const old = db.message(first.id)!
      expect(old.run).toMatchObject({ status: 'done', stepsReplaced: true })
      expect(old.run?.stepsOpen).toBeUndefined()
      expect(old.run?.cancelled).toBeUndefined()
      expect(old.run?.answers).toBeUndefined()
      expect(old.run?.answerMessage).toBeUndefined()
      expect(old.run?.answeredBy).toBeUndefined()
      expect(open()).toHaveLength(1)
      expect(open()[0]!.id).not.toBe(first.id)
      // Every open window hears it.
      expect(events.some((m) => m.id === first.id && m.run?.stepsReplaced)).toBe(true)
    })

    it('stays replaced after a restart, with only the new card open', async () => {
      const file = join(mkdtempSync(join(tmpdir(), 'steps-restart-')), 'test.db')
      db = new Db(file)
      db.saveAgent(agent('a1', 'lia'))
      db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
      const r = runner()
      await r.send('d1', PROMPT)
      await r.idle()
      const first = asked()!
      await r.send('d1', PROMPT)
      await r.idle()
      const second = open()[0]!

      db = new Db(file)
      const again = runner()
      await again.resumeQueued()
      await again.idle()
      expect(db.message(first.id)!.run?.stepsReplaced).toBe(true)
      expect(open().map((m) => m.id)).toEqual([second.id])
    })

    it('a late click on the old card sends nothing and tells the window it was replaced', async () => {
      const events: Message[] = []
      const r = runner((e) => {
        if (e.type === 'message') events.push(e.message)
      })
      await r.send('d1', PROMPT)
      await r.idle()
      const first = asked()!
      await r.send('d1', PROMPT)
      await r.idle()
      const before = db.messages().length
      const saved = JSON.stringify(db.message(first.id)!.run)
      events.length = 0

      r.answerDecision(first.id, 0, { chosen: [0] }, db.owner())
      await r.submitDecisions(first.id, db.owner())
      r.cancelQuestion(first.id, db.owner())
      await r.idle()

      expect(db.messages()).toHaveLength(before)
      expect(JSON.stringify(db.message(first.id)!.run)).toBe(saved)
      expect(events.length).toBeGreaterThan(0)
      expect(events.every((m) => m.id === first.id && m.run?.stepsReplaced)).toBe(true)
    })

    it("leaves another agent's card alone", async () => {
      db.saveAgent(agent('a2', 'bia'))
      db.createConversation({ id: 'c1', kind: 'channel', name: 'geral', members: ['a1', 'a2'] })
      const r = runner()
      await r.send('c1', PROMPT)
      await r.idle()
      const lia = open()[0]!
      await r.send('c1', '@bia me dá os próximos passos')
      await r.idle()
      expect(open()).toHaveLength(2)
      expect(hasOpenSteps(db.message(lia.id)!.run)).toBe(true)
      expect(db.message(lia.id)!.run?.stepsReplaced).toBeUndefined()
    })

    it('leaves a card in another thread alone, and replaces the one in its own', async () => {
      const r = runner()
      await r.send('d1', PROMPT)
      await r.idle()
      const main = asked()!
      const root = db.messages().find((m) => m.author.kind === 'person')!
      await r.send('d1', PROMPT, [], root.id)
      await r.idle()
      const inThread = open().find((m) => m.threadId === root.id)!
      expect(hasOpenSteps(db.message(main.id)!.run)).toBe(true)
      await r.send('d1', PROMPT, [], root.id)
      await r.idle()
      expect(db.message(inThread.id)!.run?.stepsReplaced).toBe(true)
      expect(hasOpenSteps(db.message(main.id)!.run)).toBe(true)
      expect(open()).toHaveLength(2)
    })

    it('leaves a card in another conversation alone', async () => {
      db.createConversation({ id: 'c2', kind: 'channel', name: 'outra', members: ['a1'] })
      const r = runner()
      await r.send('d1', PROMPT)
      await r.idle()
      const dm = asked()!
      await r.send('c2', PROMPT)
      await r.idle()
      expect(hasOpenSteps(db.message(dm.id)!.run)).toBe(true)
      expect(open()).toHaveLength(2)
    })

    it('leaves an answered card as answered, and a cancelled one as cancelled', async () => {
      const r = runner()
      await r.send('d1', PROMPT)
      await r.idle()
      const answered = asked()!
      r.answerDecision(answered.id, 0, { chosen: [0] }, db.owner())
      await r.submitDecisions(answered.id, db.owner())
      await r.idle()
      const was = db.message(answered.id)!.run
      await r.send('d1', PROMPT)
      await r.idle()
      const cancelled = open()[0]!
      r.cancelQuestion(cancelled.id, db.owner())
      await r.send('d1', PROMPT)
      await r.idle()
      expect(db.message(answered.id)!.run).toEqual(was)
      expect(db.message(cancelled.id)!.run).toMatchObject({ cancelled: true })
      expect(db.message(cancelled.id)!.run?.stepsReplaced).toBeUndefined()
    })

    it('a reply with no card closes nothing', async () => {
      const r = runner()
      await r.send('d1', PROMPT)
      await r.idle()
      const first = asked()!
      await r.send('d1', 'qual a capital da França?')
      await r.idle()
      expect(hasOpenSteps(db.message(first.id)!.run)).toBe(true)
      expect(db.message(first.id)!.run?.stepsReplaced).toBeUndefined()
    })

    it('tells the agent the old card was replaced, not that the person dismissed it', async () => {
      const prompts: string[] = []
      const inner = fakeEngine('claude', { delayMs: 1 })
      const spy: Engine = { ...inner, run: (turn) => (prompts.push([...(turn.blocks ?? []), turn.prompt].join('\n')), inner.run(turn)) }
      const r = new Runner({ db, engines: engines(spy), settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'steps-work-')), gateway })
      await r.send('d1', PROMPT)
      await r.idle()
      await r.send('d1', PROMPT)
      await r.idle()
      await r.send('d1', 'e agora?')
      await r.idle()
      const last = prompts.at(-1)!
      expect(last).toContain('que um mais novo substituiu')
      expect(last).not.toContain('a pessoa dispensou')
    })
  })
})
