import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

// An image I attach is shown to the agent in the turn I sent it. After the agent answered
// it, later turns name it only ([imagem anexada: …]) and the agent looks again with ver_imagem
// if it needs to: the old image going in as an image every turn made the model comment on it
// again ("you're sending me an image") and paid its tokens on each reply.

const ready = { installed: true, loggedIn: true }
const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({ id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
const png = (bytes: number): string => Buffer.alloc(bytes, 7).toString('base64')

let db: Db
let settings: Settings
let turns: Turn[]
let gateway: Gateway | undefined

// `before`: what the agent does in its turn before answering (a tool call); `fail`: the turn errors.
function runner(opts: { sessions?: boolean; before?: (t: Turn) => Promise<void>; fail?: (t: Turn) => boolean; gateway?: Gateway } = {}): Runner {
  const claude = fakeEngine('claude', { delayMs: 1, sessions: opts.sessions })
  const recorded: Engine = {
    ...claude,
    run: (t) => {
      turns.push(t)
      return (async function* () {
        if (opts.fail?.(t)) return void (yield { type: 'error' as const, message: 'Internal server error' })
        await opts.before?.(t)
        yield* claude.run(t)
      })()
    }
  }
  const engines: Record<EngineId, Engine> = { claude: recorded, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ti-work-')), dataDir: mkdtempSync(join(tmpdir(), 'ti-data-')), gateway: opts.gateway })
}
async function toolNames(url: string): Promise<string[]> {
  const client = new Client({ name: 't', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  try {
    return (await client.listTools()).tools.map((t) => t.name)
  } finally {
    await client.close()
  }
}
// The agent's own replies: who answered which turn.
const agentTurns = (): Turn[] => turns.filter((t) => !t.system.includes('roteador') && !!t.blocks)

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ti-db-')), 'test.db'))
  turns = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent(agent('a1', 'lia'))
  db.saveAgent(agent('a2', 'theo'))
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
  db.createConversation({ id: 'c1', kind: 'channel', name: 'engenharia', members: ['a1', 'a2'] })
})
afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
})

describe('an attached image, only in its turn', () => {
  it('goes as an image once; the next replies name it and send no image (an engine without sessions)', async () => {
    const r = runner()
    await r.send('d1', 'olha esse erro', [{ name: 'print.png', mime: 'image/png', data: png(300_000) }])
    await r.idle()
    await r.send('d1', 'e agora, como resolvo?')
    await r.idle()
    await r.send('d1', 'valeu, outra coisa: qual o plano de amanhã?')
    await r.idle()

    const [first, second, third] = agentTurns()
    expect(first!.images).toHaveLength(1)
    for (const later of [second!, third!]) {
      expect(later.images ?? []).toEqual([])
      expect(later.prompt).toContain('[imagem anexada: print.png]') // still named where it was sent
    }
  })

  it('isn’t sent again when a kept session starts over (Claude Code)', async () => {
    const r = runner({ sessions: true })
    await r.send('d1', 'olha esse erro', [{ name: 'print.png', mime: 'image/png', data: png(1_000) }])
    await r.idle()
    db.saveAgent(agent('a1', 'lia', { instructions: 'Seja breve.' })) // a new system prompt: a new session, with the whole conversation
    await r.send('d1', 'e agora?')
    await r.idle()

    const [first, second] = agentTurns()
    expect(first!.images).toHaveLength(1)
    expect(second!.session).toMatchObject({ resume: false })
    expect(second!.images ?? []).toEqual([])
  })

  it('isn’t sent again on a resumed session either', async () => {
    const r = runner({ sessions: true })
    await r.send('d1', 'olha', [{ name: 'print.png', mime: 'image/png', data: png(1_000) }])
    await r.idle()
    await r.send('d1', 'e agora?')
    await r.idle()
    const [, second] = agentTurns()
    expect(second!.session).toMatchObject({ resume: true })
    expect(second!.images ?? []).toEqual([])
  })

  it('a new image in a later message goes, the old one doesn’t', async () => {
    const r = runner()
    await r.send('d1', 'primeiro', [{ name: 'a.png', mime: 'image/png', data: png(1_000) }])
    await r.idle()
    await r.send('d1', 'segundo', [{ name: 'b.png', mime: 'image/png', data: png(1_000) }])
    await r.idle()
    const [, second] = agentTurns()
    expect(second!.images!.map((i) => basename(i.path))).toEqual(['b.png'])
    expect(second!.blocks![second!.images![0]!.block]).toContain('segundo')
  })

  it('goes to an agent that hasn’t answered since it was sent, in a channel', async () => {
    const r = runner()
    await r.send('c1', '@lia olha esse print', [{ name: 'print.png', mime: 'image/png', data: png(1_000) }])
    await r.idle()
    await r.send('c1', '@theo e você, o que acha do print?')
    await r.idle()
    const [lia, theo] = agentTurns()
    expect(lia!.images).toHaveLength(1)
    expect(theo!.images).toHaveLength(1) // theo never saw it
  })

  it('goes again after a reply that failed (it never got answered)', async () => {
    let first = true
    const r = runner({ fail: (t) => !!t.blocks && first && !(first = false) })
    await r.send('d1', 'olha esse erro', [{ name: 'print.png', mime: 'image/png', data: png(1_000) }])
    await r.idle()
    const failed = db.messages().find((m) => m.author.kind === 'agent')
    expect(failed?.run?.status).not.toBe('done')
    await r.send('d1', 'e aí?')
    await r.idle()
    expect(agentTurns().at(-1)!.images).toHaveLength(1)
  })

  it('measures: bytes of images sent over five turns after one 300 KB screenshot', async () => {
    const r = runner()
    await r.send('d1', 'olha', [{ name: 'print.png', mime: 'image/png', data: png(300_000) }])
    await r.idle()
    for (const t of ['a', 'b', 'c', 'd']) {
      await r.send('d1', t)
      await r.idle()
    }
    const sent = agentTurns().reduce((n, t) => n + (t.images?.length ?? 0), 0)
    expect(sent).toBe(1) // was 5: the same screenshot with every reply
  })
})

describe('ver_imagem', () => {
  it('shows an image attached earlier, by name, when the agent asks for it', async () => {
    gateway = new Gateway()
    await gateway.start()
    let seen: unknown
    const r = runner({
      gateway,
      before: async (t) => {
        if (t.prompt.includes('mostra de novo') && t.mcpUrl) seen = await callTool(t.mcpUrl, 'ver_imagem', { nome: 'print.png' })
      }
    })
    await r.send('d1', 'olha', [{ name: 'print.png', mime: 'image/png', data: png(10) }])
    await r.idle()
    await r.send('d1', 'mostra de novo o print')
    await r.idle()
    const content = (seen as { content: { type: string; mimeType?: string }[] }).content
    expect(content.some((c) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true)
    expect(agentTurns().at(-1)!.images ?? []).toEqual([])
  })

  it('is there only when the conversation has an attached image', async () => {
    gateway = new Gateway()
    await gateway.start()
    const lists: string[][] = []
    const r = runner({
      gateway,
      before: async (t) => {
        if (t.mcpUrl && t.blocks) lists.push(await toolNames(t.mcpUrl))
      }
    })
    await r.send('d1', 'oi')
    await r.idle()
    await r.send('d1', 'olha', [{ name: 'print.png', mime: 'image/png', data: png(10) }])
    await r.idle()
    expect(lists[0]).not.toContain('ver_imagem')
    expect(lists[1]).toContain('ver_imagem')
  })
})
