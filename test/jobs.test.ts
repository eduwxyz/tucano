// What a message sets off, until it's done (src/core/jobs.ts): the brakes that stop work that no longer
// moves, what counts as moving, the note left where it stopped, and going on after it.
import { beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { Run, Step } from '../src/shared/types'
import { countAsk, IDLE_STOP, JOB_MAX_REPLIES, jobTurn, newJob, overlap, progressOf, QUIET_STOP_MS, resumeJob, SAME_STOP, sameReply, stopNote, withoutGoal, type Job } from '../src/core/jobs'

const step = (label: string, status: Step['status'] = 'done', detail?: string): Step => ({ id: label, label, status, ...(detail ? { detail } : {}) })
const run = (steps: Step[], extra: Partial<Run> = {}): Run => ({ status: 'done', depth: 1, steps, ...extra })
const long = (seed: string): string => Array.from({ length: 70 }, (_, i) => `${seed}${i}`).join(' ') // 300+ characters, its own words
const job = (now = 1_000): Job => newJob({ id: 'j1', conversationId: 'c1', text: 'faça a landing' }, now)
const idle = ['olhei aqui', 'sem mudança', 'continuo esperando', 'ainda nada', 'vou ver depois', 'hm, talvez'] // short, and each its own
// jobTurn with a clock: the brakes read `now`.
const jobTurnOf = (j: Job, t: ReturnType<typeof turn>, now = 1_000) => jobTurn(j, t, now)
const turn = (agentId: string, text: string, r?: Run, extra: { answers?: boolean; handedOn?: number } = {}) => ({ agentId, agentName: agentId[0]!.toUpperCase() + agentId.slice(1), text, ...(r ? { run: r } : {}), ...extra })

beforeEach(() => setLang('pt'))

describe('reading the old /objetivo', () => {
  it('reads "/objetivo …" and "/goal …" as the message itself, and leaves anything else alone', () => {
    expect(withoutGoal('/objetivo landing page aprovada')).toBe('landing page aprovada')
    expect(withoutGoal('  /Goal ship it')).toBe('ship it')
    expect(withoutGoal('/objetivo')).toBe('')
    expect(withoutGoal('o objetivo é outro')).toBe('o objetivo é outro')
    expect(withoutGoal('/objetivos da semana')).toBe('/objetivos da semana')
  })

  it('tells a reply apart from the same one said again, loosely', () => {
    expect(sameReply('Corrigi. @rev', 'corrigi @rev!')).toBe(true)
    expect(sameReply('Corrigi o botão. @rev', 'Corrigi o título. @rev')).toBe(false)
    expect(sameReply('', '')).toBe(false)
    expect(overlap('o deploy da landing saiu agora', 'o deploy da landing saiu agora')).toBe(1)
    expect(overlap('deploy landing', 'relatório vendas')).toBe(0)
  })
})

describe('what counts as moving', () => {
  it('a tool that did something and came back well, or a file made; not one that only looked, asked or waited', () => {
    expect(progressOf(run([step('Pensou'), step('Rodou um comando', 'done', 'npm   test'), step('Leu o arquivo'), step('Pediu a Bia'), step('Esperando pra tentar de novo'), step('Editou um arquivo', 'error')]))).toEqual(['Rodou um comando: npm test'])
    expect(progressOf(run([], { artifactIds: ['a1'] }))).toEqual(['Entregou um arquivo'])
    expect(progressOf(run([], { artifactIds: ['a1', 'a2'] }))).toEqual(['Entregou 2 arquivos'])
    expect(progressOf(undefined)).toEqual([])
  })
})

describe('the brakes', () => {
  it(`stops after ${IDLE_STOP} replies in a row that moved nothing`, () => {
    const j = job()
    expect(jobTurnOf(j, turn('dev', '@rev, sua vez'))).toBeUndefined()
    expect(jobTurnOf(j, turn('rev', '@dev, sua vez'))).toBeUndefined()
    expect(j.idle).toBe(2)
    expect(jobTurnOf(j, turn('dev', '@rev, de novo?'))).toBe('idle')
    expect(j).toMatchObject({ state: 'stopped', why: 'idle', replies: 3 })
    expect(j.endedAt).toBeDefined()
  })

  it('starts the count over at a reply that moved: a tool that changed something, a long new text, an answer to a request, a new request handed on', () => {
    const j = job()
    jobTurnOf(j, turn('dev', 'olhei'))
    jobTurnOf(j, turn('rev', 'hm'))
    expect(jobTurnOf(j, turn('dev', 'Rodei os testes.', run([step('Rodou um comando', 'done', 'npm test')])))).toBeUndefined()
    expect(j.idle).toBe(0)
    expect(j.done).toEqual(['Dev: Rodou um comando: npm test'])
    jobTurnOf(j, turn('rev', 'ok'))
    expect(jobTurnOf(j, turn('rev', long('parte')))).toBeUndefined()
    expect(j.idle).toBe(0)
    jobTurnOf(j, turn('bia', 'ok'))
    jobTurnOf(j, turn('bia', 'O e-mail dele é x@y.com', undefined, { answers: true }))
    expect(j.idle).toBe(0)
    jobTurnOf(j, turn('orion', ''))
    jobTurnOf(j, turn('orion', '', run([step('Pediu a Clara')]), { handedOn: 2 }))
    expect(j.idle).toBe(0)
    expect(j.done.at(-1)).toBe('Orion: passou 2 partes adiante')
    expect(j.state).toBe('running')
  })

  it('does not count the same long text from the same agent as new', () => {
    const j = job()
    const text = long('relatório')
    jobTurnOf(j, turn('dev', text))
    expect(j.idle).toBe(0)
    jobTurnOf(j, turn('dev', `${text} fim`))
    expect(j.idle).toBe(1)
  })

  it(`stops when the same agent says the same ${SAME_STOP} times, even while its tools keep running`, () => {
    const j = job()
    const busy = run([step('Rodou um comando', 'done', 'ls')])
    expect(jobTurnOf(j, turn('dev', 'Corrigi. @rev', busy))).toBeUndefined()
    jobTurnOf(j, turn('rev', 'Falta o botão. @dev', busy))
    expect(jobTurnOf(j, turn('dev', 'corrigi @rev!', busy))).toBeUndefined()
    jobTurnOf(j, turn('rev', 'Ainda falta o botão. @dev', busy))
    expect(jobTurnOf(j, turn('dev', 'Corrigi! @rev', busy))).toBe('circle')
    expect(j).toMatchObject({ state: 'stopped', why: 'circle', circleBy: 'Dev' })
  })

  it(`stops when the same request goes to the same agent ${SAME_STOP} times`, () => {
    const j = job()
    expect(countAsk(j, 'bia', 'Revise o PR #12.')).toBe(1)
    expect(countAsk(j, 'bia', 'revise o PR 12')).toBe(2)
    expect(countAsk(j, 'theo', 'revise o PR 12')).toBe(1) // another agent: another request
    expect(jobTurnOf(j, turn('dev', 'pedi de novo', run([step('Rodou um comando')])))).toBeUndefined()
    expect(countAsk(j, 'bia', 'Revise o PR #12')).toBe(3)
    expect(jobTurnOf(j, turn('dev', 'pedi mais uma vez', run([step('Editou um arquivo')])))).toBe('circle')
    expect(j.circleBy).toBe('Dev')
  })

  it('stops after hours with nothing new, before the replies in a row add up', () => {
    const j = job(0)
    expect(jobTurnOf(j, turn('dev', 'esperando'), QUIET_STOP_MS - 1)).toBeUndefined()
    expect(jobTurnOf(j, turn('rev', 'ainda esperando'), QUIET_STOP_MS)).toBe('quiet')
    expect(j.idle).toBe(2)
  })

  it(`stops at the backstop of ${JOB_MAX_REPLIES} replies, however much each one moves`, () => {
    const j = job()
    for (let i = 1; i < JOB_MAX_REPLIES; i++) expect(jobTurnOf(j, turn(`a${i}`, long(`r${i}x`)))).toBeUndefined()
    expect(jobTurnOf(j, turn('z', long('ultima')))).toBe('cap')
    expect(j.replies).toBe(JOB_MAX_REPLIES)
  })
})

describe('the note, and going on after it', () => {
  it('says why it stopped, what got done and where, and how to go on', () => {
    const j = job()
    jobTurnOf(j, turn('dev', 'Fiz.', run([step('Editou um arquivo', 'done', 'index.html')])))
    for (const t of idle.slice(0, 3)) jobTurnOf(j, turn('rev', t))
    const note = stopNote(j, { name: 'Rev', text: `${'muito texto '.repeat(40)}` })
    expect(note).toMatch(/^\*\*Parei este trabalho\*\*: foram 3 respostas seguidas sem nada novo/)
    expect(note).toContain('**Feito até aqui**\n- Dev: Editou um arquivo: index.html')
    expect(note).toContain('**Onde parou**: Rev disse por último: “muito texto')
    expect(note).toContain('…”')
    expect(note).toContain('clique em Continuar')
    expect(stopNote({ ...job(), why: 'circle', circleBy: 'Dev → Bia' })).toContain('andando em círculos (Dev → Bia voltou ao mesmo ponto)')
    expect(stopNote({ ...job(), why: 'quiet' })).toContain('faz 2 horas que nada avança')
    expect(stopNote({ ...job(), why: 'cap' })).toContain(`chegou a ${JOB_MAX_REPLIES} respostas`)
    expect(stopNote(job())).toContain('Nada ficou pronto ainda.')
  })

  it('reads in English too', () => {
    setLang('en')
    expect(stopNote({ ...job(), why: 'idle' })).toMatch(/^\*\*I stopped this work\*\*: 3 replies in a row brought nothing new/)
  })

  it('starts the counts over on Continuar, keeping what got done', () => {
    const j = job(0)
    jobTurnOf(j, turn('dev', 'Fiz.', run([step('Editou um arquivo')])), 0)
    countAsk(j, 'bia', 'revise')
    for (const t of idle.slice(0, 3)) jobTurnOf(j, turn('rev', t), 10)
    expect(j.state).toBe('stopped')
    resumeJob(j, 500)
    expect(j).toMatchObject({ state: 'running', idle: 0, replies: 0, lastProgressAt: 500, repeats: {}, asks: {}, done: ['Dev: Editou um arquivo'] })
    expect(j.why).toBeUndefined()
    expect(j.endedAt).toBeUndefined()
    // The brakes count again from there.
    for (const t of idle.slice(3, 5)) expect(jobTurnOf(j, turn('rev', t), 600)).toBeUndefined()
    expect(jobTurnOf(j, turn('rev', idle[5]!), 700)).toBe('idle')
  })
})

