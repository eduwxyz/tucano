import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

// A file I attach that isn't an image (a PDF, a Word doc, a spreadsheet, text) is kept with my
// message, and what it says goes to the agent as text with that message, in any engine and with a
// computer or not. Like an image, only until the agent answered it: later turns name it, and the
// agent reads it again with ler_anexo.

const ready = { installed: true, loggedIn: true }
const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({ id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
// The smallest PDF with one line of text (as in wiki-extract.test.ts).
const pdf = (line: string): string => {
  const stream = `BT /F1 18 Tf 20 100 Td (${line}) Tj ET`
  return Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
    'latin1'
  ).toString('base64')
}
const text = (s: string): string => Buffer.from(s).toString('base64')

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
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'tf-work-')), dataDir: mkdtempSync(join(tmpdir(), 'tf-data-')), gateway: opts.gateway })
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
  db = new Db(join(mkdtempSync(join(tmpdir(), 'tf-db-')), 'test.db'))
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

describe('an attached file', () => {
  it('is kept with the message, and its text goes to the agent in that reply only', async () => {
    const r = runner()
    await r.send('d1', 'resume esse contrato', [], undefined, undefined, { files: [{ name: 'contrato.pdf', data: pdf('Contrato Silva e Souza, R$ 4.800') }] })
    await r.idle()
    await r.send('d1', 'e o prazo?')
    await r.idle()

    const kept = db.artifacts().find((a) => a.agentId === '' && a.name === 'contrato.pdf')
    expect(kept).toMatchObject({ kind: 'pdf', source: 'anexo' })
    expect(kept!.messageId).toBe(db.messages().find((m) => m.text === 'resume esse contrato')!.id)

    const [first, second] = agentTurns()
    expect(first!.prompt).toContain('[arquivo anexado: contrato.pdf]')
    expect(first!.prompt).toContain('Contrato Silva e Souza, R$ 4.800')
    expect(first!.images ?? []).toEqual([])
    expect(second!.prompt).toContain('[arquivo anexado: contrato.pdf]') // still named where it was sent
    expect(second!.prompt).not.toContain('Contrato Silva e Souza')
  })

  it('goes alone, with no text in the message', async () => {
    const r = runner()
    await r.send('d1', '', [], undefined, undefined, { files: [{ name: 'notas.txt', data: text('Reunião às 15h com a Ana') }] })
    await r.idle()
    expect(agentTurns()[0]!.prompt).toContain('Reunião às 15h com a Ana')
  })

  it('reads plain text the wiki doesn’t list (code, configs)', async () => {
    const r = runner()
    await r.send('d1', 'o que tem de errado?', [], undefined, undefined, { files: [{ name: 'app.py', data: text('def soma(a, b):\n    return a - b') }] })
    await r.idle()
    expect(agentTurns()[0]!.prompt).toContain('return a - b')
  })

  it('tells the agent when a file couldn’t be read, so it can say so', async () => {
    const r = runner()
    await r.send('d1', 'olha', [], undefined, undefined, { files: [{ name: 'foto.heic', data: Buffer.from([0, 1, 2, 3, 0, 255]).toString('base64') }] })
    await r.idle()
    expect(agentTurns()[0]!.prompt).toMatch(/\[arquivo anexado: foto\.heic\. Não deu pra ler o texto dele: .*\.heic/)
  })

  it('keeps the blocks a kept session compares as they are, and isn’t sent again when it resumes', async () => {
    const r = runner({ sessions: true })
    await r.send('d1', 'lê isso', [], undefined, undefined, { files: [{ name: 'n.md', data: text('Texto do anexo') }] })
    await r.idle()
    await r.send('d1', 'e agora?')
    await r.idle()
    const [, second] = agentTurns()
    expect(second!.session).toMatchObject({ resume: true })
    expect(second!.prompt).not.toContain('Texto do anexo')
  })

  it('cuts a long text, saying where ler_anexo goes on', async () => {
    const r = runner()
    await r.send('d1', 'lê', [], undefined, undefined, { files: [{ name: 'longo.txt', data: text('a'.repeat(120_000)) }] })
    await r.idle()
    expect(agentTurns()[0]!.prompt).toContain('Leia com ler_anexo, de: 100000')
  })
})

describe('ler_anexo', () => {
  it('reads an attached file again, by name, and from where it was cut', async () => {
    gateway = new Gateway()
    await gateway.start()
    const seen: unknown[] = []
    const lists: string[][] = []
    const r = runner({
      gateway,
      before: async (t) => {
        if (t.mcpUrl && t.blocks) lists.push(await toolNames(t.mcpUrl))
        if (t.prompt.includes('lê de novo') && t.mcpUrl) {
          seen.push(await callTool(t.mcpUrl, 'ler_anexo', { nome: 'contrato.pdf' }))
          seen.push(await callTool(t.mcpUrl, 'ler_anexo', { nome: 'contrato.pdf', de: 9 }))
        }
      }
    })
    await r.send('d1', 'oi')
    await r.idle()
    await r.send('d1', 'olha', [], undefined, undefined, { files: [{ name: 'contrato.pdf', data: pdf('Contrato Silva e Souza') }] })
    await r.idle()
    await r.send('d1', 'lê de novo o contrato')
    await r.idle()
    expect(lists[0]).not.toContain('ler_anexo')
    expect(lists[1]).toContain('ler_anexo')
    const textOf = (x: unknown): string => (x as { content: { text: string }[] }).content.map((c) => c.text).join('')
    expect(textOf(seen[0])).toContain('Contrato Silva e Souza')
    expect(textOf(seen[1])).toContain('a partir do caractere 9')
  })
})
