// "Enviar feedback" and the survey line on screen: opening it (from the workspace's menu), the dialog (the kind,
// the text, the window's picture, what goes along), and the survey's steps. The core is a stand-in:
// what's sent to it is what's checked.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { Person, Settings } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: true }) })
Object.assign(document, { oninput: null })

const SHOT = { type: 'image/png' as const, data: 'iVBORw0KGgo=' }
const capture = vi.fn(async () => SHOT)
Object.assign(window, { tucano: { capture, updateState: async () => ({ version: '0.2.37', status: 'off' }), onUpdate: () => {} } })

const calls: { method: string; params: unknown }[] = []
let survey: unknown = null
let fail = ''
vi.mock('../src/renderer/src/rpc', () => ({
  call: async (method: string, params?: unknown) => {
    calls.push({ method, params })
    if (fail && method !== 'survey') throw new Error(fail)
    if (method === 'survey') return survey
    return undefined
  }
}))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), getState: () => fake, openDialog: vi.fn(), toast: vi.fn(), windowless: vi.fn(() => false) }
})
const store = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { FeedbackDialog, openFeedback, SurveyLine } = await import('../src/renderer/src/components/Feedback')

const base = (await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')).getState()
const owner: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const member: Person = { id: 'bia', name: 'Bia', role: 'member', about: '' }
function state(p: { settings?: Partial<Settings>; you?: string } = {}): State {
  return { ...base, ready: true, people: [owner, member], you: p.you ?? 'ana', platform: 'mac', settings: { ...base.settings, language: 'pt', ...p.settings } } as State
}

let root: Root
beforeEach(() => {
  setLang('pt')
  fake = state()
  calls.length = 0
  survey = null
  fail = ''
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
})

const text = (): string => document.body.textContent ?? ''
const tick = (): Promise<void> => act(async () => new Promise((r) => setTimeout(r, 10)))
const button = (name: RegExp): HTMLButtonElement => {
  const b = [...document.querySelectorAll('button')].find((x) => name.test((x.textContent ?? '').trim()) && !x.disabled)
  if (!b) throw new Error(`no enabled button ${name}: ${[...document.querySelectorAll('button')].map((x) => `${x.textContent}${x.disabled ? '(off)' : ''}`).join(' | ')}`)
  return b as HTMLButtonElement
}
const click = async (name: RegExp | Element): Promise<void> => {
  const b = name instanceof RegExp ? button(name) : name
  await act(async () => void b.dispatchEvent(new window.Event('click', { bubbles: true })))
  await tick()
}
const type = async (input: HTMLTextAreaElement, value: string): Promise<void> => {
  let proto: object | null = Object.getPrototypeOf(input)
  let set: ((v: string) => void) | undefined
  while (proto && !set) (set = Object.getOwnPropertyDescriptor(proto, 'value')?.set), (proto = Object.getPrototypeOf(proto))
  await act(async () => {
    set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
const render = async (node: React.ReactNode): Promise<void> => {
  await act(async () => root.render(node))
  await tick()
}
const sent = (method: string): unknown[] => calls.filter((c) => c.method === method).map((c) => c.params)

describe('Enviar feedback', () => {
  it('takes the window’s picture first, then opens the dialog with it', async () => {
    await act(async () => openFeedback())
    expect(capture).toHaveBeenCalled()
    expect(store.openDialog).toHaveBeenCalledWith({ kind: 'feedback', image: SHOT })
  })

  it('the kind, the text and the picture go; what goes along is said in words', async () => {
    const close = vi.fn()
    await render(<FeedbackDialog image={SHOT} onClose={close} />)
    expect(text()).toContain('Anexar uma imagem da tela do Tucano')
    expect(text()).toContain('Além do seu texto, vão só a versão do Tucano (0.2.37), o sistema (macOS) e o idioma. E a imagem da tela, se estiver marcada.')
    expect(text()).not.toMatch(/e-mail/i)
    expect(document.querySelector<HTMLButtonElement>('.modal__foot .btn--primary')!.disabled).toBe(true) // nothing written yet
    await click(/^Uma ideia$/)
    expect(text()).toContain('Qual é a ideia?')
    await click(/ver a imagem/)
    expect(document.querySelector('.feedback__preview')?.getAttribute('src')).toBe(`data:image/png;base64,${SHOT.data}`)
    await type(document.querySelector('textarea')!, 'Um atalho pra Memória')
    await click(/^Enviar$/)
    expect(sent('sendFeedback')).toEqual([{ kind: 'idea', message: 'Um atalho pra Memória', image: SHOT.data, lang: 'pt' }])
    expect(close).toHaveBeenCalled()
    expect(store.toast).toHaveBeenCalledWith('Recebido. Obrigado!')
  })

  it('unchecked, the picture stays; without one (a browser), the option isn’t there', async () => {
    await render(<FeedbackDialog image={SHOT} onClose={() => {}} />)
    const box = document.querySelector<HTMLInputElement>('.feedback__attach input')!
    await act(async () => {
      Object.defineProperty(box, 'checked', { configurable: true, value: false })
      box.dispatchEvent(new window.Event('click', { bubbles: true }))
    })
    await type(document.querySelector('textarea')!, 'quebrou')
    await click(/^Enviar$/)
    expect(sent('sendFeedback')).toEqual([{ kind: 'bug', message: 'quebrou', lang: 'pt' }])
    await act(async () => root.render(<FeedbackDialog onClose={() => {}} />))
    expect(text()).not.toContain('Anexar uma imagem')
    expect(text()).not.toContain('E a imagem da tela')
  })

  it('when it doesn’t go, the dialog says why and keeps the text', async () => {
    fail = 'Muitos envios. Tente de novo daqui a pouco.'
    const close = vi.fn()
    await render(<FeedbackDialog onClose={close} />)
    await type(document.querySelector('textarea')!, 'quebrou')
    await click(/^Enviar$/)
    expect(text()).toContain('Muitos envios')
    expect(close).not.toHaveBeenCalled()
    expect(document.querySelector('textarea')!.value).toBe('quebrou')
  })
})

describe('the survey line', () => {
  const SURVEY = { id: 'ui-nova', question: 'A barra lateral mudou. Prefere a nova ou a de antes?', options: [{ id: 'new', label: 'A nova' }, { id: 'old', label: 'A de antes' }, { id: 'any', label: 'Tanto faz' }], followUp: 'O que faz falta?' }

  it('a quiet line; a choice counts at once, the why is extra, then thanks', async () => {
    survey = SURVEY
    await render(<SurveyLine />)
    expect(text()).toContain('Uma pergunta rápida pra você')
    expect(text()).not.toContain('Prefere a nova')
    await click(/Uma pergunta rápida/)
    expect(text()).toContain('Prefere a nova ou a de antes?')
    await click(/^A de antes$/)
    expect(sent('answerSurvey')).toEqual([{ survey: 'ui-nova', choice: 'old', lang: 'pt' }])
    expect(text()).toContain('O que faz falta?')
    await type(document.querySelector('textarea')!, 'A Memória solta na barra.')
    await click(/^Enviar$/)
    expect(sent('answerSurvey')[1]).toEqual({ survey: 'ui-nova', choice: 'old', comment: 'A Memória solta na barra.', lang: 'pt' })
    expect(text()).toContain('Valeu! Isso ajuda.')
  })

  it('"Não quero responder" takes the line away for good', async () => {
    survey = SURVEY
    await render(<SurveyLine />)
    await click(/Uma pergunta rápida/)
    await click(/Não quero responder/)
    expect(sent('answerSurvey')).toEqual([{ survey: 'ui-nova', dismiss: true, lang: 'pt' }])
    expect(text()).toBe('')
  })

  it('only the owner, and only with Pesquisas on: otherwise nothing is even asked', async () => {
    survey = SURVEY
    fake = state({ you: 'bia' })
    await render(<SurveyLine />)
    expect(text()).toBe('')
    fake = state({ settings: { surveys: false } })
    await act(async () => root.render(<SurveyLine key="off" />))
    await tick()
    expect(text()).toBe('')
    expect(sent('survey')).toEqual([])
  })

  it('no survey: nothing', async () => {
    await render(<SurveyLine />)
    expect(sent('survey')).toEqual([{ lang: 'pt' }])
    expect(text()).toBe('')
  })
})
