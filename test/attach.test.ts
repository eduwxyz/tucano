import { describe, expect, it } from 'vitest'
import { MAX_BROWSER_FILES, withMessage } from '../src/shared/attach'
import { MAX_FILE_BYTES } from '../src/shared/types'

const pdf = (size: number): { size: number; type: string } => ({ size, type: 'application/pdf' })
const MB = 1024 * 1024

describe('a file attached from a browser', () => {
  it('goes with the message, so it shows as an attachment and the agents read it', () => {
    expect(withMessage([pdf(300_000), { size: 12, type: '' }, { size: 4 * MB, type: 'text/csv' }])).toEqual([true, true, true])
  })

  it('goes up to the server only when it is too big to attach', () => {
    expect(withMessage([pdf(MAX_FILE_BYTES), pdf(MAX_FILE_BYTES + 1)])).toEqual([true, false])
  })

  it('stops attaching when one request would no longer hold them, counting what is already attached', () => {
    // Two of 19 MB fit in a request; a third doesn't, and a small one after it still does.
    expect(withMessage([pdf(19 * MB), pdf(19 * MB), pdf(19 * MB), pdf(1000)])).toEqual([true, true, false, true])
    expect(withMessage([pdf(5 * MB)], MAX_BROWSER_FILES - 4 * MB)).toEqual([false])
  })

  it('always attaches an image: it is made small before it goes', () => {
    expect(withMessage([{ size: 30 * MB, type: 'image/png' }, { size: 30 * MB, type: 'image/heic' }], MAX_BROWSER_FILES)).toEqual([true, true])
  })
})
