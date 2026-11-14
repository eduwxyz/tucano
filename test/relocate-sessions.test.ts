import { describe, expect, it } from 'vitest'
import type { Engine, EngineEvent, Turn } from '../src/core/engines/types'
import { relocating } from '../src/core/engines/relocate'

const turn = (session?: Turn['session']): Turn => ({ model: 'm', effort: 'low', system: '', prompt: 'oi', cwd: '/tmp', signal: new AbortController().signal, ...(session ? { session } : {}) }) as Turn
const all = async (events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> => {
  const out: EngineEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

// An engine like Codex: it keeps sessions only while it can, and a turn that resumes one it never
// kept fails at once.
function codexLike(): { engine: Engine; state: { keeps: boolean } } {
  const state = { keeps: true }
  const kept = new Set<string>()
  const engine: Engine = {
    id: 'codex',
    get sessions() {
      return state.keeps
    },
    async *run(t) {
      if (t.session?.resume && !kept.has(t.session.id)) return void (yield { type: 'error', message: 'no longer has this conversation' })
      if (t.session && state.keeps) kept.add(t.session.id)
      yield { type: 'done', text: 'ok', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
    }
  }
  return { engine, state }
}

describe('an engine wrapped to find its CLI again', () => {
  it('says whether it keeps sessions as it stands now, not as it stood when wrapped', () => {
    const { engine, state } = codexLike()
    const wrapped = relocating(engine, { path: () => undefined, label: 'Codex', redetect: async () => {} })
    expect(wrapped.sessions).toBe(true)
    state.keeps = false // its app-server can't take every turn any more
    expect(wrapped.sessions).toBe(false)
    state.keeps = true
    expect(wrapped.sessions).toBe(true)
  })

  it('so a runner that asks before each reply never resumes a conversation the engine did not keep', async () => {
    const { engine, state } = codexLike()
    const wrapped = relocating(engine, { path: () => undefined, label: 'Codex', redetect: async () => {} })
    state.keeps = false
    // What the runner does: a session only while the engine says it keeps them.
    const reply = (id: string, resume: boolean): Promise<EngineEvent[]> => all(wrapped.run(turn(wrapped.sessions ? { id, resume, keep: true } : undefined)))
    expect((await reply('s1', false)).at(-1)?.type).toBe('done')
    expect((await reply('s1', true)).at(-1)?.type).toBe('done') // with the copy it was an error, every other reply
  })
})
