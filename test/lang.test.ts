import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { systemPrompt } from '../src/core/context'
import { Db } from '../src/core/db'
import { linuxTools } from '../src/core/computer'
import { outcome } from '../src/core/routines'
import { Skills } from '../src/core/skills'
import { setLang } from '../src/shared/lang'
import { describeSchedule, EFFORTS, MODELS, type Agent, type Message } from '../src/shared/types'

const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false }

afterEach(() => setLang('pt'))

describe('the app in English', () => {
  it('describes schedules, results and lists in English, and back in Portuguese', () => {
    setLang('en')
    expect(describeSchedule({ days: [1], time: '09:00' })).toBe('Every Monday at 9:00')
    expect(describeSchedule({ days: [1, 3, 5], time: '18:30' })).toBe('Mon, Wed and Fri at 18:30')
    expect(describeSchedule({ days: [0, 1, 2, 3, 4, 5, 6], time: '07:00', once: true })).toBe('Once, at 7:00')
    const failed = { id: 'm', conversationId: 'c', author: { kind: 'agent', id: 'a1' }, text: '', at: 0, run: { status: 'failed', steps: [], error: 'boom' } } as Message
    expect(outcome(failed)).toBe('boom. Open it to fix it.')
    expect(MODELS[0]!.hint).toBe('Good for most things')
    expect(EFFORTS.map((e) => e.label)).toEqual(['Low', 'Medium', 'High', 'Max'])
    expect(linuxTools()[0]!.description).toMatch(/^Runs a bash command/)

    setLang('pt')
    expect(describeSchedule({ days: [1], time: '09:00' })).toBe('Toda segunda às 9h')
    expect(MODELS[0]!.hint).toBe('Bom pra maioria')
  })

  it("notifies in English, and tells agents to answer in the app's language", () => {
    setLang('en')
    const notes: string[] = []
    const db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-lang-')), 'test.db'))
    db.saveAgent(lia)
    new Skills({ db, emit: () => {}, notify: (t) => notes.push(t) }).propose(lia, { nome: 'deploy', quando_usar: 'When deploying', receita: '1. npm run build' })
    expect(notes).toEqual(['Lia proposes a skill'])

    const conv = { id: 'd1', kind: 'dm' as const, name: 'a1', members: ['a1'] }
    const en = systemPrompt({ agent: lia, settings: { workspaceName: 'Edu', context: '' }, conversation: conv, peers: [] })
    expect(en).toContain('You are Lia (@lia)')
    expect(en).toContain('- Reply in English, unless Edu writes to you in another language.')

    setLang('pt')
    expect(systemPrompt({ agent: lia, settings: { workspaceName: 'Edu', context: '' }, conversation: conv, peers: [] })).toContain('- Responda em português do Brasil')
  })
})
