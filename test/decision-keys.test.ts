import { describe, expect, it } from 'vitest'
import { decisionKey, type DecisionKeyPress } from '../src/renderer/src/components/decision-keys'

const press = (key: string, extra: Partial<DecisionKeyPress> = {}): DecisionKeyPress => ({ key, shift: false, modifier: false, composing: false, inField: false, onBody: true, ...extra })

describe('decisionKey', () => {
  it('a number picks that option', () => {
    expect(decisionKey(press('2'), null, 3)).toEqual({ kind: 'pick', index: 1 })
    expect(decisionKey(press('4'), null, 3)).toBeNull()
  })
  it('a number with ⌘, Ctrl or Alt is not an answer', () => {
    expect(decisionKey(press('2', { modifier: true }), null, 3)).toBeNull()
  })
  it('Enter on a focused button is left to the button', () => {
    expect(decisionKey(press('Enter', { onBody: false }), 0, 3)).toBeNull()
    expect(decisionKey(press('1', { onBody: false }), 0, 3)).toEqual({ kind: 'pick', index: 0 })
  })
  it('Enter picks nothing until an option was pointed at', () => {
    expect(decisionKey(press('Enter'), null, 3)).toBeNull()
    expect(decisionKey(press('Enter'), 1, 3)).toEqual({ kind: 'pick', index: 1 })
    expect(decisionKey(press('Enter'), 3, 3)).toEqual({ kind: 'other' })
  })
  it('arrows move through the options and Something else', () => {
    expect(decisionKey(press('ArrowDown'), null, 3)).toEqual({ kind: 'focus', index: 0 })
    expect(decisionKey(press('ArrowDown'), 3, 3)).toEqual({ kind: 'focus', index: 0 })
    expect(decisionKey(press('ArrowUp'), null, 3)).toEqual({ kind: 'focus', index: 3 })
    expect(decisionKey(press('ArrowUp'), 0, 3)).toEqual({ kind: 'focus', index: 3 })
  })
  it('Esc closes the card instead of answering', () => {
    expect(decisionKey(press('Escape'), 0, 3)).toEqual({ kind: 'dismiss' })
    expect(decisionKey(press('Escape', { inField: true }), 0, 3)).toEqual({ kind: 'dismiss' })
  })
  it('in a field, Enter confirms, Shift+Enter and composing do not, and the arrows leave Something else', () => {
    expect(decisionKey(press('Enter', { inField: true }), null, 0)).toEqual({ kind: 'confirm' })
    expect(decisionKey(press('Enter', { inField: true, shift: true }), null, 0)).toBeNull()
    expect(decisionKey(press('Enter', { inField: true, composing: true }), null, 0)).toBeNull()
    expect(decisionKey(press('2', { inField: true }), null, 3)).toBeNull()
    expect(decisionKey(press('ArrowUp', { inField: true }), 3, 3)).toEqual({ kind: 'focus', index: 2 })
  })
})
