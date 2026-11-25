// One-action proposals: the detector reads what a finished reply already said, and the button
// keeps one phrase per message instead of changing on every redraw.
import { describe, expect, it } from 'vitest'
import { oneActionProposal, proceedLabel, PROCEED_LABELS } from '../src/shared/proceed'

const proposals: [string, string][] = [
  ['say the word and I’ll get Wrench or the WSL side to install beautifulsoup4', 'install beautifulsoup4'],
  ['Want me to trigger that now?', 'trigger that'],
  ['your call on bef82566', 'bef82566'],
  ['say so and I stop committing', 'stop committing'],
  ['just say yes or no', 'just say yes or no'],
  ['Next, at your word: I can take the first polish item', 'first polish item'],
  ['They’re still sitting there unstaged; say the word and I’ll restore all six, one branch each.', 'restore all six'],
  ['If you want, I can open the PR with the two commits we just made.', 'open the PR'],
  ['Se quiser, eu rodo a suíte e te mando o resultado.', 'rodo a suíte'],
  ['Só dizer que eu fecho os seis cards.', 'fecho os seis cards'],
  ['Quando você quiser, eu reviso o PR.', 'reviso o PR'],
  ['Você decide: assino a liberação ou espero mais uma noite.', 'assino a liberação']
]

const notProposals: string[] = [
  'Instalei beautifulsoup4 e rodei os testes.',
  'Want me to trigger that now? Also, want me to reopen the PR?',
  'If you want, I can restore the six branches and I’ll also reopen the PR.',
  'Say the word and I’ll do the first item. At your word, I’ll do the second.',
  'Here are the branches:\n- one\n- two\nSay the word and I’ll restore them.',
  '```\nsay the word and I will run it\n```',
  'Your call on bef82566, but I will not change it.',
  'Ready when you are',
  'Whenever you are ready, I can open the PR.',
  'You have the word: I can open the PR.'
]

describe('one-action proposals in a finished reply', () => {
  it.each(proposals)('finds the proposal in %s', (reply, needle) => {
    expect(oneActionProposal(reply)?.paragraph).toContain(needle)
  })

  it.each(notProposals)('leaves %s alone', (reply) => {
    expect(oneActionProposal(reply)).toBeUndefined()
  })

  it('does not use a paragraph when the same reply offers two actions', () => {
    expect(oneActionProposal('Pronto. Se quiser, eu rodo a suíte.\n\nSó dizer que eu abro a PR também.')).toBeUndefined()
  })

  it('keeps the paragraph that carries the proposal, not the surrounding reply', () => {
    const reply = 'Revisei os quatro commits e deixei a nota de lançamento pronta.\n\nSe quiser, eu abro a PR agora.\n\nO resto segue amanhã.'
    expect(oneActionProposal(reply)?.paragraph).toBe('Se quiser, eu abro a PR agora.')
  })
})

describe('the approval word', () => {
  it('offers a list of 20 to 30 phrases', () => {
    expect(PROCEED_LABELS.length).toBeGreaterThanOrEqual(20)
    expect(PROCEED_LABELS.length).toBeLessThanOrEqual(30)
    expect(new Set(PROCEED_LABELS).size).toBe(PROCEED_LABELS.length)
  })

  it('uses approvals of the action, not words that hand the turn over', () => {
    expect(PROCEED_LABELS).not.toContain('Você tem a palavra')
    expect(PROCEED_LABELS).not.toContain('Com prazer')
    expect(PROCEED_LABELS).not.toContain('Pronto quando você estiver')
    expect(PROCEED_LABELS).toEqual(expect.arrayContaining(['Pode seguir', 'Eu aprovo', 'Vamos fazer']))
  })

  it('picks the same phrase for the same message every time', () => {
    const first = proceedLabel('msg-3f82c1')
    expect(first).toBe(proceedLabel('msg-3f82c1'))
    expect(PROCEED_LABELS).toContain(first)
    expect(proceedLabel('msg-3f82c2')).toBe(proceedLabel('msg-3f82c2'))
  })
})
