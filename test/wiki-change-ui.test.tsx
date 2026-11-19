// The curator's change card: what leaves a page and what comes in, both shown in full.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { State, WikiChange } from '../src/renderer/src/store'

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const { getState } = await import('../src/renderer/src/store')
const { ChangeCard } = await import('../src/renderer/src/components/Wiki')

const change = (ops: WikiChange['ops']): WikiChange => ({ id: 'c1', at: Date.now(), by: 'auto', state: 'pending', ops, reason: 'O Marcos aceitou o orçamento.' })
const card = (ops: WikiChange['ops']): string => renderToStaticMarkup(<ChangeCard change={change(ops)} />)

beforeEach(() => {
  fake = { ...getState(), ready: true }
})

describe("the curator's change card", () => {
  it('shows a swap as what leaves and what comes in, each labelled, Markdown and all', () => {
    const html = card([{ op: 'replace', page: 'Marcos Lima', section: 'Situação', old: 'Aguarda a visita.', new: 'Visita em **10/11**.\n\n- obra em janeiro\n- três parcelas' }])
    expect(html).toMatch(/wiki-diff__old.*Sai.*Aguarda a visita\./s)
    expect(html).toMatch(/wiki-diff__new.*Entra.*Visita em <strong>10\/11<\/strong>.*<li>obra em janeiro<\/li>.*<li>três parcelas<\/li>/s)
    expect(html).not.toContain('wiki-diff__new--none')
  })

  it('says so when a swap puts nothing in place, instead of an empty bar', () => {
    const html = card([{ op: 'replace', page: 'Marcos Lima', old: 'Aguarda a visita.', new: '' }])
    expect(html).toContain('wiki-diff__new--none')
    expect(html).toContain('o trecho só sai da página')
  })

  it('shows an addition and a new page without a "leaves" side', () => {
    const html = card([{ op: 'append', page: 'Marcos Lima', section: 'Histórico', text: '- 03/11: aceitou.' }, { op: 'create', page: 'Reforma', text: 'Do [[Marcos Lima]].' }])
    expect(html).not.toContain('wiki-diff__old')
    expect(html).toContain('03/11: aceitou.')
    expect(html).toContain('Reforma')
  })
})
