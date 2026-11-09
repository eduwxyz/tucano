import { describe, expect, it } from 'vitest'
import { localFileReferences } from '../src/renderer/src/components/composer-file-paths'

describe('localFileReferences', () => {
  it('references local paths for files the desktop can resolve and keeps unresolved files', () => {
    const pdf = new File(['pdf'], 'menu.pdf', { type: 'application/pdf' })
    const unknown = new File(['data'], 'unknown.bin')

    expect(localFileReferences([pdf, unknown], (file) => (file === pdf ? '/tmp/menu.pdf' : ''))).toEqual({
      references: ['"/tmp/menu.pdf"'],
      unresolved: [unknown]
    })
  })

  it('leaves every file for the existing handling when local paths are unavailable', () => {
    const pdf = new File(['pdf'], 'menu.pdf', { type: 'application/pdf' })

    expect(localFileReferences([pdf])).toEqual({ references: [], unresolved: [pdf] })
    expect(localFileReferences([pdf], () => { throw new Error('unavailable') })).toEqual({ references: [], unresolved: [pdf] })
  })
})
