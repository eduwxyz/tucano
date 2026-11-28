// Approval on a one-action proposal: the click wakes the agent with the proposal as its task, and
// nothing is written into the conversation as a prompt from the person.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { hasOpenProceed } from '../src/shared/questions'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const PROPOSAL = 'They’re still sitting there unstaged; say the word and I’ll restore all six, one branch each.'

const agent = (): Agent => ({
  id: 'a1',
  name: 'Lia',
  handle: 'lia',
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

describe('one-action proposals in the core', () => {
  let db: Db
  let settings: Settings
  let gateway: Gateway
  let prompts: string[]

  const runner = (reply: string): Runner => {
    const inner = fakeEngine('claude', { delayMs: 1, reply: () => reply })
    const spy: Engine = {
      ...inner,
      run: (turn: Turn) => {
        prompts.push([...(turn.blocks ?? []), turn.prompt].join('\n'))
        return inner.run(turn)
      }
    }
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
    return new Runner({
      db,
      engines: engines(spy),
      settings: async () => settings,
      emit: () => {},
      workDir: mkdtempSync(join(tmpdir(), 'proceed-work-')),
      gateway
    })
  }

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'proceed-')), 'test.db'))
    settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    gateway = new Gateway()
    await gateway.start()
    prompts = []
    return () => gateway.stop()
  })

  const proposalCard = (): Message | undefined => db.messages().find((m) => m.author.kind === 'agent' && hasOpenProceed(m.run))

  it('offers one button where the reply offered one action', async () => {
    const r = runner(PROPOSAL)
    await r.send('d1', '@lia prepare the restore')
    await r.idle()
    const card = proposalCard()!
    expect(card.text).toBe(PROPOSAL)
    expect(card.run?.questions).toHaveLength(1)
    expect(card.run?.questions?.[0]).toMatchObject({ proceed: true, kind: 'text', question: PROPOSAL })
    expect(card.run?.status).toBe('done')
    expect(card.run?.stepsOpen).toBeUndefined()
    expect(db.question(card.id)).toBeUndefined()
  })

  it('approval starts the next turn with the proposal as its task and adds no person message', async () => {
    const r = runner(PROPOSAL)
    await r.send('d1', '@lia prepare the restore')
    await r.idle()
    const card = proposalCard()!
    const people = db.messages().filter((m) => m.author.kind === 'person')
    const replies = db.messages().filter((m) => m.author.kind === 'agent')
    prompts.length = 0

    await r.submitDecisions(card.id, db.owner())
    await r.idle()

    expect(db.messages().filter((m) => m.author.kind === 'person')).toHaveLength(people.length)
    expect(db.messages().filter((m) => m.author.kind === 'agent')).toHaveLength(replies.length + 1)
    expect(db.message(card.id)!.run).toMatchObject({ status: 'done', answeredBy: db.owner().id })
    expect(hasOpenProceed(db.message(card.id)!.run)).toBe(false)
    expect(db.message(card.id)!.run?.answers?.[0]?.text).toBe('Aprovado')
    const generated = prompts.filter((p) => p.includes(PROPOSAL))
    expect(generated.length).toBeGreaterThan(0)
    expect(generated.at(-1)).toContain('A pessoa aprovou a proposta abaixo')
    expect(generated.at(-1)).toContain(PROPOSAL)
  })

  it('a second click on the settled card wakes no one', async () => {
    const r = runner(PROPOSAL)
    await r.send('d1', '@lia prepare the restore')
    await r.idle()
    const card = proposalCard()!
    await r.submitDecisions(card.id, db.owner())
    await r.idle()
    const replies = db.messages().filter((m) => m.author.kind === 'agent').length
    await expect(r.submitDecisions(card.id, db.owner())).rejects.toThrow()
    await r.idle()
    expect(db.messages().filter((m) => m.author.kind === 'agent')).toHaveLength(replies)
  })

  it('leaves a reply with no offered action without a button', async () => {
    const r = runner('Instalei beautifulsoup4 e rodei os testes.')
    await r.send('d1', '@lia instale')
    await r.idle()
    expect(proposalCard()).toBeUndefined()
  })

  it('does not offer a button when the reply also asked a question', async () => {
    const inner = fakeEngine('claude', { delayMs: 1 })
    const r = new Runner({
      db,
      engines: {
        claude: inner,
        codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes'), endpoint: fakeEngine('endpoint')
      },
      settings: async () => settings,
      emit: () => {},
      workDir: mkdtempSync(join(tmpdir(), 'proceed-ask-')),
      gateway
    })
    // The fake engine asks through its tool when the prompt names ask_user (src/core/engines/fake.ts).
    await r.send('d1', '@lia pergunte algo')
    await r.idle()
    expect(proposalCard()).toBeUndefined()
  })
})
