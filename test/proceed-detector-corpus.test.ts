// Exhaustive verdict table for the one-action detector. Expected values state the rule the owner
// asked for, not what the shipped detector returns: a mismatch is a finding, not a test to patch.
import { describe, expect, it } from 'vitest'
import { oneActionProposal } from '../src/shared/proceed'

type Case = {
  id: string
  category: 'single-en' | 'single-pt' | 'multi' | 'neutral' | 'boundary' | 'card'
  text: string
  expected: boolean
  why: string
  card?: boolean // the reply also carried a next_steps tool card: the runner never calls the detector
  paragraph?: string // exact paragraph the detector must hand back
}

const cases: Case[] = [
  // One action offered in words, English.
  { id: 'en-01', category: 'single-en', text: "Say the word and I'll restore all six branches.", expected: true, why: 'one invitation, one action clause' },
  { id: 'en-02', category: 'single-en', text: 'If you want, I can open the PR with the two commits.', expected: true, why: 'conditional invitation, one action' },
  { id: 'en-03', category: 'single-en', text: 'Want me to trigger that now?', expected: true, why: 'question form, one invitation and no second action' },
  { id: 'en-04', category: 'single-en', text: 'It is your call on bef82566.', expected: true, why: 'your call is an invitation; no other action' },
  { id: 'en-05', category: 'single-en', text: "Just say yes and I'll take the first item.", expected: true, why: 'just say yes, one action' },
  { id: 'en-06', category: 'single-en', text: 'Say so and I stop committing.', expected: true, why: 'say so and i, one action' },
  { id: 'en-07', category: 'single-en', text: 'Ready when you are: I can start the migration.', expected: true, why: 'readiness plus one action' },
  { id: 'en-08', category: 'single-en', text: 'At your word: I can take the first item.', expected: true, why: 'at your word, one action' },
  { id: 'en-09', category: 'single-en', text: 'Just say yes.', expected: true, why: 'bare invitation with no action verb still offers one step' },
  { id: 'en-10', category: 'single-en', text: 'Your call.', expected: true, why: 'bare invitation' },
  { id: 'en-11', category: 'single-en', text: 'If you would like, I can close the six cards.', expected: true, why: 'if you would like, one action' },
  { id: 'en-12', category: 'single-en', text: "If you'd like, I can resend the report.", expected: true, why: 'contracted if you would like' },
  { id: 'en-13', category: 'single-en', text: 'Just tell me to restart the worker.', expected: true, why: 'just tell me to, one action' },
  { id: 'en-14', category: 'single-en', text: 'Let me know if I should reopen the PR.', expected: true, why: 'let me know if, one implied action' },
  { id: 'en-15', category: 'single-en', text: 'Shall I reopen the PR?', expected: true, why: 'shall i, one action' },
  { id: 'en-16', category: 'single-en', text: 'Do you want me to restore the branches?', expected: true, why: 'do you want me to, one action' },
  { id: 'en-17', category: 'single-en', text: "Would you like me to install beautifulsoup4?", expected: true, why: 'would you like me to, one action' },
  { id: 'en-18', category: 'single-en', text: 'Ready when you are.', expected: true, why: 'listed as a one-action proposal by the owner, though it names no verb' },
  { id: 'en-19', category: 'single-en', text: 'Say the word and I will restore the six branches.', expected: true, why: 'spelled-out will, one action', paragraph: 'Say the word and I will restore the six branches.' },

  // One action offered in words, Portuguese, covering the invitation families.
  { id: 'pt-01', category: 'single-pt', text: 'Se quiser, eu rodo a suíte e te mando o resultado.', expected: true, why: 'se quiser' },
  { id: 'pt-02', category: 'single-pt', text: 'Se você quiser, eu abro a PR agora.', expected: true, why: 'se você quiser' },
  { id: 'pt-03', category: 'single-pt', text: 'Se quiseres, eu escrevo o teste do card.', expected: true, why: 'se quiseres' },
  { id: 'pt-04', category: 'single-pt', text: 'Quando quiser, eu faço o deploy.', expected: true, why: 'quando quiser' },
  { id: 'pt-05', category: 'single-pt', text: 'Quando você quiser, eu checo os logs.', expected: true, why: 'quando você quiser' },
  { id: 'pt-06', category: 'single-pt', text: 'Quando você mandar, eu instalo a lib.', expected: true, why: 'quando você mandar' },
  { id: 'pt-07', category: 'single-pt', text: 'Só me avisar que eu monto o container.', expected: true, why: 'só me avisar' },
  { id: 'pt-08', category: 'single-pt', text: 'Só me dizer que eu preparo o relatório.', expected: true, why: 'só me dizer' },
  { id: 'pt-09', category: 'single-pt', text: 'Só dizer que eu abro a PR.', expected: true, why: 'só dizer' },
  { id: 'pt-10', category: 'single-pt', text: 'Só pedir que eu configuro o servidor.', expected: true, why: 'só pedir' },
  { id: 'pt-11', category: 'single-pt', text: 'É só dizer que eu trago o resultado.', expected: true, why: 'é só dizer' },
  { id: 'pt-12', category: 'single-pt', text: 'Diga sim que eu deixo o branch pronto.', expected: true, why: 'diga sim' },
  { id: 'pt-13', category: 'single-pt', text: 'Me avise que eu leio o arquivo.', expected: true, why: 'me avise' },
  { id: 'pt-14', category: 'single-pt', text: 'Você decide: assino a liberação ou espero mais uma noite.', expected: false, why: 'two possible actions after one invitation' },
  { id: 'pt-15', category: 'single-pt', text: 'Fico no aguardo do seu sinal para instalar.', expected: true, why: 'fico no aguardo, one action' },
  { id: 'pt-16', category: 'single-pt', text: 'Se permitir, eu faço a revisão.', expected: true, why: 'se permitir' },
  { id: 'pt-17', category: 'single-pt', text: 'Se eu puder, eu escrevo a nota de lançamento.', expected: true, why: 'se eu puder' },
  { id: 'pt-18', category: 'single-pt', text: 'Posso eu abrir a PR?', expected: true, why: 'posso eu' },
  { id: 'pt-19', category: 'single-pt', text: 'Quer que eu rode a suíte?', expected: true, why: 'quer que eu' },
  { id: 'pt-20', category: 'single-pt', text: 'No seu tempo, eu preparo o resumo.', expected: true, why: 'no seu tempo' },
  { id: 'pt-21', category: 'single-pt', text: 'Se quiser, eu abro a PR agora.', expected: true, why: 'canonical Portuguese proposal', paragraph: 'Se quiser, eu abro a PR agora.' },

  // Several actions, markup, negation, or a question: no single proceed button.
  { id: 'multi-01', category: 'multi', text: "Say the word and I'll restore the six branches. If you want, I'll reopen the PR.", expected: false, why: 'two invitations in one paragraph' },
  { id: 'multi-02', category: 'multi', text: 'I can fix X and install Y.', expected: false, why: 'two action verbs in one clause' },
  { id: 'multi-03', category: 'multi', text: "I can fix X and I'll install Y.", expected: false, why: 'two explicit action verbs' },
  { id: 'multi-04', category: 'multi', text: "Say the word and I'll do the first item. At your word, I'll do the second.", expected: false, why: 'two invitations' },
  { id: 'multi-05', category: 'multi', text: "Here are the branches:\n- one\n- two\nSay the word and I'll restore them.", expected: false, why: 'bulleted list in the block' },
  { id: 'multi-06', category: 'multi', text: "1. Restore the branches\n2. Reopen the PR\nSay the word and I'll begin.", expected: false, why: 'numbered list in the block' },
  { id: 'multi-07', category: 'multi', text: "| option | meaning |\n|---|---|\n| A | restore |\nSay the word and I'll do A.", expected: false, why: 'markdown table' },
  { id: 'multi-08', category: 'multi', text: "## Next steps\nSay the word and I'll do it.", expected: false, why: 'heading markup' },
  { id: 'multi-09', category: 'multi', text: '```\nsay the word and I will run it\n```', expected: false, why: 'code block' },
  { id: 'multi-10', category: 'multi', text: `I reviewed the files and here is the plan. ${'a '.repeat(210)}Say the word and I will do it.`, expected: false, why: 'single paragraph over 400 characters' },
  { id: 'multi-11', category: 'multi', text: "I will not change it. Say the word and I'll leave it alone.", expected: false, why: 'negation spelled out' },
  { id: 'multi-12', category: 'multi', text: "I won't change it. Say the word and I'll restore it.", expected: false, why: 'contracted negation' },
  { id: 'multi-13', category: 'multi', text: 'Não vou mexer nisso. Se quiser, eu abro a PR.', expected: false, why: 'Portuguese negation' },
  { id: 'multi-14', category: 'multi', text: "Should I restore the branches or reopen the PR? Say the word and I'll restore them.", expected: false, why: 'question offering options' },
  { id: 'multi-15', category: 'multi', text: "Quer que eu abra a PR ou que eu rode a suíte? Só dizer que eu começo.", expected: false, why: 'Portuguese question with options' },
  { id: 'multi-16', category: 'multi', text: "> Say the word and I'll do it.", expected: false, why: 'blockquote markup' },
  { id: 'multi-17', category: 'multi', text: "Want me to fix X? Want me to install Y?", expected: false, why: 'two Want me to invitations' },
  { id: 'multi-18', category: 'multi', text: "Se quiser, eu rodo a suíte. Se quiser, eu abro a PR.", expected: false, why: 'two Portuguese invitations in one paragraph' },
  { id: 'multi-19', category: 'multi', text: "Say the word and I'll restore all six, one branch each.", expected: true, why: 'one clause with a multiple object is still one action' },
  { id: 'multi-20', category: 'multi', text: 'Say the word and I can fix X and install Y.', expected: false, why: 'invitation plus two action verbs, one of them spelled without a Portuguese suffix' },
  { id: 'multi-21', category: 'multi', text: "If you want, I can fix X and I'll install Y.", expected: false, why: 'two explicit English action verbs after one invitation' },

  // Neutral replies.
  { id: 'neutral-01', category: 'neutral', text: 'Instalei beautifulsoup4 e rodei os testes.', expected: false, why: 'status report' },
  { id: 'neutral-02', category: 'neutral', text: 'Fixed the failing test and pushed the commit.', expected: false, why: 'finished fix with no offer' },
  { id: 'neutral-03', category: 'neutral', text: 'Hi there, how are you?', expected: false, why: 'greeting' },
  { id: 'neutral-04', category: 'neutral', text: 'Done.', expected: false, why: 'bare done' },
  { id: 'neutral-05', category: 'neutral', text: 'You have the word: I can open the PR.', expected: false, why: 'idiom is not an invitation' },
  { id: 'neutral-06', category: 'neutral', text: 'Whenever you are ready, I can open the PR.', expected: false, why: 'no invitation phrase from the list' },
  { id: 'neutral-07', category: 'neutral', text: 'He gave me his word, so I can trust him.', expected: false, why: 'word used idiomatically' },
  { id: 'neutral-08', category: 'neutral', text: 'It was your call to make, and I can live with it.', expected: false, why: 'your call used idiomatically with no action on offer' },
  { id: 'neutral-09', category: 'neutral', text: 'Let me know if you need anything else.', expected: false, why: 'generic offer, no specific action' },
  { id: 'neutral-10', category: 'neutral', text: 'The build is green. I can send the log if you want it.', expected: false, why: 'status plus wish, no invitation in the same block' },
  { id: 'neutral-11', category: 'neutral', text: 'Pronto, fechei os seis cards.', expected: false, why: 'Portuguese status report' },
  { id: 'neutral-12', category: 'neutral', text: 'Oi! Tudo bem?', expected: false, why: 'Portuguese greeting' },
  { id: 'neutral-13', category: 'neutral', text: 'Aguardando o retorno do time.', expected: false, why: 'Portuguese status report' },
  { id: 'neutral-14', category: 'neutral', text: 'I have the results; the word is still with the reviewer.', expected: false, why: 'invitation word used as a noun' },

  // Paragraph boundaries, line endings, blank lines.
  { id: 'boundary-01', category: 'boundary', text: 'Revisei os quatro commits.\n\nSe quiser, eu abro a PR agora.\n\nO resto segue amanhã.', expected: true, why: 'one of three paragraphs proposes', paragraph: 'Se quiser, eu abro a PR agora.' },
  { id: 'boundary-02', category: 'boundary', text: 'Se quiser, eu abro a PR.\n\nSó dizer que eu fecho os cards.', expected: false, why: 'one proposal in each of two paragraphs' },
  { id: 'boundary-03', category: 'boundary', text: "Say the word and I'll restore them.\n\nThanks for waiting.", expected: true, why: 'proposal followed by a neutral paragraph', paragraph: "Say the word and I'll restore them." },
  { id: 'boundary-04', category: 'boundary', text: "Fixed the tests.\r\n\r\nSay the word and I'll open the PR.\r\n\r\nDone.", expected: true, why: 'CRLF line endings', paragraph: "Say the word and I'll open the PR." },
  { id: 'boundary-05', category: 'boundary', text: '\n\n\nIf you want, I can open the PR.\n\n\n', expected: true, why: 'extra blank lines around the proposal', paragraph: 'If you want, I can open the PR.' },
  { id: 'boundary-06', category: 'boundary', text: `${'Context paragraph. '.repeat(30)}\n\nSay the word and I'll do it.\n\nTail.`, expected: true, why: 'long surrounding paragraph, short proposal', paragraph: "Say the word and I'll do it." },
  { id: 'boundary-07', category: 'boundary', text: 'Say the word and I will do the first item.\n\nAt your word, I will do the second.', expected: false, why: 'two invitations in separate paragraphs' },
  { id: 'boundary-08', category: 'boundary', text: 'The report is ready.\r\nSay the word and I will post it.', expected: true, why: 'CRLF without a blank line, proposal in the same block', paragraph: 'The report is ready.\r\nSay the word and I will post it.' },
  { id: 'boundary-09', category: 'boundary', text: 'Done.\n\nSay the word and I will post it.\n\nDone again.', expected: true, why: 'proposal between two neutral blocks' },
  { id: 'boundary-10', category: 'boundary', text: 'I can do it.\n\nYour call.', expected: true, why: 'action in one block, invitation in the next; runner counts one proposal', paragraph: 'Your call.' },

  // A next_steps card outranks the text, including an invitation in that text.
  { id: 'card-01', category: 'card', text: "Say the word and I'll do all three steps.", expected: false, why: 'next_steps card present: stepsOpen only, no proceed', card: true },
  { id: 'card-02', category: 'card', text: 'Se quiser, eu faço os três passos.', expected: false, why: 'Portuguese invitation with a next_steps card', card: true }
]

const observed = (c: Case): string => {
  if (c.card) return 'card wins: detector not called'
  const hit = oneActionProposal(c.text)
  return hit ? `proceed with ${JSON.stringify(hit.paragraph)}` : 'no proceed'
}

describe('one-action detector corpus', () => {
  it(`covers at least 60 cases (got ${cases.length})`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(60)
  })

  it.each(cases)('$id [$category] $why', (c) => {
    const hit = c.card ? undefined : oneActionProposal(c.text)
    const message = `input=${JSON.stringify(c.text)} observed=${observed(c)} expected=${c.expected ? 'proceed' : 'no proceed'} why=${c.why}`
    expect(!!hit, message).toBe(c.expected)
    if (c.paragraph && hit) expect(hit.paragraph, message).toBe(c.paragraph)
  })
})
