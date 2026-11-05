import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { agentChannels, agentNow, placeCard } from '../src/renderer/src/agent-card'
import type { Conversation, Message, Run } from '../src/shared/types'

const agent = { id: 'lia', archived: false, used: 0, limit: 1000 }
const msg = (id: string, author: string, at: number, run?: Partial<Run>, conversationId = 'c1'): Message => ({
  id,
  conversationId,
  author: author === 'me' ? { kind: 'me' } : { kind: 'agent', id: author },
  text: '',
  at,
  run: run && { status: 'done', steps: [], ...run }
})

describe('what an agent’s card says it is doing', () => {
  it('says where it works now and the step running', () => {
    const messages = [
      msg('1', 'lia', 1, { status: 'done' }),
      msg('2', 'lia', 2, { status: 'working', steps: [{ id: 's1', label: 'Lendo o arquivo', status: 'done' }, { id: 's2', label: 'Rodando os testes', status: 'running' }] }, 'c2'),
      msg('3', 'theo', 3, { status: 'working' })
    ]
    expect(agentNow(agent, messages)).toEqual({ kind: 'working', conversationId: 'c2', doing: 'Rodando os testes', since: 2 })
  })
  it('says it waits on me, for an answer or an approval', () => {
    expect(agentNow(agent, [msg('1', 'lia', 1, { status: 'waiting_input' })])).toEqual({ kind: 'waiting', conversationId: 'c1', on: 'input' })
    expect(agentNow(agent, [msg('1', 'lia', 1, { status: 'waiting_approval' })])).toEqual({ kind: 'waiting', conversationId: 'c1', on: 'approval' })
  })
  it('puts work before waiting, and both before the limit', () => {
    const messages = [msg('1', 'lia', 1, { status: 'waiting_input' }), msg('2', 'lia', 2, { status: 'working' })]
    expect(agentNow({ ...agent, used: 1000 }, messages).kind).toBe('working')
    expect(agentNow({ ...agent, used: 1000 }, [msg('1', 'lia', 1)])).toEqual({ kind: 'limit' })
  })
  it('says an archived agent does nothing, whatever its messages say', () => {
    expect(agentNow({ ...agent, archived: true }, [msg('1', 'lia', 1, { status: 'working' })])).toEqual({ kind: 'archived' })
  })
  it('otherwise says when it last spoke, or nothing if it never did', () => {
    expect(agentNow(agent, [msg('1', 'lia', 5), msg('2', 'me', 9), msg('3', 'theo', 10)])).toEqual({ kind: 'idle', lastAt: 5 })
    expect(agentNow(agent, [msg('1', 'me', 1)])).toEqual({ kind: 'idle', lastAt: undefined })
  })
})

it('lists the channels an agent is in, not the DMs', () => {
  const conv = (id: string, kind: Conversation['kind'], members: string[]): Conversation => ({ id, kind, name: id, members })
  const all = [conv('eng', 'channel', ['lia', 'theo']), conv('dados', 'channel', ['theo']), conv('dm', 'dm', ['lia']), conv('geral', 'channel', ['lia'])]
  expect(agentChannels('lia', all).map((c) => c.id)).toEqual(['eng', 'geral'])
})

describe('where the card goes', () => {
  const view = { width: 1280, height: 820 }
  const card = { width: 320, height: 300 }
  const face = { left: 360, top: 150, width: 34, height: 34 }

  it('opens to the right of what was clicked, top-aligned with it', () => {
    expect(placeCard(face, card, view)).toEqual({ left: 402, top: 150, width: 320 })
  })
  it('goes left when there’s no room on the right (a face in a thread panel at the edge)', () => {
    expect(placeCard({ left: 1100, top: 150, width: 34, height: 34 }, card, view)).toEqual({ left: 772, top: 150, width: 320 })
  })
  it('stays whole on screen near the bottom', () => {
    const p = placeCard({ ...face, top: 700 }, card, view)
    expect(p.top + card.height).toBeLessThanOrEqual(view.height - 12)
  })
  it('opens under a top bar’s button, kept inside the window', () => {
    expect(placeCard({ left: 262, top: 20, width: 60, height: 28 }, card, view, 'below')).toEqual({ left: 262, top: 56, width: 320 })
    expect(placeCard({ left: 1200, top: 20, width: 24, height: 24 }, card, view, 'below').left).toBe(1280 - 320 - 12)
  })
  it('spans a narrow window, under the click or above it', () => {
    const phone = { width: 360, height: 700 }
    expect(placeCard({ left: 20, top: 100, width: 34, height: 34 }, card, phone)).toEqual({ left: 12, top: 142, width: 336 })
    expect(placeCard({ left: 20, top: 600, width: 34, height: 34 }, card, phone).top).toBe(600 - 8 - 300)
  })
})

// Layout needs a browser: a long name or role must wrap inside the card, not widen it.
it.skipIf(!existsSync(chromium.executablePath()))('keeps a long name, handle and role inside the card', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
    const long = 'Pesquisa-e-desenvolvimento-de-projetos-complexos'.repeat(3)
    await page.setContent(`
      <style>${readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')}</style>
      <div class="agent-card c-sky" style="left: 20px; top: 20px">
        <div class="agent-card__band"></div>
        <div class="agent-card__head">
          <span class="agent-card__face"><span class="avatar" style="width:64px;height:64px"></span></span>
          <div class="agent-card__who">
            <h2 class="agent-card__name">${long}</h2>
            <div class="agent-card__handle">@${long.toLowerCase()}</div>
            <div class="agent-card__role">${long}</div>
          </div>
        </div>
        <dl class="agent-card__facts"><div><dt>Modelo</dt><dd>${long}</dd></div></dl>
        <div class="agent-card__actions"><button class="btn btn--primary btn--sm">Mensagem</button><button class="btn btn--sm">Ver perfil completo</button></div>
      </div>`)
    const fits = await page.locator('.agent-card').evaluate((card) => ({ width: (card as HTMLElement).offsetWidth, overflow: card.scrollWidth > card.clientWidth, position: getComputedStyle(card).position }))
    expect(fits).toEqual({ width: 320, overflow: false, position: 'fixed' })
  } finally {
    await browser.close()
  }
})
