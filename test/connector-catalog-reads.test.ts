// A tool the catalog knows only reads gets the read class on sync, whatever its name says: Microsoft's
// "login" (Softeria's server) hands the person a code, and an agent allowed only to read must reach it
// to sign in at all. A server added by hand with the same tool keeps the class its name gives.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConnectorManager } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { plainCipher, Secrets } from '../src/core/secrets'
import { CATALOG, catalogInput } from '../src/shared/connector-catalog'

const sdk = pathToFileURL(resolve('node_modules/@modelcontextprotocol/sdk/dist/esm')).href
const schema = { type: 'object' as const, properties: {} }
const tools = ['login', 'list-mail-messages', 'send-draft-message'].map((name) => ({ name, description: name, inputSchema: schema, annotations: { readOnlyHint: name.startsWith('list') } }))

let db: Db
let connectors: ConnectorManager
let path: string | undefined
const until = async (ok: () => boolean, ms = 8000): Promise<void> => {
  for (let i = 0; i < ms / 20 && !ok(); i++) await new Promise((r) => setTimeout(r, 20))
  expect(ok()).toBe(true)
}

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-reads-')), 'test.db'))
  connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => 'http://127.0.0.1:1/oauth/callback' })
  path = process.env['PATH']
})
afterEach(async () => {
  await connectors.closeAll()
  db.close()
  process.env['PATH'] = path
})

// An "npx" of our own first on the PATH, answering as the server would, so nothing is downloaded.
describe.skipIf(process.platform === 'win32')('a tool the catalog knows only reads', () => {
  it("is a read for the catalog's Microsoft connector, and keeps its name's class elsewhere", async () => {
    const bin = mkdtempSync(join(tmpdir(), 'tucano-npx-'))
    const server = join(bin, 'server.mjs')
    writeFileSync(
      server,
      `const { Server } = await import('${sdk}/server/index.js')
const { StdioServerTransport } = await import('${sdk}/server/stdio.js')
const { ListToolsRequestSchema } = await import('${sdk}/types.js')
const s = new Server({ name: 'ms', version: '1' }, { capabilities: { tools: {} } })
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ${JSON.stringify(tools)} }))
await s.connect(new StdioServerTransport())`
    )
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\nexec "${process.execPath}" "${server}"\n`)
    chmodSync(join(bin, 'npx'), 0o755)
    process.env['PATH'] = `${bin}${delimiter}${path}`

    const outlook = await connectors.add(catalogInput(CATALOG.find((c) => c.id === 'outlook')!))
    const byHand = await connectors.add({ name: 'Mine', kind: 'stdio', command: 'npx', args: ['-y', 'some-other-server'] })
    await until(() => db.tools(outlook).length === 3 && db.tools(byHand).length === 3)
    const cls = (id: string, name: string): string | undefined => db.tools(id).find((t) => t.name === name)?.cls
    expect(cls(outlook, 'login')).toBe('read')
    expect(cls(outlook, 'list-mail-messages')).toBe('read')
    expect(cls(outlook, 'send-draft-message')).toBe('sensitive')
    expect(cls(byHand, 'login')).toBe('write')
  }, 20_000)
})
