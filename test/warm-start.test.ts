import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { claudeEngine } from '../src/core/engines/claude'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, EngineEvent, Turn } from '../src/core/engines/types'
import { routerTurn } from '../src/core/router'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const isWin = process.platform === 'win32'

function agent(id: string, handle: string, extra: Partial<Agent> = {}): Agent {
  return { id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra }
}

describe('while the person types', () => {
  let db: Db
  let settings: Settings
  let warmed: string[]
  let turns: Turn[]

  function runner(): Runner {
    const fake = fakeEngine('claude', { delayMs: 1, sessions: true, warmed })
    const claude: Engine = { ...fake, run: (t) => (turns.push(t), fake.run(t)) }
    const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
    return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ws-work-')) })
  }

  beforeEach(() => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ws-db-')), 'test.db'))
    warmed = []
    turns = []
    settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
    db.saveAgent(agent('a1', 'lia'))
    db.saveAgent(agent('a2', 'theo'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    db.createConversation({ id: 'c1', kind: 'channel', name: 'engenharia', members: ['a1', 'a2'] })
    db.createConversation({ id: 'c2', kind: 'channel', name: 'dados', members: ['a1'], threads: true })
  })

  it('in a DM, starts the agent’s kept session again, once it has one', async () => {
    const r = runner()
    await r.typing('d1')
    expect(warmed).toEqual([]) // nothing kept before the first reply
    await r.send('d1', 'oi')
    await r.idle()
    await r.typing('d1')
    expect(warmed).toEqual([`rewarm ${turns[0]!.session!.id}`])
  })

  it('in a channel of several agents, starts the router', async () => {
    const r = runner()
    await r.typing('c1')
    expect(warmed).toEqual(['warm haiku'])
  })

  it('in a channel, also starts the session of whoever answered last there', async () => {
    const r = runner()
    await r.send('c1', '@theo oi')
    await r.idle()
    warmed.length = 0
    await r.typing('c1')
    expect(warmed).toEqual([`rewarm ${turns[0]!.session!.id}`, 'warm haiku'])
  })

  it('opened without typing, starts the kept sessions but not the router', async () => {
    const r = runner()
    await r.typing('c1', undefined, true)
    expect(warmed).toEqual([])
    await r.send('c1', '@theo oi')
    await r.idle()
    warmed.length = 0
    await r.typing('c1', undefined, true)
    expect(warmed).toEqual([`rewarm ${turns[0]!.session!.id}`])
  })

  it('starts nothing for a new thread, when paused, or with the router’s harness signed out', async () => {
    const r = runner()
    await r.typing('c2') // answers in threads: a new message opens a new one
    r.setPaused(true)
    await r.typing('c1')
    r.setPaused(false)
    settings.engines.claude = { installed: true, loggedIn: false }
    await r.typing('c1')
    expect(warmed).toEqual([])
  })
})

describe('a Claude Code process started ahead', () => {
  let dir: string
  let bin: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-cli-'))
    const script = join(dir, 'fake-claude.mjs')
    copyFileSync(join(__dirname, 'fixtures', 'fake-claude.mjs'), script)
    if (isWin) {
      bin = join(dir, 'claude.cmd')
      writeFileSync(bin, '@"%~dp0\\fake-claude.mjs" %*\r\n')
    } else {
      bin = join(dir, 'claude')
      writeFileSync(bin, `#!/usr/bin/env node\n${readFileSync(script, 'utf8')}`)
      chmodSync(bin, 0o755)
    }
    mkdirSync(join(dir, 'config'))
  })

  const reply = async (events: AsyncIterable<EngineEvent>): Promise<string> => {
    let text = ''
    for await (const e of events) if (e.type === 'done') text = e.text
    else if (e.type === 'error') throw new Error(e.message)
    return text
  }
  const upOf = (text: string): number => Number(/up=(\d+)/.exec(text)?.[1])
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('takes the router’s next turn, already up, and only that one', async () => {
    const engine = claudeEngine(() => bin, async () => ({ env: {} }))
    const turn = (): Turn => ({ ...routerTurn('haiku', dir), prompt: 'quem responde?', signal: new AbortController().signal })
    engine.warm!(routerTurn('haiku', dir))
    await wait(2500) // a busy machine (the whole suite at once) takes over a second to boot node
    const warm = await reply(engine.run(turn()))
    expect(upOf(warm)).toBeGreaterThanOrEqual(1000)
    const cold = await reply(engine.run(turn())) // the spare is used up: a new process, as before
    expect(cold.split(' ')[0]).not.toBe(warm.split(' ')[0])
    expect(upOf(cold)).toBeLessThan(upOf(warm)) // started for this turn (a busy machine may take a second to start it)
    engine.dispose!()
  }, 30_000)

  it('starts a kept session’s process again, resuming it, for its next turn', async () => {
    const engine = claudeEngine(() => bin, async () => ({ env: {} }))
    const turn = (resume: boolean): Turn => ({ model: 'haiku', effort: 'low', system: 'x', prompt: 'oi', cwd: dir, account: join(dir, 'config'), signal: new AbortController().signal, session: { id: 's1', resume, keep: true } })
    await reply(engine.run(turn(false)))
    engine.dispose!() // as if it had closed after its five minutes
    engine.rewarm!('s1')
    await wait(2500) // a busy machine (the whole suite at once) takes over a second to boot node
    const next = await reply(engine.run(turn(true)))
    expect(next).toMatch(/turn=1 resume=true/)
    expect(upOf(next)).toBeGreaterThanOrEqual(1000)
    engine.rewarm!('unknown') // never seen: nothing to start
    engine.dispose!()
  }, 30_000)
})
