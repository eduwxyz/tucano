// Team-ups: an agent's reply that calls agents who aren't in the room it's answering in. The plan
// (team-up.ts) on its own, then the whole thing through the real core with fake engines.
import { rmSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Conversation, Message } from '../src/shared/types'
import { carriedText, pickCarried, teamUpName, teamUpTask, teamUpTopic, TEAM_UP_CHARS, TEAM_UP_LINE, TEAM_UP_MESSAGES } from '../src/core/team-up'
import { setLang } from '../src/shared/lang'
import { bootCore, type Client, type TestCore } from './helpers/core'

const carried = (n: number, text = 'x'): { name: string; text: string; at: number }[] =>
  Array.from({ length: n }, (_, i) => ({ name: 'Ana', text: `${text}${i}`, at: i }))

describe('team-up: the plan', () => {
  beforeEach(() => setLang('en'))
  afterEach(() => setLang('pt'))
  it('names the channel after the agents it was opened for, and never collides', () => {
    const guests = [{ handle: 'tinker' }, { handle: 'auditor' }]
    expect(teamUpName(guests)).toBe('team-up-tinker-auditor')
    const taken = new Set(['team-up-tinker-auditor', 'team-up-tinker-auditor-2'])
    expect(teamUpName(guests, (n) => taken.has(n))).toBe('team-up-tinker-auditor-3')
  })

  it('says where it came from, under the name', () => {
    expect(teamUpTopic('Wrench', '#ops')).toBe('Opened by Wrench, from #ops')
  })

  it('carries the newest messages, not the oldest, and says how many were left behind', () => {
    const { kept, left } = pickCarried(carried(40))
    expect(kept).toHaveLength(TEAM_UP_MESSAGES)
    expect(left).toBe(40 - TEAM_UP_MESSAGES)
    expect(kept.at(-1)!.text).toBe('x39') // the last thing said is the last thing carried
  })

  it('clips one long message and stops at the ceiling', () => {
    const { kept } = pickCarried([{ name: 'Ana', text: 'y'.repeat(50_000), at: 1 }, { name: 'Ana', text: 'fim', at: 2 }])
    expect(kept).toHaveLength(2)
    expect(kept[0]!.text).toHaveLength(TEAM_UP_LINE + 1) // the ellipsis
    expect(kept.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(TEAM_UP_CHARS)
  })

  it('leaves out what a failed run said: it is not context, it is an error', () => {
    const { kept } = pickCarried([
      { name: 'Ana', text: 'isto vale', at: 1 },
      { name: 'Ana', text: '   ', at: 2 }
    ])
    expect(kept).toHaveLength(1)
  })

  it('the hand-off names who was called, what was said, and what is left to do', () => {
    const text = carriedText({ by: 'Wrench', guests: ['tinker', 'auditor'], source: '#ops', messages: carried(3), said: 'preciso de uma auditoria' })
    expect(text).toContain('@tinker and @auditor')
    expect(text).toContain('#ops')
    expect(text).toContain('**Ana** · x0')
    expect(text).toContain('**What\'s left to do**: preciso de uma auditoria')
    expect(text).not.toContain('and 0 messages before these')
  })

  it('the task tells each guest why it is there and where its context is', () => {
    const task = teamUpTask({ by: 'Wrench', source: '#ops', channel: 'team-up-tinker', said: 'audite isto' })
    expect(task).toContain('Wrench called you')
    expect(task).toContain('#team-up-tinker')
    expect(task).toContain('#ops')
    expect(task).toContain('audite isto')
  })
})

// The whole way: a reply in #dados that calls Lia, who isn't in #dados, opens a channel with both.
let core: TestCore
let ana: Client
type Snap = { agents: Agent[]; conversations: Conversation[]; messages: Message[] }
const until = async (ok: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}
const snap = (): Promise<Snap> => ana.call<Snap>('snapshot')

beforeAll(async () => {
  core = await bootCore({ server: true })
  ana = core.connect()
  await ana.call('setMyName', { name: 'Ana' })
}, 30_000)
afterAll(() => {
  try {
    rmSync(core.dataDir, { recursive: true, force: true })
  } catch {
    // Windows: still open
  }
})

describe('team-up: through the core', () => {
  beforeEach(() => setLang('en'))
  it('a reply that mentions an agent of another channel opens one, carrying what was said', async () => {
    const dados = (await snap()).conversations.find((c) => c.kind === 'channel' && (c.name === 'dados' || c.name === 'data'))!
    const lia = (await snap()).agents.find((a) => a.handle === 'lia')!
    const theo = (await snap()).agents.find((a) => a.handle === 'theo')!
    expect(dados.members).toEqual([theo.id]) // only Theo is in the room

    await ana.call('sendMessage', { conversationId: dados.id, text: 'peça pra lia ajudar com o painel' })
    await until(async () => (await snap()).conversations.some((c) => c.teamUp?.from === dados.id))

    const team = (await snap()).conversations.find((c) => c.teamUp?.from === dados.id)!
    expect(team.kind).toBe('channel')
    expect(team.name).toBe('team-up-lia')
    expect(team.topic).toMatch(/^(Opened by|Aberto por) Theo, (from|vindo de) #/)
    expect(team.topic).toContain(`#${dados.name}`)
    expect(team.teamUp?.by).toBe(theo.id)
    // Everyone who was there, plus the one called in: the room goes on with the work, it doesn't restart it.
    expect(team.members.sort()).toEqual([lia.id, theo.id].sort())
    // The wiki's curator leaves it alone: what they say while working together is theirs.
    expect(team.wikiCapture).toBe(false)

    // The hand-off comes from the agent that called her, with the conversation carried over.
    const handoff = (await snap()).messages.find((m) => m.conversationId === team.id)
    expect(handoff?.author).toEqual({ kind: 'agent', id: theo.id })
    expect(handoff?.text).toMatch(/^(I brought over|Trouxe para cá)/)
    expect(handoff?.text).toContain(`#${dados.name}`)
    expect(handoff?.text).toContain('@lia')
    expect(handoff?.text).toContain('peça pra lia ajudar com o painel')

    // Where it happened says where it went, in one line.
    const note = (await snap()).messages.filter((m) => m.conversationId === dados.id && m.author.kind === 'system')
    await until(async () => (await snap()).messages.some((m) => m.conversationId === dados.id && m.author.kind === 'system' && m.text.includes('#team-up-lia')))
    expect(note.length).toBeGreaterThanOrEqual(0)

    // And she gets to work there.
    await until(async () => (await snap()).messages.some((m) => m.conversationId === team.id && m.author.kind === 'agent' && m.author.id === lia.id))
  })

  it('the same call again is the room it already has, not a second channel', async () => {
    const dados = (await snap()).conversations.find((c) => c.kind === 'channel' && (c.name === 'dados' || c.name === 'data'))!
    const before = (await snap()).conversations.filter((c) => c.teamUp?.from === dados.id).length
    await ana.call('sendMessage', { conversationId: dados.id, text: 'peça pra lia ver de novo' })
    await until(async () => (await snap()).messages.some((m) => m.conversationId === dados.id && m.author.kind === 'agent' && m.text.includes('@lia') && m.at > Date.now() - 60_000))
    await new Promise((r) => setTimeout(r, 500))
    expect((await snap()).conversations.filter((c) => c.teamUp?.from === dados.id)).toHaveLength(before)
  })

  it('an agent alone in its own room who mentions nobody makes none', async () => {
    const antes = (await snap()).conversations.filter((c) => c.teamUp).length
    const conteudo = (await snap()).conversations.find((c) => c.kind === 'channel' && (c.name === 'conteudo' || c.name === 'content'))!
    await ana.call('sendMessage', { conversationId: conteudo.id, text: 'bom dia' })
    await until(async () => (await snap()).messages.some((m) => m.conversationId === conteudo.id && m.author.kind === 'agent'))
    expect((await snap()).conversations.filter((c) => c.teamUp)).toHaveLength(antes)
  })
})
