// The agent's browser shows big and live in the chat only while there is something to watch; an idle one
// is the small card, so several agents' browsers don't pile up down the conversation (#ideas, 18/11).
import { describe, expect, it } from 'vitest'
import { getState, liveBrowserOn, type State } from '../src/renderer/src/store'
import type { BrowserView, Message, RunStatus } from '../src/shared/types'

const reply = (id: string, agentId: string, status: RunStatus, at: number, browser = true): Message => ({ id, conversationId: 'c1', author: { kind: 'agent', id: agentId }, text: '', at, run: { status, steps: [], ...(browser ? { browser: true } : {}), ...(status === 'working' ? {} : { endedAt: at }) } as Message['run'] })
const view = (agentId: string, shown = false): BrowserView => ({ agentId, url: '', title: '', shown, log: [], at: 0 })
const state = (messages: Message[], over: Partial<State> = {}): State => ({ ...getState(), messages: { c1: messages }, browsers: [view('crier'), view('lia')], ...over })

describe('the agent browser in the chat', () => {
  it('is big while the reply that uses it is at work or held on an approval', () => {
    const working = reply('m1', 'crier', 'working', 1)
    expect(liveBrowserOn(state([working]), working)).toBe(true)
    const held = reply('m1', 'crier', 'waiting_approval', 1)
    expect(liveBrowserOn(state([held]), held)).toBe(true)
  })

  it('is the small card once the reply ended, even on its latest message', () => {
    for (const status of ['done', 'failed', 'stopped', 'waiting_input'] as RunStatus[]) {
      const ended = reply('m1', 'crier', status, 1)
      expect(liveBrowserOn(state([ended]), ended)).toBe(false)
    }
  })

  it('stays big while I am in control of it, after the reply ended', () => {
    const ended = reply('m1', 'crier', 'done', 1)
    expect(liveBrowserOn(state([ended], { browsers: [view('crier', true)] }), ended)).toBe(true)
  })

  it('only on the latest message that used it, and not while it is open on the side', () => {
    const old = reply('m1', 'crier', 'working', 1)
    const latest = reply('m2', 'crier', 'working', 2)
    const other = reply('m3', 'lia', 'working', 3)
    const s = state([old, latest, other])
    expect([old, latest, other].map((m) => liveBrowserOn(s, m))).toEqual([false, true, true])
    expect(liveBrowserOn(state([latest], { panel: { kind: 'browser', agentId: 'crier' } }), latest)).toBe(false)
    const plain = reply('m4', 'crier', 'working', 4, false)
    expect(liveBrowserOn(state([plain]), plain)).toBe(false)
  })
})
