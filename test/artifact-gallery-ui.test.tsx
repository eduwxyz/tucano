// What one reply's pictures look like in the chat: an album of one large and the rest beside it
// when there are two or more, the plain picture it always was when there is one, and a reply that
// also made a document keeps its card under the album.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Artifact } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const { getState } = await import('../src/renderer/src/store')
const { ArtifactGallery } = await import('../src/renderer/src/components/Panel')

const art = (id: string, kind: Artifact['kind'], title = id): Artifact => ({
  id,
  agentId: 'a1',
  conversationId: 'd1',
  messageId: 'm1',
  kind,
  name: `${id}.${kind === 'image' ? 'png' : 'pdf'}`,
  title,
  source: `C:/tmp/${id}`,
  size: 1000,
  createdAt: 1
})
const images = (n: number): Artifact[] => Array.from({ length: n }, (_, i) => art(`i${i + 1}`, 'image', `Imagem ${i + 1}`))
const show = (list: Artifact[]): string => {
  fake = { ...getState(), artifacts: list }
  return renderToStaticMarkup(<ArtifactGallery ids={list.map((a) => a.id)} />)
}
const count = (html: string, needle: string): number => html.split(needle).length - 1
// The exact class, not a prefix of a longer one (`artifact-card` and `artifact-card__icon`).
const cells = (html: string): number => (html.match(/class="artifact-image gallery__cell/g) ?? []).length
const cards = (html: string): number => (html.match(/class="artifact-card(?![_-])/g) ?? []).length

beforeEach(() => {
  fake = { ...getState(), artifacts: [] }
})

describe('the pictures of a reply', () => {
  it('one picture is not an album: the same large picture as before', () => {
    const html = show(images(1))
    expect(count(html, 'artifacts-gallery')).toBe(0)
    expect(count(html, 'class="artifact-image"')).toBe(1)
    expect(html).toContain('artifact-image__caption')
    expect(html).toContain('Imagem 1')
  })

  it('two or more are an album: one cell large, the others beside it', () => {
    const html = show(images(3))
    expect(count(html, 'class="artifacts-gallery"')).toBe(1)
    expect(cells(html)).toBe(3)
    expect(count(html, 'gallery__cell--hero')).toBe(1)
    // The large one covers the two rows the column beside it splits, and it comes first.
    expect(html.indexOf('gallery__cell--hero')).toBeLessThan(html.indexOf('gallery__cell"'))
    expect(html).toContain('grid-row:span 2')
    expect(html).toContain('grid-row:span 1')
    // Every picture is in it, in order, and each one opens the window at its own picture.
    for (const n of [1, 2]) expect(html.indexOf(`Imagem ${n}`)).toBeLessThan(html.indexOf(`Imagem ${n + 1}`))
    expect([...html.matchAll(/src="(tucano:\/\/[^"]+)"/g)].map((m) => m[1])).toEqual(['tucano://artifact/i1/i1.png', 'tucano://artifact/i2/i2.png', 'tucano://artifact/i3/i3.png'])
  })

  it('past four, the last cell says how many are left', () => {
    const html = show(images(9))
    expect(cells(html)).toBe(4)
    expect(count(html, 'gallery__cell--hero')).toBe(1)
    expect(count(html, 'gallery__more')).toBe(1)
    expect(html).toContain('+5')
    // The cell that counts also says it aloud: it opens that picture, with five more beside it.
    expect(html).toContain('aria-label="Imagem 4 — e mais 5"')
    expect(html).not.toContain('aria-label="Imagem 1 — e mais')
    expect(html).toContain('grid-row:span 3')
  })

  it('a document the reply also made stays a card under the album', () => {
    const list = [...images(2), art('doc', 'pdf', 'Relatório')]
    const html = show(list)
    expect(count(html, 'class="artifacts-gallery"')).toBe(1)
    expect(cards(html)).toBe(1)
    expect(html).toContain('Relatório')
    expect(html.indexOf('artifacts-gallery')).toBeLessThan(html.indexOf('artifact-card'))
  })

  it('names the album, and each picture by its title', () => {
    const html = show(images(2))
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-label="As imagens desta resposta"')
    expect(html).toContain('aria-label="Imagem 2"')
  })
})
