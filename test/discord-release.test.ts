// The release post on Discord: the Portuguese list, the English headlines, and the link, within an embed.
import { describe, expect, it } from 'vitest'
// @ts-expect-error a plain .mjs script, with no types
import { english, message, portuguese } from '../scripts/discord-release.mjs'

const body = [
  '**Tucano is a team of AI agents.** It runs on your CLI.',
  '',
  '> **Em português:**',
  '> - **Novo:** uma rotina roda em **vários horários**.',
  '> - **Corrigido:** o cartão abre ao lado.',
  '',
  '### Added',
  '',
  '- **One routine at several times a day.** A routine had one time…',
  '',
  '### Fixed',
  '',
  "- **A routine's card opens beside it again.** Pages rise in…",
  '- a line with no bold lead stays out',
  '',
  '## Install',
  '',
  '- **On a Mac.** Download the dmg.'
].join('\n')

describe('the release post on Discord', () => {
  it('takes the Portuguese list and the English headlines, not the install steps', () => {
    expect(portuguese(body)).toEqual(['- **Novo:** uma rotina roda em **vários horários**.', '- **Corrigido:** o cartão abre ao lado.'])
    expect(english(body)).toEqual(['- New: One routine at several times a day', "- Fixed: A routine's card opens beside it again"])
  })

  it('makes one embed with the link to the whole notes, and pings no one', () => {
    const m = message({ name: 'Tucano 0.2.37', url: 'https://github.com/x/y/releases/tag/v0.2.37', body })
    expect(m.allowed_mentions).toEqual({ parse: [], roles: [] })
    expect(m.content).toBeUndefined()
    expect(m.embeds[0].title).toBe('Tucano 0.2.37 saiu')
    expect(m.embeds[0].description).toContain('**In English:**')
    expect(m.embeds[0].description.endsWith('(https://github.com/x/y/releases/tag/v0.2.37)')).toBe(true)
  })

  it('pings the release role, and only it', () => {
    const m = message({ name: 'Tucano 0.2.37', url: 'https://u', body }, '1568453984941907998')
    expect(m.content).toBe('<@&1568453984941907998>')
    expect(m.allowed_mentions).toEqual({ parse: [], roles: ['1568453984941907998'] })
  })

  it('cuts at a whole line to fit an embed, and still links the rest', () => {
    const long = ['> **Em português:**', ...Array.from({ length: 200 }, (_, i) => `> - **Novo:** item ${i} ${'x'.repeat(40)}`)].join('\n')
    const d = message({ name: 'T', url: 'https://u', body: long }).embeds[0].description
    expect(d.length).toBeLessThanOrEqual(4096)
    expect(d).toContain('\n…')
    expect(d.endsWith('(https://u)')).toBe(true)
  })
})
