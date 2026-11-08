import { describe, expect, it } from 'vitest'
import { CATALOG, catalogInput, catalogView, ownAppGuide, slackAppLink } from '../src/shared/connector-catalog'

describe('catalogView', () => {
  const view = catalogView()

  it('has every entry of the store, as plain data', () => {
    expect(view.map((v) => v.id)).toEqual(CATALOG.map((c) => c.id))
    expect(JSON.parse(JSON.stringify(view))).toEqual(view) // nothing a phone can't read
  })

  it('says what each asks, which own app it needs and what runs on the machine', () => {
    const github = view.find((v) => v.id === 'github')!
    expect(github.auth).toBe('token')
    expect(github.fields).toEqual([expect.objectContaining({ id: 'token', secret: true, label: expect.any(String), placeholder: 'github_pat_…' })])
    expect(view.find((v) => v.id === 'gmail')).toMatchObject({ app: 'google', auth: 'oauth' })
    expect(view.find((v) => v.id === 'azure-devops')?.runs).toBe('npx -y @azure-devops/mcp')
    expect(view.find((v) => v.id === 'linear')).toEqual({ id: 'linear', name: 'Linear', category: 'dev', about: expect.any(String), auth: 'oauth' })
  })

  it('an entry added from the phone becomes the same input as on the desktop', () => {
    const azure = CATALOG.find((c) => c.id === 'azure-devops')!
    expect(catalogInput(azure, { organization: 'https://dev.azure.com/contoso/' })).toMatchObject({ kind: 'stdio', args: ['-y', '@azure-devops/mcp', 'contoso'] })
  })
})

describe('ownAppGuide', () => {
  it('walks through Google with a link per step and the fields to paste', () => {
    const g = ownAppGuide('google', 'http://127.0.0.1:7391/oauth/callback')
    expect(g.steps.filter((s) => s.link)).toHaveLength(5)
    expect(g.steps[1]!.link).toContain('gmailmcp.googleapis.com')
    expect(g.idPlaceholder).toMatch(/apps\.googleusercontent\.com/)
  })

  it("gives Slack's app link with the Tucano's own return address", () => {
    const url = 'https://ana.tucano.sh/oauth/callback'
    expect(ownAppGuide('slack', url).steps[0]!.link).toBe(slackAppLink(url))
  })
})
