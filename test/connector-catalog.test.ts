import { describe, expect, it } from 'vitest'
import { CATALOG, CATEGORIES, sameServer, searchCatalog } from '../src/shared/connector-catalog'
import { LOGOS } from '../src/renderer/src/connector-logos'

describe('the connector catalog', () => {
  it('lists each service once, at an https address, in a category that exists', () => {
    expect(CATALOG.length).toBe(34)
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
})
