// The decisions card takes dictation too: an agent asks something in words, and the person answers by voice,
// as in the message box. The microphone sits in the corner of the field an answer is written in (a text
// decision's, or "Something else" once open), and only where it shows in the message box (not hidden).
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { State } from '../src/renderer/src/store'
import type { Decision } from '../src/shared/questions'
import type { VoiceStatus } from '../src/shared/types'

let fake: State
let status: VoiceStatus | null = null
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
vi.mock('../src/renderer/src/components/VoiceSetup', async (original) => {
  const real = await original<typeof import('../src/renderer/src/components/VoiceSetup')>()
  return { ...real, useVoice: () => status }
})
vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getUserMedia: () => Promise.reject(new Error('no')) } })
const { getState } = await import('../src/renderer/src/store')
const { AskCard } = await import('../src/renderer/src/components/Decisions')

const text: Decision[] = [{ question: 'O que a sua transportadora vende?', kind: 'text' }]
const pick: Decision[] = [{ question: 'Paginação?', kind: 'single', options: [{ label: 'Busca' }, { label: 'Paginar' }] }]
const render = (questions: Decision[], mode: 'answer' | 'view' = 'answer'): string => renderToStaticMarkup(<AskCard id={`m-${Math.random()}`} questions={questions} mode={mode} badge="Esperando você" />)
const mic = /aria-label="Falar"/

beforeEach(() => {
  fake = { ...getState(), ready: true, you: 'ana' }
  status = { bin: '/x/whisper-cli', model: '/x/m.bin', ready: true }
})

describe('dictating an answer on the decisions card', () => {
  it('a text decision has the microphone, in the corner of its field', () => {
    expect(render(text)).toMatch(/class="ask__field"><textarea[^>]*><\/textarea><span class="ask__mic">.*aria-label="Falar"/)
  })

  it('a decision with options has none until Something else is open: no field to write into', () => {
    expect(render(pick)).not.toMatch(mic)
  })

  it('not on a card someone else answers', () => {
    expect(render(text, 'view')).not.toMatch(mic)
  })

  it('not when the person hid the microphone', () => {
    fake = { ...fake, settings: { ...fake.settings, voice: { hidden: true } } }
    expect(render(text)).not.toMatch(mic)
  })

  it('dictation off yet: the button that turns it on, as in the message box', () => {
    status = { ready: false }
    expect(render(text)).toMatch(/aria-label="Ditar mensagens"/)
  })
})
