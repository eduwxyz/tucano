// The strip above the field: the open question, where the person is typing.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Message } from '../src/shared/types'
import { AskStrip } from '../src/renderer/src/components/AskStrip'

const asked = (run: Partial<NonNullable<Message['run']>> = {}): Message => ({
  id: 'm1',
  conversationId: 'dm',
  author: { kind: 'agent', id: 'a1' },
  text: 'Preciso saber antes de seguir.',
  at: 1,
  run: { status: 'waiting_input', steps: [], depth: 1, ...run }
})

describe('the ask strip', () => {
  it('says who asked and what, and takes the person to it', () => {
    let opened = 0
    const html = renderToStaticMarkup(<AskStrip asked={asked()} who="Lia" onOpen={() => opened++} />)
    expect(html).toContain('Lia')
    expect(html).toContain('Preciso saber antes de seguir.')
    expect(html).toContain('Responder')
    expect(html).toContain('class="ask-strip"')
    expect(opened).toBe(0) // it is a button, not an action on render
  })

  it('counts the decisions when the question has them', () => {
    const html = renderToStaticMarkup(
      <AskStrip
        asked={asked({ question: '1. Paginar? 2. Quando?', questions: [{ question: 'Paginar?', kind: 'single', options: [{ label: 'Sim' }, { label: 'Não' }] }, { question: 'Quando?', kind: 'text' }] })}
        who="Lia"
        onOpen={() => {}}
      />
    )
    expect(html).toContain('2 decisões')
    expect(html).toContain('Paginar? · Quando?') // each decision in its words
    expect(html).not.toContain('1. Paginar?') // not the numbered copy written for the agent
  })

  it('does not count a single question as a decision', () => {
    const html = renderToStaticMarkup(<AskStrip asked={asked({ question: 'Pra quando?' })} who="Lia" onOpen={() => {}} />)
    expect(html).toContain('Pra quando?')
    expect(html).not.toContain('decis')
  })

  it("from the channel, says the question is in a thread, and how many more wait in others", () => {
    const one = renderToStaticMarkup(<AskStrip asked={asked({ question: 'Posso subir?' })} who="Lia" inThread onOpen={() => {}} />)
    expect(one).toContain('numa thread')
    const three = renderToStaticMarkup(<AskStrip asked={asked({ question: 'Posso subir?' })} who="Lia" inThread more={2} onOpen={() => {}} />)
    expect(three).toContain('+2 em outras threads')
    const here = renderToStaticMarkup(<AskStrip asked={asked({ question: 'Posso subir?' })} who="Lia" onOpen={() => {}} />)
    expect(here).not.toContain('thread')
  })

  it('still makes sense when the agent is gone', () => {
    const html = renderToStaticMarkup(<AskStrip asked={asked()} who={undefined} onOpen={() => {}} />)
    expect(html).toContain('Um agente')
  })
})
