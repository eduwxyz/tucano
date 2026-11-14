// A connector's tile on the Connectors page: the picture the person picked for it, else the store's
// mark when it is a service the store knows, else the icon of its kind. Before this, a server added by
// hand wore a terminal or a globe whatever it was.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Connector } from '../src/shared/types'

vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: never) => T): T => select({} as never) }
})
const { ConnectorTile } = await import('../src/renderer/src/components/ConnectorStore')

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const local = { kind: 'stdio' as const, command: 'C:/python/python.exe', args: ['C:/google-mcp/server.py'], auth: 'none' as const, status: 'connected' as const, tools: [] }
const tile = (c: Partial<Connector>): string => renderToStaticMarkup(<ConnectorTile c={{ ...local, ...c }} />)

describe("a connector's tile", () => {
  it('shows the picture picked for a server added by hand, in place of the terminal', () => {
    const html = tile({ name: 'Google Services', icon: png })
    expect(html).toContain('catalog__logo--pic')
    expect(html).toContain(`src="${png}"`)
    expect(html).not.toContain('catalog__logo--own') // the kind's icon is not drawn under the picture
  })

  it("wears the store's mark when the connector is a service the store knows", () => {
    const html = tile({ name: 'Linear', url: 'https://mcp.linear.app/mcp', command: undefined, args: undefined, kind: 'remote' })
    expect(html).toContain('<svg')
    expect(html).not.toContain('catalog__logo--own')
    expect(html).not.toContain('<img')
  })

  it('falls back to the icon of its kind when nothing is set and the store has no mark to give', () => {
    const html = tile({ name: 'Google Services' })
    expect(html).toContain('catalog__logo--own')
    expect(html).not.toContain('<img')
  })
})
