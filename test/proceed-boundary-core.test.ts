// Core integration for the three-way decision in src/core/runs.ts: a next_steps card wins over the
// reply's words, an ask_user question wins over both, and only a bare one-action offer gets proceed.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { hasOpenProceed, hasOpenSteps } from '../src/shared/questions'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const PROPOSAL = 'They’re still sitting there unstaged; say the word and I’ll restore all six, one branch each.'
const WITH_CARD = "I've checked everything. Say the word and I'll do all three steps myself."

const agent = (): Agent => ({
  id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet',
  effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false
})

const lastMessage = (prompt: string): string => {
  const blocks = prompt.split(/\n\n|\n(?=\[)/).filter((b) => b.startsWith('['))
  return blocks.at(-1)?.replace(/^\[[^\]]*\]\s*/, '') ?? ''
}

describe('proceed versus next steps in the runner', () => {
  let db: Db
  let settings: Settings
  let gateway: Gateway
  let prompts: string[]

  // A reply that carried a real next_steps tool call and said "say the word" in its text.
  const cardWithWords = (): Engine => {
    const inner = fakeEngine('claude', { delayMs: 1, reply: () => WITH_CARD })
    return {
      ...inner,
      run: (turn: Turn) => (async function* () {
        if (turn.mcpUrl && /pr[oó]ximos passos/i.test(lastMessage(turn.prompt)))
          await callTool(turn.mcpUrl, 'next_steps', {
            steps: [{ label: 'Rodar a suíte' }, { label: 'Traduzir os rótulos' }, { label: 'Escrever o teste' }]
          })
        yield* inner.run(turn)
      })()
    }
  }

  const runner = (claude: Engine): Runner => {
    const spy: Engine = {
      ...claude,
      run: (turn: Turn) => {
        prompts.push([...(turn.blocks ?? []), turn.prompt].join('\n'))
        return claude.run(turn)
      }
    }
    const engines = (c: Engine): Record<EngineId, Engine> => ({
      claude: c, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'),
      antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'),
      cline: fakeEngine('cline'), hermes: fakeEngine('hermes'), endpoint: fakeEngine('endpoint')
    })
    return new Runner({ db, engines: engines(spy), settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'boundary-work-')), gateway })
  }

  const agentMessages = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'boundary-')), 'test.db'))
    settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
    db.saveAgent(agent())
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    gateway = new Gateway()
    await gateway.start()
    prompts = []
    return () => gateway.stop()
  })

  it('a: text with one action and no tool card gets proceed, not steps', async () => {
    const r = runner(fakeEngine('claude', { delayMs: 1, reply: () => PROPOSAL }))
    await r.send('d1', '@lia prepare the restore')
    await r.idle()
    const reply = agentMessages().at(-1)!
    expect(reply.text).toBe(PROPOSAL)
    expect(reply.run?.proceedOpen).toBe(true)
    expect(reply.run?.stepsOpen).toBeFalsy()
    expect(hasOpenProceed(reply.run)).toBe(true)
    expect(hasOpenSteps(reply.run)).toBe(false)
    expect(reply.run?.questions?.[0]).toMatchObject({ proceed: true, kind: 'text', question: PROPOSAL })
  })

  it('b: a next_steps card with three steps and say-the-word text gets steps, not proceed', async () => {
    const r = runner(cardWithWords())
    await r.send('d1', '@lia próximos passos')
    await r.idle()
    const reply = agentMessages().at(-1)!
    expect(reply.text).toMatch(/say the word/i)
    expect(reply.run?.stepsOpen).toBe(true)
    expect(reply.run?.proceedOpen).toBeFalsy()
    expect(hasOpenSteps(reply.run)).toBe(true)
    expect(hasOpenProceed(reply.run)).toBe(false)
    expect(reply.run?.questions?.[0]?.nextSteps).toBe(true)
    expect(reply.run?.questions?.[0]?.options).toHaveLength(3)
  })

  it('c: an ask_user question gets neither card', async () => {
    const r = runner(fakeEngine('claude', { delayMs: 1 }))
    await r.send('d1', '@lia me ajuda a decidir')
    await r.idle()
    const reply = agentMessages().at(-1)!
    expect(reply.run?.status).toBe('waiting_input')
    expect(reply.run?.proceedOpen).toBeFalsy()
    expect(reply.run?.stepsOpen).toBeFalsy()
    expect(hasOpenProceed(reply.run)).toBe(false)
    expect(hasOpenSteps(reply.run)).toBe(false)
  })

  it('d: a plain done reply gets neither card', async () => {
    const r = runner(fakeEngine('claude', { delayMs: 1, reply: () => 'Instalei beautifulsoup4 e rodei os testes.' }))
    await r.send('d1', '@lia instale')
    await r.idle()
    const reply = agentMessages().at(-1)!
    expect(reply.text).toBe('Instalei beautifulsoup4 e rodei os testes.')
    expect(reply.run?.status).toBe('done')
    expect(reply.run?.proceedOpen).toBeFalsy()
    expect(reply.run?.stepsOpen).toBeFalsy()
  })

  it('approving a: no person message, and the follow-up task carries the proposal paragraph', async () => {
    const r = runner(fakeEngine('claude', { delayMs: 1, reply: () => PROPOSAL }))
    await r.send('d1', '@lia prepare the restore')
    await r.idle()
    const card = agentMessages().find((m) => hasOpenProceed(m.run))!
    const people = db.messages().filter((m) => m.author.kind === 'person').length
    const replies = agentMessages().length
    prompts.length = 0

    await r.submitDecisions(card.id, db.owner())
    await r.idle()

    expect(db.messages().filter((m) => m.author.kind === 'person')).toHaveLength(people)
    expect(agentMessages()).toHaveLength(replies + 1)
    expect(db.message(card.id)!.run).toMatchObject({ status: 'done', answeredBy: db.owner().id })
    expect(hasOpenProceed(db.message(card.id)!.run)).toBe(false)
    const followUp = prompts.filter((p) => p.includes(PROPOSAL)).at(-1) ?? ''
    expect(followUp).toContain(PROPOSAL)
    expect(/A pessoa aprovou a proposta abaixo|The person approved the proposal below/.test(followUp)).toBe(true)
  })
})
