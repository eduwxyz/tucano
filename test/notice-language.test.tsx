// The notification surface speaks the language picked in Settings: the "Where they appear" bar, the
// cards themselves, and both of them already on the first paint — the page is made with the language
// the app is in, and follows a change made while it is open.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Agent, Approval } from '../src/shared/types'
import type { CoreEvent } from '../src/shared/rpc'
import type { NoticeFeed } from '../src/shared/notice'
import { noticeOf } from '../src/shared/notice'
import { lang, setLang } from '../src/shared/lang'

const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, {
  window,
  document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
  matchMedia: () => ({ matches: true })
})
Object.assign(document, { elementFromPoint: () => null })
// The picker measures the screen it dims: a 1200 × 800 one, as the window around the page would be.
Object.assign(window, { innerWidth: 1200, innerHeight: 800 })
// The clock on each card asks for the next frame; the animation isn't what is being read here.
Object.assign(globalThis, { requestAnimationFrame: () => 0, cancelAnimationFrame: () => undefined })
Object.assign(window, { requestAnimationFrame: () => 0, cancelAnimationFrame: () => undefined })

const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, owner: 'ana' }
const approval: Approval = {
  id: 'ap1', hash: 'h', agentId: 'a1', conversationId: 'c1', messageId: 'm1',
  connectorId: 'github', connectorName: 'GitHub', tool: 'create_issue', args: {},
  why: 'Fechar o bug do menu.', highRisk: false, state: 'pending', createdAt: 1, expiresAt: 9_999_999_999_999
}
const feed = (language: 'pt' | 'en'): NoticeFeed => ({
  rules: noticeOf({}),
  language,
  agents: [lia],
  conversations: [{ id: 'c1', name: 'vendas', kind: 'channel' }],
  inbox: { approvals: [approval], questions: [] }
})

// The core, as a window sees it: one read of the feed, and the events that make it read again.
let current = feed('en')
let answering = true // the core is up; a page made before it answers has only what main handed it
const hearing = new Set<(e: CoreEvent) => void>()
vi.mock('../src/renderer/src/rpc', () => ({
  connect: (cb: (e: CoreEvent) => void) => {
    hearing.add(cb)
    return Promise.resolve()
  },
  call: (method: string) => (answering ? Promise.resolve(method === 'noticeFeed' ? current : ({} as never)) : new Promise(() => undefined))
}))

const handed: Record<string, (p: unknown) => void> = {}
const place = vi.fn()
const save = vi.fn(() => Promise.resolve({} as never))
Object.assign(window, {
  tucano: {
    notice: {
      onPush: (cb: (p: unknown) => void) => (handed['push'] = cb),
      onClear: () => undefined,
      onPlace: () => undefined,
      onDemo: () => undefined,
      onPick: (cb: (r: { x: number; y: number; w: number; h: number; up: boolean }) => void) => cb({ x: 0, y: 400, w: 372, h: 120, up: true }),
      onCursor: () => undefined,
      areaDone: () => undefined,
      areaCancel: () => undefined,
      hit: () => undefined,
      focus: () => undefined,
      count: () => undefined,
      open: () => undefined,
      pick: place,
      demo: save
    }
  }
})

const { createRoot } = await import('react-dom/client')
const { AreaPicker } = await import('../src/renderer/src/notice/AreaPicker')
const { NoticeWindow } = await import('../src/renderer/src/notice/Notice')
const { startLang } = await import('../src/renderer/src/notice/feed')

let root: ReturnType<typeof createRoot>
let host: HTMLElement
const text = (): string => host.textContent ?? ''

// A change in the other window, as the core tells every port about it.
const changed = async (language: 'pt' | 'en'): Promise<void> => {
  current = feed(language)
  await act(async () => {
    for (const hear of hearing) hear({ type: 'settings' } as CoreEvent)
    await new Promise((r) => setTimeout(r, 220))
  })
}

beforeEach(async () => {
  current = feed('en')
  answering = true
  setLang('pt') // what a freshly made page starts at, before it hears anything
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  answering = true
  setLang('pt')
})

it('takes the language main hands the page, before the core has answered anything', () => {
  startLang('?pick=1&lang=en')
  expect(lang()).toBe('en')
  expect(document.documentElement.lang).toBe('en')
  startLang('?pick=1&lang=pt')
  expect(lang()).toBe('pt')
  expect(document.documentElement.lang).toBe('pt-BR')
  // Nothing to take, or something that isn't a language: the page keeps what it has.
  startLang('?lang=fr')
  expect(lang()).toBe('pt')
})

it('draws the picker in the handed language on the first paint, before the feed answers', async () => {
  answering = false
  startLang('?pick=1&lang=en')
  await act(async () => root.render(<AreaPicker />))
  await act(async () => await new Promise((r) => setTimeout(r, 30)))
  expect(text()).toContain('Drag the rectangle, and its corners to resize it. Notifications appear there.')
  expect(text()).toContain('Save')
  expect(text()).not.toContain('Arraste o retângulo')
})

it('draws a card that arrives after the feed in the feed’s language', async () => {
  current = feed('pt')
  await act(async () => root.render(<NoticeWindow />))
  await act(async () => await new Promise((r) => setTimeout(r, 50)))
  await act(async () => {
    handed['push']!({ title: 'Notificação de teste', body: 'É assim que os avisos chegam.', at: 1 })
  })
  expect(text()).toContain('Notificação de teste')
  expect(text()).toContain('Aviso')
  expect(text()).not.toContain('Notice')
})

it('draws the area picker in the language Settings says, not the one the page was built at', async () => {
  await act(async () => root.render(<AreaPicker />))
  await act(async () => await new Promise((r) => setTimeout(r, 50)))
  expect(lang()).toBe('en')
  expect(text()).toContain('Drag the rectangle, and its corners to resize it. Notifications appear there.')
  expect(text()).toContain('Notifications arrive here, from the bottom up')
  expect(text()).toContain('Save')
  expect(text()).not.toContain('Arraste o retângulo')
})

it('draws it in Portuguese when Portuguese is the language', async () => {
  current = feed('pt')
  await act(async () => root.render(<AreaPicker />))
  await act(async () => await new Promise((r) => setTimeout(r, 50)))
  expect(lang()).toBe('pt')
  expect(text()).toContain('Arraste o retângulo, e os cantos pra mudar o tamanho. Os avisos aparecem aí.')
  expect(text()).toContain('Os avisos chegam aqui, de baixo pra cima')
  expect(text()).toContain('Salvar')
  expect(text()).not.toContain('Drag the rectangle')
})

it('follows a language change made while the picker is open', async () => {
  await act(async () => root.render(<AreaPicker />))
  await act(async () => await new Promise((r) => setTimeout(r, 50)))
  expect(text()).toContain('Drag the rectangle')
  await changed('pt')
  expect(lang()).toBe('pt')
  expect(text()).toContain('Arraste o retângulo, e os cantos pra mudar o tamanho.')
  expect(text()).toContain('Salvar')
  await changed('en')
  expect(text()).toContain('Drag the rectangle')
})

it('draws the cards in the language Settings says, and follows a change while the window is open', async () => {
  await act(async () => root.render(<NoticeWindow />))
  await act(async () => await new Promise((r) => setTimeout(r, 50)))
  expect(lang()).toBe('en')
  expect(text()).toContain('Lia asks for approval')
  expect(text()).toContain('Approve')
  expect(text()).not.toContain('Lia pede aprovação')
  await changed('pt')
  expect(lang()).toBe('pt')
  expect(text()).toContain('Lia pede aprovação')
  expect(text()).toContain('Aprovar')
  expect(text()).not.toContain('Lia asks for approval')
})
