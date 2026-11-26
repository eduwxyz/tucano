// A page rises in when it opens. If the animation kept its transform after ending (fill "both" or
// "forwards"), the page would become the box that `position: fixed` things inside it are placed in:
// the routine card opened off to the side, cut by the page, with Edit out of reach.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '../src/renderer/src/styles.css'), 'utf8')

describe('the page rising in', () => {
  it('leaves no transform behind once it has risen', () => {
    const rule = /\.main > \* \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/animation:[^;]*\brise\b/)
    expect(rule).not.toMatch(/\b(both|forwards)\b/)
  })
})
