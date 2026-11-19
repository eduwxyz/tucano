// A routine's runs in its conversation (src/renderer/src/routine-runs.ts): the routine's message rides on
// its reply, and runs in a row with nothing new (Run.noNews) fold into one line.
import { describe, expect, it } from 'vitest'
import { idsOf, shownMessages, spanOf, type Shown } from '../src/renderer/src/routine-runs'
import type { Message, Run } from '../src/shared/types'

const DAY = new Date(2026, 10, 16, 0, 0).getTime()
const H = 3_600_000
const ROUTINES = [{ id: 'gh', agentId: 'bento' }, { id: 'mail', agentId: 'bento' }]
let n = 0
const ask = (routine: string, at: number, extra: Partial<Message> = {}): Message => ({ id: `ask${++n}`, conversationId: 'dm', author: { kind: 'routine', id: routine }, text: 'Olhe o GitHub. Se não tiver nada novo, responda só “Sem novidade”.', at, routine: { name: routine === 'gh' ? 'Vigia do GitHub' : 'E-mail', scheduledAt: at, late: false }, ...extra })
const reply = (to: Message | undefined, at: number, run: Partial<Run> = {}, extra: Partial<Message> = {}): Message =>
  ({ id: `r${++n}`, conversationId: 'dm', author: { kind: 'agent', id: 'bento' }, text: run.noNews ? 'Sem novidade.' : 'Uma issue nova: #530.', at: at + 1000, run: { status: 'done', steps: [], endedAt: at + 60_000, ...(to ? { routineAsk: to.id } : {}), ...run }, ...extra }) as Message
const me = (text: string, at: number): Message => ({ id: `p${++n}`, conversationId: 'dm', author: { kind: 'person', id: 'ana' }, text, at })

// A run of routine `r` at hour `h` of the day: its message and the reply to it.
const run = (r: string, h: number, run: Partial<Run> = { noNews: true }, day = DAY): [Message, Message] => {
  const a = ask(r, day + h * H)
  return [a, reply(a, day + h * H, run)]
}
const kinds = (shown: Shown[]): string[] => shown.map((s) => (s.kind === 'message' ? `msg:${s.message.author.kind}${s.ask ? '+ask' : ''}` : `line:${s.runs.length}`))

describe('a routine’s runs in the conversation', () => {
  it('without routines, every message shows as it is', () => {
    const list = [me('oi', DAY), reply(undefined, DAY + 1000)]
    expect(shownMessages(list, ROUTINES)).toEqual(list.map((message) => ({ kind: 'message', message })))
  })

  it('a run with news shows whole, and the routine’s message rides on it instead of above it', () => {
    const [a, r] = run('gh', 12, {})
    const shown = shownMessages([a, r], ROUTINES)
    expect(shown).toEqual([{ kind: 'message', message: r, ask: a }])
  })

  it('runs in a row with nothing new fold into one line, with every run in it', () => {
    const list = [...run('gh', 9), ...run('gh', 10), ...run('gh', 11), ...run('gh', 12, {})]
    const shown = shownMessages(list, ROUTINES)
    expect(kinds(shown)).toEqual(['line:3', 'msg:agent+ask'])
    const line = shown[0] as Extract<Shown, { kind: 'no-news' }>
    expect(line).toMatchObject({ routineId: 'gh', name: 'Vigia do GitHub' })
    expect(line.runs.map((p) => p.reply.id)).toEqual([list[1]!.id, list[3]!.id, list[5]!.id])
    expect(line.runs.map((p) => p.ask.id)).toEqual([list[0]!.id, list[2]!.id, list[4]!.id])
  })

  it('a single run with nothing new is a line too', () => {
    expect(kinds(shownMessages(run('gh', 9), ROUTINES))).toEqual(['line:1'])
  })

  it('the line breaks at anything else said, at another routine, and at a new day', () => {
    const yesterday = DAY - 24 * H
    const list = [...run('gh', 16, undefined, yesterday), ...run('gh', 17, undefined, yesterday), ...run('gh', 9), me('e aí?', DAY + 9.5 * H), ...run('gh', 10), ...run('mail', 10.5), ...run('gh', 11)]
    expect(kinds(shownMessages(list, ROUTINES))).toEqual(['line:2', 'line:1', 'msg:person', 'line:1', 'line:1', 'line:1'])
  })

  it('a failure the routine got past folds in; one at the end shows whole, and failures alone never fold', () => {
    const failed = { status: 'failed' as const, error: 'O motor caiu.' }
    const passed = [...run('gh', 9), ...run('gh', 10, failed), ...run('gh', 11)]
    expect(kinds(shownMessages(passed, ROUTINES))).toEqual(['line:3'])
    const atEnd = [...run('gh', 9), ...run('gh', 10, failed)]
    expect(kinds(shownMessages(atEnd, ROUTINES))).toEqual(['line:1', 'msg:agent+ask'])
    expect(kinds(shownMessages([...run('gh', 9, failed), ...run('gh', 10, failed)], ROUTINES))).toEqual(['msg:agent+ask', 'msg:agent+ask'])
  })

  it('a run still working, or one with a thread, shows whole', () => {
    const [a, r] = run('gh', 10)
    const working = [...run('gh', 9), ...run('gh', 10, { status: 'working' })]
    expect(kinds(shownMessages(working, ROUTINES))).toEqual(['line:1', 'msg:agent+ask'])
    expect(kinds(shownMessages([...run('gh', 9), a, r], ROUTINES, (id) => id === r.id))).toEqual(['line:1', 'msg:agent+ask'])
    expect(kinds(shownMessages([...run('gh', 9), a, r], ROUTINES, (id) => id === a.id))).toEqual(['line:1', 'msg:agent+ask'])
  })

  it('a reply from before replies kept their routine’s message is the next one from its agent', () => {
    const a = ask('gh', DAY + 9 * H)
    const other = { ...reply(undefined, DAY + 8 * H), author: { kind: 'agent' as const, id: 'vera' } }
    const legacy = reply(undefined, DAY + 9 * H)
    const shown = shownMessages([a, { ...other, at: DAY + 9 * H + 10, run: { ...other.run!, endedAt: DAY + 9 * H + 20 } }, legacy], ROUTINES)
    expect(shown.map((s) => (s.kind === 'message' ? s.ask?.id : 'line'))).toEqual([undefined, a.id])
  })

  it('a routine’s message nobody answered (yet) still shows on its own', () => {
    const a = ask('gh', DAY + 9 * H)
    expect(shownMessages([a, me('oi', DAY + 10 * H)], ROUTINES)).toEqual([
      { kind: 'message', message: a },
      { kind: 'message', message: expect.objectContaining({ author: { kind: 'person', id: 'ana' } }) }
    ])
  })

  it('knows which shown item holds a message, so opening on it lands there', () => {
    const list = [...run('gh', 9), ...run('gh', 10)]
    const [line] = shownMessages(list, ROUTINES)
    expect(idsOf(line!).sort()).toEqual(list.map((m) => m.id).sort())
  })

  it('says the span of the runs, with the day when it isn’t today', () => {
    const now = DAY + 15 * H
    const fmt = (h: number): string => new Date(DAY + h * H).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    expect(spanOf([DAY + 9 * H, DAY + 11 * H], now)).toBe(`${fmt(9)}–${fmt(11)}`)
    expect(spanOf([DAY + 9 * H], now)).toBe(fmt(9))
    expect(spanOf([DAY + 9 * H - 24 * H, DAY + 17 * H - 24 * H], now)).toMatch(new RegExp(`· ${fmt(9)}–${fmt(17)}$`))
  })
})
