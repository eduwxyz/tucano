// A paste attaches an image only when an image (or a file) is what was copied: text copied
// from a spreadsheet or a page, which brings a picture of itself along, pastes as text.
import { describe, expect, it } from 'vitest'

const { pastedFiles } = await import('../src/renderer/src/components/Conversation')
const png = (name: string): File => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
const pdf = new File([new Uint8Array([1])], 'nota.pdf', { type: 'application/pdf' })

describe('pastedFiles', () => {
  it('attaches a screenshot copied to the clipboard (no text with it)', () => {
    expect(pastedFiles([png('image.png')], '', false).map((f) => f.name)).toEqual(['image.png'])
  })
  it('pastes text that came with a picture of itself as text, attaching nothing', () => {
    expect(pastedFiles([png('image.png')], 'Receita\t1200\nCusto\t800', false)).toEqual([])
  })
  it('attaches a file copied in Finder, which comes with its name as the text', () => {
    expect(pastedFiles([png('Captura de Tela 2026-11-08.png')], 'Captura de Tela 2026-11-08.png', false)).toHaveLength(1)
  })
  it('leaves out what isn’t an image, unless on a server (where files go up)', () => {
    expect(pastedFiles([pdf], '', false)).toEqual([])
    expect(pastedFiles([pdf], '', true)).toHaveLength(1)
  })
})
