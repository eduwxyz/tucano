import type { Message } from '../../../shared/types'
import { L } from '../../../shared/lang'
import { questionsOf } from '../../../shared/questions'
import { Icon } from './ui'
import type { ReactNode } from 'react'

// The open question, kept where the person is typing instead of only where it was asked.
// A reply can be thousands of steps long, so the card that waits for an answer ends up pages up
// behind later tool calls; this says what is waiting and takes the person to it in one click.
// It doesn't answer: there is one answering surface (the card), which keeps a single record of
// what was picked.
export function AskStrip({ asked, who, onOpen }: { asked: Message; who: string | undefined; onOpen: () => void }): ReactNode {
  const questions = questionsOf(asked.run)
  const text = asked.run?.question ?? asked.text
  return (
    <button className="ask-strip" onClick={onOpen} title={L('Ir para a pergunta', 'Go to the question')}>
      <Icon name="ask" size={14} />
      <span className="ask-strip__who">{who ?? L('Um agente', 'An agent')}</span>
      <span className="ask-strip__text">{text}</span>
      {questions.length > 0 && <span className="ask-strip__count">{L(`${questions.length} ${questions.length === 1 ? 'decisão' : 'decisões'}`, `${questions.length} ${questions.length === 1 ? 'choice' : 'choices'}`)}</span>}
      <span className="ask-strip__go">{L('Responder', 'Answer')}</span>
    </button>
  )
}
