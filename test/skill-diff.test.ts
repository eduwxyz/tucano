import { describe, expect, it } from 'vitest'
import { compareSkill, MAX_DIFF_CELLS, MAX_DIFF_LINES } from '../src/shared/skill-diff'

const text = (lines: number, prefix = 'line') => Array.from({ length: lines }, (_, i) => `${prefix} ${i}`).join('\n')

describe('bounded skill comparison', () => {
  it.each([
    ['', ''], ['old', 'new'], ['a\nb\nc', 'a\nx\nc'], ['x\nx\ny', 'x\ny\nx'],
    ['\nleading\n\n', '\nnew\n\n'], ['windows\r\nline\r\n', 'windows\r\nnew\r\n']
  ])('retains the complete before/after text in detailed output', (before, after) => {
    const result = compareSkill(before, after)
    expect(result.kind).toBe('lines')
    if (result.kind !== 'lines') throw Error('Expected detailed comparison')
    expect(result.lines.filter(line => line.kind !== '+').map(line => line.text).join('\n')).toBe(before)
    expect(result.lines.filter(line => line.kind !== '-').map(line => line.text).join('\n')).toBe(after)
  })

  it('keeps removal before replacement and aligns unchanged lines', () => {
    expect(compareSkill('a\nb\nc', 'a\nx\nc')).toEqual({ kind: 'lines', lines: [
      { kind: ' ', text: 'a' }, { kind: '-', text: 'b' }, { kind: '+', text: 'x' }, { kind: ' ', text: 'c' }
    ] })
  })

  it('uses a full-content view before exceeding the matrix budget', () => {
    expect(MAX_DIFF_CELLS).toBe(512 * 512)
    expect(compareSkill(text(511), text(511, 'new')).kind).toBe('lines')
    expect(compareSkill(text(512), text(511, 'new')).kind).toBe('full')
  })

  it('bounds per-line DOM work even when the matrix would be thin', () => {
    expect(compareSkill(text(MAX_DIFF_LINES - 1), 'one').kind).toBe('lines')
    expect(compareSkill(text(MAX_DIFF_LINES), 'one').kind).toBe('full')
  })

  it('handles the original 6000-line case and maximum-sized saved bodies without a matrix', () => {
    expect(compareSkill('a\n'.repeat(6000), 'b\n'.repeat(6000))).toEqual({ kind: 'full' })
    expect(compareSkill('\n'.repeat(1_000_000), 'new')).toEqual({ kind: 'full' })
  })
})
