// A finished reply that ends with one action offered in words ("say the word and I'll…") gets a
// single approval button. The detector reads the last paragraphs of the reply, not a tool call:
// there is no card to ask the agent for, because the proposal is already what it said.
import { L } from './lang'

// The visible label is one phrase per message, picked from this list by the message id. It never
// reshuffles when the window redraws the conversation.
export const PROCEED_LABELS: readonly string[] = [
  L('Sim', 'Yes'),
  L('Claro!', 'Of course!'),
  L('Vai em frente', 'Go on'),
  L('Por favor, faça', 'Please do'),
  L('Absolutamente', 'Absolutely'),
  L('Faça isso', 'Do it'),
  L('Vamos lá', "Let's go"),
  L('Você tem a palavra', 'You have the word'),
  L('Com certeza', 'Sure thing'),
  L('Pode ir', 'Go ahead'),
  L('Sem dúvida', 'By all means'),
  L('Pode contar comigo', 'Count on me'),
  L('Com prazer', 'With pleasure'),
  L('Combinado', 'Agreed'),
  L('Já', 'Right away'),
  L('Faça assim', 'Make it so'),
  L('Eu topo', "I'm in"),
  L('Vá na frente', 'Lead the way'),
  L('Afirmativo', 'Affirmative'),
  L('Parece bom', 'Sounds good'),
  L('Pronto quando você estiver', 'Ready when you are'),
  L('Aprovado', 'Approved'),
  L('Sinal verde', 'Green light')
]

export function proceedLabel(messageId: string): string {
  let hash = 2166136261 // FNV-1a: stable across processes, locales and re-renders
  for (let i = 0; i < messageId.length; i++) {
    hash ^= messageId.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return PROCEED_LABELS[(hash >>> 0) % PROCEED_LABELS.length]!
}

// The family the agent actually writes, in both languages. One match per paragraph and one
// action clause: two invitations or two things it offers to do are a menu, not one proposal.
const INVITATION = new RegExp(
  [
    'say the word',
    'at your word',
    'just say (?:yes|so|yes or no)',
    'if you want',
    "if you['’]d like",
    'if you would like',
    'want me to',
    'do you want me to',
    'would you like me to',
    'your call',
    'ready when you are',
    "ready when you['’]re",
    'you have the word',
    "whenever you (?:are|['’]re) ready",
    'if you say so',
    'just tell me to',
    'tell me to',
    'let me know if',
    'shall i',
    'say so and i',
    'se quiser',
    'se você quiser',
    'se quiseres',
    'quando quiser',
    'quando você quiser',
    'quando você mandar',
    'só me avisar',
    'só me dizer',
    'só dizer',
    'só pedir',
    'é só dizer',
    'diga sim',
    'me avise',
    'você decide',
    'fico no aguardo',
    'se permitir',
    'se eu puder',
    'posso eu',
    'quer que eu',
    'no seu tempo'
  ].join('|'),
  'gi'
)

const ACTION =
  /(?:i(?:['’]ll| will| can| could| would)|let me|vou|posso|faço|faria|deixo|leio|abro|escrevo|rode|trago|monto|preparo|instalo|configuro|checo)/gi
const NO_ACTION = /\b(?:i(?:['’]ll| will| can| could| would))\s+(?:not|never)\b|\b(?:não|never)\s+(?:vou|posso|faço)\b/i
const LIST = /(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+/
const MARKUP = /(?:^|\n)\s*(?:#{1,6}\s|\||>|\d+\.\s|[-*•]\s)|```/

export function oneActionProposal(reply: string): { paragraph: string } | undefined {
  const blocks = reply
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
  const proposals = blocks.filter((block) => {
    if (block.length > 400 || MARKUP.test(block) || LIST.test(block) || NO_ACTION.test(block)) return false
    const flat = block.replace(/\s+/g, ' ')
    if ([...flat.matchAll(INVITATION)].length !== 1) return false
    return [...flat.matchAll(ACTION)].length <= 1
  })
  return proposals.length === 1 ? { paragraph: proposals[0]! } : undefined
}
