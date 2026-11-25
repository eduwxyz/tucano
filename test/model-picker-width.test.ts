// A long model label made the picker as wide as its text, so inside a grid it pushed past the card
// and covered the Save button next to it. The picker must be allowed to shrink below its content.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '../src/renderer/src/styles.css'), 'utf8')

describe('the model picker', () => {
  it('may shrink below its content so a long label is cut with an ellipsis', () => {
    expect(/\n\.model-picker \{([^}]*)\}/.exec(css)?.[1]).toMatch(/min-width:\s*0/)
    expect(/\.select__trigger__value \{([^}]*)\}/.exec(css)?.[1]).toMatch(/text-overflow:\s*ellipsis/)
  })
})
