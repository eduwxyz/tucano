// What a key does on a decision's card. `focus` is the option pointed at (by an arrow or the
// mouse), `optionCount` is the options before "Something else", which sits at that index.
export interface DecisionKeyPress {
  key: string
  shift: boolean
  modifier: boolean // ⌘, Ctrl or Alt: a shortcut of the app, never an answer
  composing: boolean // an IME is still composing the text
  inField: boolean // typing in the text answer or in "Something else"
  onBody: boolean // the card itself has the focus, not one of its buttons
}

export type DecisionKeyAction = { kind: 'pick'; index: number } | { kind: 'focus'; index: number } | { kind: 'other' } | { kind: 'confirm' } | { kind: 'dismiss' } | null

export function decisionKey(press: DecisionKeyPress, focus: number | null, optionCount: number): DecisionKeyAction {
  if (press.modifier) return null
  if (press.key === 'Escape') return { kind: 'dismiss' }
  const stops = optionCount + 1
  const move = (by: 1 | -1): DecisionKeyAction => ({ kind: 'focus', index: focus === null ? (by === 1 ? 0 : optionCount) : (focus + by + stops) % stops })
  if (press.inField) {
    if (press.key === 'Enter' && !press.shift && !press.composing) return { kind: 'confirm' }
    if (optionCount > 0 && press.key === 'ArrowUp') return move(-1)
    if (optionCount > 0 && press.key === 'ArrowDown') return move(1)
    return null
  }
  const n = Number(press.key)
  if (Number.isInteger(n) && n >= 1 && n <= optionCount) return { kind: 'pick', index: n - 1 }
  if (press.key === 'ArrowDown') return move(1)
  if (press.key === 'ArrowUp') return move(-1)
  if (press.key === 'Enter' && press.onBody && focus !== null) return focus === optionCount ? { kind: 'other' } : { kind: 'pick', index: focus }
  return null
}
