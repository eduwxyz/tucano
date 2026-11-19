// A file an agent sent, as its card shows it (16/11 and 19/11, a person's report on a server):
// "there's only Open, no way to download or save". In a browser every card now offers Download,
// and a file no browser shows (a .docx) downloads on a click instead of opening an empty panel.
// On the desktop, Open stays and Save… sits beside it.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Artifact, Person } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))
const fire = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../src/renderer/src/rpc', async (original) => ({ ...(await original<typeof import('../src/renderer/src/rpc')>()), call: fire }))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), getState: () => fake ?? real.getState(), openPanel: vi.fn(), openLightbox: vi.fn() }
})
const store = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { ArtifactCard } = await import('../src/renderer/src/components/Panel')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const bia: Person = { id: 'bia', name: 'Bia', role: 'member', about: '' }
const art = (p: Partial<Artifact>): Artifact => ({ id: 'a1', agentId: 'lia', conversationId: 'c1', messageId: 'm1', kind: 'file', name: 'Comparativo_Email_Reluzir_BRAXT.docx', title: 'Comparativo e-mail Reluzir', source: '/x', size: 38_000, createdAt: 1, ...p })

const web = (on: boolean): void => {
  ;(window as { __TUCANO_WEB__?: boolean }).__TUCANO_WEB__ = on
  ;(globalThis as { __TUCANO_WEB__?: boolean }).__TUCANO_WEB__ = on
}
// What a click on the card's download made: the link the browser follows, under the file's name.
let links: { href: string; download: string }[]
const realCreate = document.createElement.bind(document)

let root: Root
const render = async (a: Artifact, you: Person = ana): Promise<void> => {
  fake = { ...store.getState(), ready: true, people: [ana, bia], you: you.id, artifacts: [a], panel: null }
  await act(async () => root.render(<ArtifactCard id={a.id} />))
}
const buttons = (): string[] => [...document.querySelectorAll('button')].map((b) => b.textContent ?? '')
const click = async (text: string): Promise<void> => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent === text)!
  await act(async () => void b.dispatchEvent(new window.Event('click', { bubbles: true })))
}
const clickCard = async (): Promise<void> => {
  const b = document.querySelector('.artifact-card__main, .artifact-image__show')!
  await act(async () => void b.dispatchEvent(new window.Event('click', { bubbles: true })))
}

beforeEach(() => {
  root = createRoot(document.getElementById('root')!)
  links = []
  document.createElement = ((tag: string) => {
    const el = realCreate(tag)
    if (tag === 'a') (el as unknown as { click: () => void }).click = () => links.push({ href: el.getAttribute('href') ?? '', download: el.getAttribute('download') ?? '' })
    return el
  }) as typeof document.createElement
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.createElement = realCreate
  web(false)
  vi.clearAllMocks()
})

describe('in a browser (Tucano as a server)', () => {
  it('a .docx card offers Download, not an Open that would show nothing, and a click downloads it', async () => {
    web(true)
    await render(art({}))
    expect(buttons()).toContain('Baixar')
    expect(buttons()).not.toContain('Abrir')
    await click('Baixar')
    await clickCard()
    const href = `./artifact/a1/${encodeURIComponent('Comparativo_Email_Reluzir_BRAXT.docx')}?download=1`
    expect(links).toEqual([
      { href, download: 'Comparativo_Email_Reluzir_BRAXT.docx' },
      { href, download: 'Comparativo_Email_Reluzir_BRAXT.docx' }
    ])
    expect(store.openPanel).not.toHaveBeenCalled()
    expect(fire).not.toHaveBeenCalled()
  })

  it('a file the browser shows keeps Open (the panel), with Download beside it', async () => {
    web(true)
    await render(art({ kind: 'pdf', name: 'relatório.pdf', title: 'Relatório' }))
    expect(buttons()).toEqual(expect.arrayContaining(['Abrir', 'Baixar']))
    await click('Abrir')
    expect(store.openPanel).toHaveBeenCalledWith({ kind: 'artifact', id: 'a1' })
    await click('Baixar')
    // (linkedom hands the address back decoded; a browser sends it encoded)
    expect(links.map((l) => ({ ...l, href: decodeURIComponent(l.href) }))).toEqual([{ href: './artifact/a1/relatório.pdf?download=1', download: 'relatório.pdf' }])
  })

  it('an image (a PNG, an SVG) has Download under it, for a member too', async () => {
    web(true)
    await render(art({ kind: 'image', name: 'fluxo-atendimento-brenda.svg', title: 'fluxo-atendimento-brenda.svg' }), bia)
    expect(buttons()).toContain('Baixar')
    await click('Baixar')
    expect(links).toEqual([{ href: './artifact/a1/fluxo-atendimento-brenda.svg?download=1', download: 'fluxo-atendimento-brenda.svg' }])
    await clickCard()
    expect(store.openLightbox).toHaveBeenCalledWith([{ url: './artifact/a1/fluxo-atendimento-brenda.svg', title: 'fluxo-atendimento-brenda.svg', artifact: { id: 'a1', name: 'fluxo-atendimento-brenda.svg' } }], 0)
  })
})

describe('on the desktop', () => {
  it('keeps Open, and adds Save… that asks the app for a Save dialog', async () => {
    await render(art({}))
    expect(buttons()).toEqual(expect.arrayContaining(['Abrir', 'Salvar…']))
    await click('Abrir')
    expect(store.openPanel).toHaveBeenCalledWith({ kind: 'artifact', id: 'a1' })
    await click('Salvar…')
    expect(fire).toHaveBeenCalledWith('saveArtifact', { id: 'a1' })
    expect(links).toEqual([])
  })
})
