import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { dockerProblem, formatExec } from '../src/core/computer'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway, textResult } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const NO_DOCKER = 'O Docker não está rodando. Abra o Docker Desktop.'

let db: Db
let gateway: Gateway
let settings: Settings
let turns: Turn[]
let calls: string[]
let off: string | undefined // what `unavailable` says before a turn

function runner(): Runner {
  turns = []
  calls = []
  const fake = fakeEngine('claude', { delayMs: 1 })
  const claude: Engine = { id: 'claude', run: (t) => (turns.push(t), fake.run(t)) }
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
  // Docker is off: every call fails the same way, and says so.
  const computers = {
    call: async (_a: Agent, name: string) => (calls.push(name), { result: textResult(`O Docker não está disponível neste computador: ${NO_DOCKER}`, true), down: NO_DOCKER }),
    unavailable: async () => off
  }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'cd-w-')), gateway, computers })
}

const reply = () => db.messages().filter((m) => m.author.kind === 'agent').at(-1)!

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'cd-db-')), 'test.db'))
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent({ id: 'lia', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: true, archived: false })
  db.createConversation({ id: 'dm', kind: 'dm', name: 'lia', members: ['lia'] })
  off = undefined
  gateway = new Gateway()
  await gateway.start()
})
afterEach(() => gateway.stop())

describe('a computer whose Docker is off', () => {
  it('knows Docker is off, out of reach or not installed from what the docker command says', () => {
    expect(dockerProblem('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')).toContain('não está rodando')
    expect(dockerProblem('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock')).toContain('usermod')
    expect(dockerProblem('spawn docker ENOENT')).toContain('não está instalado')
    expect(dockerProblem('', true)).toContain('não está respondendo') // a quick check that never answered: stuck, every docker command waits
    expect(dockerProblem('Error: No such container: tucano-lia')).toBeUndefined() // Docker is fine: the box just isn't there yet
  })

  it('ends the turn at the first call, and tells the person what to do', async () => {
    const r = runner()
    await r.send('dm', 'rode `echo hi`')
    await r.idle()
    expect(calls).toEqual(['bash']) // one call, not one per tool
    expect(reply().run).toMatchObject({ status: 'failed' })
    expect(reply().run!.error).toContain('meu computador não está funcionando')
    expect(reply().run!.error).toContain(NO_DOCKER)
  })

  it('searching where nothing matches is no failure: commands that find nothing keep going', async () => {
    // A grep with no match exits 1 and prints nothing, the same text from every one: not a sign that
    // something around them is broken, so the reply goes on to its answer.
    const tries: Engine = {
      id: 'claude',
      async *run(turn) {
        for (const command of ['grep -rn TODO src', 'grep -rn FIXME src', 'grep -rn XXX src', 'grep -rn HACK src', 'ls src']) {
          if (turn.signal.aborted) return
          await callTool(turn.mcpUrl!, 'bash', { command }).catch(() => null)
          yield { type: 'text', delta: '.' }
        }
        if (!turn.signal.aborted) yield { type: 'done', text: 'Nenhum TODO, FIXME, XXX ou HACK no projeto.', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
      }
    }
    const engines: Record<EngineId, Engine> = { claude: tries, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
    const ran: string[] = []
    const computers = {
      call: async (_a: Agent, _n: string, args: Record<string, unknown>) => {
        const command = String(args['command'])
        ran.push(command)
        const ls = command.startsWith('ls')
        return { result: textResult(formatExec({ code: ls ? 0 : 1, stdout: ls ? 'app.ts' : '', stderr: '' }, 120), !ls) }
      }
    }
    const r = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'cd-w-')), gateway, computers })
    await r.send('dm', 'tem algum TODO, FIXME, XXX ou HACK no projeto?')
    await r.idle()
    expect(ran).toHaveLength(5)
    expect(reply().run).toMatchObject({ status: 'done' })
  })

  it('still off at the next message: no computer tools, and the agent is told why', async () => {
    off = NO_DOCKER
    const r = runner()
    await r.send('dm', 'rode `echo hi`')
    await r.idle()
    expect(calls).toEqual([]) // never reached the computer
    expect(turns[0]!.system).toContain(`Está fora do ar agora: ${NO_DOCKER}`)
    expect(turns[0]!.system).not.toContain('Você tem um computador Linux só seu')
    expect(reply().run!.status).toBe('done')
  })
})
