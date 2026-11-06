import { describe, expect, it } from 'vitest'
import { CATALOG, CATEGORIES, GOOGLE_APIS, googleScopes, sameServer, searchCatalog } from '../src/shared/connector-catalog'
import { LOGOS } from '../src/renderer/src/connector-logos'

describe('the connector catalog', () => {
  it('lists each service once, at an https address, in a category that exists', () => {
    expect(CATALOG.length).toBe(39)
    expect(new Set(CATALOG.map((c) => c.id)).size).toBe(CATALOG.length)
    expect(new Set(CATALOG.map((c) => c.url)).size).toBe(CATALOG.length)
    const categories = CATEGORIES().map((k) => k.id)
    for (const c of CATALOG) {
      expect(new URL(c.url).protocol, c.name).toBe('https:')
      expect(categories, c.name).toContain(c.category)
      expect(c.about().length, c.name).toBeGreaterThan(3)
    }
  })

  it('has a mark only for services in it', () => {
    for (const id of Object.keys(LOGOS)) expect(CATALOG.some((c) => c.id === id), id).toBe(true)
    for (const l of Object.values(LOGOS)) expect(l.hex).toMatch(/^[0-9A-F]{6}$/i)
  })

  it('knows a connector added by hand is the same server, however the address was typed', () => {
    expect(sameServer('https://MCP.linear.app/mcp/', 'https://mcp.linear.app/mcp')).toBe(true)
    expect(sameServer('https://mcp.linear.app/mcp', 'https://mcp.linear.app/sse')).toBe(false)
    expect(sameServer(undefined, 'https://mcp.linear.app/mcp')).toBe(false)
  })

  it('finds by name or by what the service does, without accents', () => {
    expect(searchCatalog('lin').map((c) => c.id)).toContain('linear')
    expect(searchCatalog('deploy').map((c) => c.id)).toEqual(expect.arrayContaining(['vercel', 'netlify', 'railway']))
    expect(searchCatalog('programacao').length).toBeGreaterThan(5) // the category's name
    expect(searchCatalog('zzz')).toEqual([])
    expect(searchCatalog('  ')).toHaveLength(CATALOG.length)
  })

  it("signs in to Google's five with the person's app, asking only what their tools need", () => {
    const google = CATALOG.filter((c) => c.google)
    expect(google.map((c) => c.id)).toEqual(['gmail', 'google-calendar', 'google-drive', 'google-docs', 'google-sheets'])
    for (const c of google) {
      expect(c.category, c.name).toBe('google')
      expect(c.url, c.name).toMatch(/^https:\/\/\w+mcp\.googleapis\.com\/mcp\/v1$/)
      expect(LOGOS[c.id], c.name).toBeDefined()
      for (const s of c.google!) expect(s, c.name).toMatch(/^https:\/\/www\.googleapis\.com\/auth\/[\w.]+$/)
    }
    // Nothing that sends email or deletes it for good, nor Drive's full access.
    const all = google.flatMap((c) => c.google!)
    expect(all).not.toContain('https://mail.google.com/')
    expect(all).not.toContain('https://www.googleapis.com/auth/gmail.send')
    expect(all).not.toContain('https://www.googleapis.com/auth/drive')
    expect(googleScopes('https://gmailmcp.googleapis.com/mcp/v1/')).toEqual(['https://www.googleapis.com/auth/gmail.modify'])
    expect(googleScopes('https://mcp.linear.app/mcp')).toBeUndefined()
    // Each service's API and its MCP one, turned on in one page.
    expect(GOOGLE_APIS).toEqual(expect.arrayContaining(['calendar-json.googleapis.com', 'calendarmcp.googleapis.com', 'gmail.googleapis.com', 'gmailmcp.googleapis.com']))
    expect(GOOGLE_APIS).toHaveLength(10)
  })
})
