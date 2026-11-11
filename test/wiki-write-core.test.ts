// Through the real core: an agent set to read and write keeps the wiki while it answers, its write
// turns into a version with the agent as the author, and the same agent set back to read only is not
// given the tool at all.
import { beforeAll, describe, expect, it } from 'vitest'
import type { Agent, Message, WikiVersion } from '../src/shared/types'
import { bootCore, type Client } from './helpers/core'

let ana: Client
let lia: Agent
let dm: string
const crashes: unknown[] = []
const onCrash = (e: unknown): void => void crashes.push(e)

const until = async (ok: () => boolean | Promise<boolean>, ms = 8000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}
const ask = (text: string): Promise<void> => ana.call('sendMessage', { conversationId: dm, text })
// The last reply the agent gave, once it ended.
const settled = async (since: number): Promise<Message> => {
  let last: Message | undefined
  await until(async () => {
    const snap = await ana.call<{ messages: Message[] }>('snapshot')
    last = snap.messages.filter((m) => m.conversationId === dm && m.author.kind === 'agent' && m.at >= since && m.run?.status !== 'working').at(-1)
    return !!last
  })
  return last!
}

beforeAll(async () => {
  process.on('unhandledRejection', onCrash)
  process.on('uncaughtException', onCrash)
  const core = await bootCore({ server: true })
  ana = core.connect()
  await ana.call('setMyName', { name: 'Ana' })
  const snap = await ana.call<{ agents: Agent[] }>('snapshot')
  lia = snap.agents.find((a) => a.handle === 'lia')!
  dm = await ana.call<string>('openDm', { agentId: lia.id })
}, 40_000)

describe('an agent that keeps the wiki', () => {
  it('(setup) one plain reply first, so the local tool server is up', async () => {
    await ana.call('saveAgent', { agent: { ...lia, wiki: 'read_write' }, channelIds: [] })
    const at = Date.now()
    await ask('oi')
    expect((await settled(at)).run).toMatchObject({ status: 'done' })
  })

  it('writes the page it was asked to write, and the version says it was her', async () => {
    const at = Date.now()
    await ask('anote na wiki: Viagem a Morretes | Trem pela Serra do Mar em fevereiro.')
    const reply = await settled(at)
    expect(reply.text).toContain('Anotei na wiki')
    const step = reply.run!.steps.find((s) => s.label.includes('Criou na wiki'))!
    expect(step).toMatchObject({ detail: 'Viagem a Morretes', status: 'done' })
    const page = await ana.call<{ title: string; body: string } | null>('wikiPage', { title: 'Viagem a Morretes' })
    expect(page?.body).toContain('Trem pela Serra do Mar em fevereiro.')
    const history = await ana.call<WikiVersion[]>('wikiHistory', { title: 'Viagem a Morretes' })
    expect(history[0]).toMatchObject({ by: lia.id, action: 'create' })
  })

  it('adds to the page it already wrote, instead of writing over it', async () => {
    const at = Date.now()
    await ask('anote na wiki: Viagem a Morretes | Ficamos três dias.')
    const reply = await settled(at)
    expect(reply.run!.steps.some((s) => s.label.includes('Escreveu na wiki'))).toBe(true)
    const page = await ana.call<{ body: string }>('wikiPage', { title: 'Viagem a Morretes' })
    expect(page.body).toContain('Trem pela Serra do Mar em fevereiro.')
    expect(page.body).toContain('Ficamos três dias.')
  })

  it('is not given the tool once it is back to reading, and the run says so', async () => {
    await ana.call('saveAgent', { agent: { ...lia, wiki: 'read' }, channelIds: [] })
    const at = Date.now()
    await ask('anote na wiki: Outra página | Isto não devia entrar.')
    const reply = await settled(at)
    expect(reply.run!.steps.some((s) => s.label.includes('Escreveu na wiki'))).toBe(false)
    expect(await ana.call('wikiPage', { title: 'Outra página' })).toBeNull()
    expect(await ana.call<WikiVersion[]>('wikiHistory', { title: 'Outra página' })).toEqual([])
  })

  it('nobody crashed on the way', () => {
    expect(crashes).toEqual([])
  })
})
