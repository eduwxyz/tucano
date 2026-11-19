// Tucano Team v1, third round: what the screens say.
import { describe, expect, it } from 'vitest'
import type { ActivityEntry } from '../src/shared/types'
import { activityText, removalText } from '../src/renderer/src/components/People'

describe('L. the people screen', () => {
  it("the removal says a DM's routines stay with the person for the 30 days, and only the others go to the owner", () => {
    const t = removalText('Bia')
    expect(t).not.toContain('as rotinas dele passam pro dono')
    expect(t).toMatch(/rotinas.*DMs.*30 dias|DMs.*rotinas.*30 dias/s)
    expect(t).toContain('passam pro dono do Tucano')
  })

  it('the purge in the log names the person, even once no one remembers them', () => {
    const e: ActivityEntry = { id: '1', at: 1, personId: 'ana', kind: 'person.purged', target: 'bia', detail: { name: 'Bia' } }
    expect(activityText(e, { people: [], agents: [] }, new Map())).toBe('apagou os dados de Bia')
  })
})

describe('A. the heritage notice in the wiki', () => {
  it("tells the owner what changed and lists the pages from their private conversations, each with Liberar", async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { WikiHeritage } = await import('../src/renderer/src/components/Wiki')
    const html = renderToStaticMarkup(<WikiHeritage held={[{ title: 'Salário', at: 1 }, { title: 'Fênix', at: 1 }]} notice />)
    expect(html).toContain('Páginas que vieram das suas conversas privadas')
    expect(html).toContain('Salário')
    expect(html.match(/Liberar pro time/g)?.length).toBe(2)
    expect(renderToStaticMarkup(<WikiHeritage held={[]} notice={false} />)).toBe('')
  })
})

describe('C. who changed a wiki page', () => {
  it('is named: a person here, one who left, an agent, the curator; an old "me" is whoever this is', async () => {
    const { wikiWho } = await import('../src/renderer/src/components/Wiki')
    const state = { you: 'ana', me: { name: 'Ana', initials: 'A' }, people: [{ id: 'ana', name: 'Ana', role: 'owner', about: '' }, { id: 'bruno', name: 'Bruno', role: 'member', about: '' }], former: [{ id: 'bia', name: 'Bia' }], agents: [] } as never
    const who = wikiWho(state)
    expect(who('bruno')).toBe('Bruno')
    expect(who('bia')).toContain('Bia')
    expect(who('ana')).toBe('Ana')
    expect(who('me')).toBe('Ana')
    expect(who('auto')).toBe('o curador')
  })
})
