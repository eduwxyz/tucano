import { describe, expect, it } from 'vitest'
import { CATALOG, catalogInput, CATEGORIES, entryOf, sameServer, searchCatalog } from '../src/shared/connector-catalog'
import { LOGOS } from '../src/renderer/src/connector-logos'

describe('the connector catalog', () => {
  it('lists each service once, at an https address, in a category that exists', () => {
    expect(CATALOG.length).toBe(40)
    expect(new Set(CATALOG.map((c) => c.id)).size).toBe(CATALOG.length)
    const remote = CATALOG.filter((c) => !c.local)
    expect(new Set(remote.map((c) => c.url)).size).toBe(remote.length)
    const categories = CATEGORIES().map((k) => k.id)
    for (const c of CATALOG) {
      if (!c.local) expect(new URL(c.url.replace('{site}', 'https://x.example').replace(/\{\w+\}/g, 'x')).protocol, c.name).toBe('https:')
      // Every {field} in what it adds is one it asks for.
      const asked = new Set((c.fields ?? []).map((f) => f.id))
      for (const [, k] of JSON.stringify([c.url, c.local]).matchAll(/\{(\w+)\}/g)) expect(asked, `${c.name}: {${k}}`).toContain(k)
      if (c.auth === 'token') expect(asked, c.name).toContain('token')
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

  it('fills in what a service asks, however much of its address was pasted', () => {
    const get = (id: string) => CATALOG.find((c) => c.id === id)!
    expect(catalogInput(get('linear'))).toEqual({ name: 'Linear', kind: 'remote', url: 'https://mcp.linear.app/mcp', auth: 'oauth' })
    expect(catalogInput(get('github'), { token: ' github_pat_1 ' })).toMatchObject({ url: 'https://api.githubcopilot.com/mcp/', auth: 'token', token: 'github_pat_1' })
    expect(catalogInput(get('dynatrace'), { environment: 'https://ABC12345.apps.dynatrace.com/ui', token: 't' }).url).toBe(
      'https://abc12345.apps.dynatrace.com/platform-reserved/mcp-gateway/v0.1/servers/dynatrace-mcp/mcp'
    )
    expect(catalogInput(get('snowflake'), { account: 'org-acct.snowflakecomputing.com', database: 'DB', schema: 'S/../x', server: 'AG', token: 't' }).url).toBe(
      'https://org-acct.snowflakecomputing.com/api/v2/databases/DB/schemas/S%2F..%2Fx/mcp-servers/AG' // a value can't reach another path
    )
    expect(catalogInput(get('metabase'), { site: 'metabase.acme.com/' }).url).toBe('https://metabase.acme.com/api/metabase-mcp')
    expect(catalogInput(get('azure-devops'), { organization: 'https://dev.azure.com/contoso/Project' })).toEqual({ name: 'Azure DevOps', kind: 'stdio', command: 'npx', args: ['-y', '@azure-devops/mcp', 'contoso'], env: {} })
    expect(catalogInput(get('azure-devops'), { organization: 'contoso.visualstudio.com' }).args).toEqual(['-y', '@azure-devops/mcp', 'contoso'])
    expect(catalogInput(get('cloudwatch'), { profile: 'prod', region: 'US-EAST-1' })).toMatchObject({ command: 'uvx', env: { AWS_PROFILE: 'prod', AWS_REGION: 'us-east-1' } })
    expect(() => catalogInput(get('cloudwatch'), { profile: 'prod', region: ' ' })).toThrow(/Região|Region/)
    expect(() => catalogInput(get('metabase'), {})).toThrow()
  })

  it('knows which service a connector came from, from what was filled in', () => {
    const get = (id: string) => CATALOG.find((c) => c.id === id)!
    for (const [id, values] of [
      ['linear', {}],
      ['github', { token: 't' }],
      ['dynatrace', { environment: 'abc', token: 't' }],
      ['snowflake', { account: 'a', database: 'b', schema: 'c', server: 'd', token: 't' }],
      ['metabase', { site: 'https://bi.acme.com' }],
      ['azure-devops', { organization: 'contoso' }],
      ['cloudwatch', { profile: 'p', region: 'r' }]
    ] as const)
      expect(entryOf(catalogInput(get(id), values))?.id, id).toBe(id)
    expect(entryOf({ kind: 'remote', url: 'https://bi.acme.com/api/other' })).toBeUndefined()
    expect(entryOf({ kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] })).toBeUndefined()
  })
})
