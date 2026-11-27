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
// From a channel it can also point at a question left in one of its threads (`inThread`), with how
// many more wait in other threads (`more`): there the question is otherwise only a mark on the thread's
// link, pages up behind the work.
export function AskStrip({ asked, who, onOpen, inThread = false, more = 0 }: { asked: Message; who: string | undefined; onOpen: () => void; inThread?: boolean; more?: number }): ReactNode {
  const questions = questionsOf(asked.run)
  // Each decision in its own words: the run's `question` is the copy written for the agent, options and all.
  const text = questions.map((q) => q.question).join(' · ') || asked.text
  return (
    <button className="ask-strip" onClick={onOpen} title={L('Ir para a pergunta', 'Go to the question')}>
      <Icon name="ask" size={14} />
      <span className="ask-strip__who">{who ?? L('Um agente', 'An agent')}</span>
      <span className="ask-strip__text">{text}</span>
      {questions.length > 1 && <span className="ask-strip__count">{L(`${questions.length} decisões`, `${questions.length} choices`)}</span>}
      {inThread && <span className="ask-strip__count">{more ? L(`+${more} em outras threads`, `+${more} in other threads`) : L('numa thread', 'in a thread')}</span>}
      <span className="ask-strip__go">{L('Responder', 'Answer')}</span>
    </button>
  )
}
