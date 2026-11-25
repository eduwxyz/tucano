// The Microsoft connector runs the server that comes inside Tucano (Softeria's ms-365-mcp-server, at the
// version in package.json) on Tucano's own runtime, with nothing to install. Started for real here: listing
// its tools needs no account and no network.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConnectorManager, microsoftHint } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { plainCipher, Secrets } from '../src/core/secrets'
import { CATALOG, catalogInput, MS365_VERSION } from '../src/shared/connector-catalog'

const sdk = pathToFileURL(resolve('node_modules/@modelcontextprotocol/sdk/dist/esm')).href
let db: Db
let secrets: Secrets
let root: string
let connectors: ConnectorManager
const until = async (ok: () => boolean, ms = 30_000): Promise<void> => {
  for (let i = 0; i < ms / 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 50))
  expect(ok()).toBe(true)
}
const entry = (id: string) => CATALOG.find((c) => c.id === id)!
const listed = (id: string): string[] => /^\^\((.+)\)\$$/.exec(catalogInput(entry(id)).env!['ENABLED_TOOLS']!)![1]!.split('|')

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-ms365-'))
  db = new Db(join(dir, 'test.db'))
  secrets = new Secrets(db, plainCipher)
  root = join(dir, 'connectors')
  connectors = new ConnectorManager({ db, secrets, emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => 'http://127.0.0.1:1/oauth/callback', builtinRoot: root, runtime: process.execPath })
})
afterEach(async () => {
  await connectors.closeAll()
  db.close()
})

describe('the Microsoft connector', () => {
  it('runs the version package.json pins', () => {
    const pinned = JSON.parse(readFileSync('package.json', 'utf8')).dependencies['@softeria/ms-365-mcp-server']
    const installed = JSON.parse(readFileSync('node_modules/@softeria/ms-365-mcp-server/package.json', 'utf8')).version
    expect(pinned).toBe(MS365_VERSION) // exact: an update is a choice, made here
    expect(installed).toBe(MS365_VERSION)
  })

  for (const [id, count] of [['outlook', 43], ['microsoft-365', 53]] as const) {
    it(`${id}: starts inside Tucano with exactly its list, and its sign-in is a read`, async () => {
      const c = await connectors.add(catalogInput(entry(id)))
      await until(() => connectors.get(c)?.status === 'connected' && db.tools(c).length > 0)
      const tools = db.tools(c)
      // Every name on the list is one this version has: a rename would drop a tool without a word.
      expect(tools.map((t) => t.name).sort()).toEqual([...listed(id)].sort())
      expect(tools).toHaveLength(count)
      const cls = (name: string): string | undefined => tools.find((t) => t.name === name)?.cls
      expect(cls('login')).toBe('read') // a reader can sign in
      expect(cls('list-mail-messages')).toBe('read')
      expect(cls('send-draft-message')).toBe('sensitive')
      expect(cls('delete-mail-message')).toBe('sensitive')
      // Its key is in the vault, its state under its own folder, and removing it takes both.
      expect(await secrets.get(`connector:${c}:cache-key`)).toMatch(/^[A-Za-z0-9+/]{43}=$/)
      expect(existsSync(join(root, c, 'logs'))).toBe(true)
      await connectors.remove(c)
      expect(existsSync(join(root, c))).toBe(false)
      expect(await secrets.get(`connector:${c}:cache-key`)).toBeUndefined()
    }, 60_000)
  }

  it('keeps a server added by hand with a login tool as its name says', async () => {
    // The read class is for the catalog's server only: another "login" may do anything.
    const script = join(mkdtempSync(join(tmpdir(), 'tucano-stdio-')), 'server.mjs')
    writeFileSync(
      script,
      `const { Server } = await import('${sdk}/server/index.js')
const { StdioServerTransport } = await import('${sdk}/server/stdio.js')
const { ListToolsRequestSchema } = await import('${sdk}/types.js')
const s = new Server({ name: 't', version: '1' }, { capabilities: { tools: {} } })
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'login', description: 'login', inputSchema: { type: 'object', properties: {} } }] }))
await s.connect(new StdioServerTransport())`
    )
    const c = await connectors.add({ name: 'Mine', kind: 'stdio', command: process.execPath, args: [script] })
    await until(() => db.tools(c).length === 1)
    expect(db.tools(c)[0]!.cls).toBe('write')
  })
})

// Before anyone signed in, an agent read "No accounts found. Please login first." as the person's job and
// sent them to Connectors; the sign-in is the agent's to start, with the login tool.
describe("the Microsoft server's sign-in, said to the agent", () => {
  const result = (text: string, isError?: boolean) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) })
  it('tells it to call login when a call fails for want of an account', () => {
    expect(microsoftHint('Outlook.com', 'list-mail-messages', result('{"error":"No accounts found. Please login first."}', true))).toMatch(/login/)
  })
  it("says login's answer is the sign-in, not an error, and to hand over the link and the code", () => {
    const hint = microsoftHint('Outlook.com', 'login', result('{"error":"device_code_required","message":"To sign in, use a web browser to open the page https://www.microsoft.com/link and enter the code ABC123 to authenticate."}'))
    expect(hint).toMatch(/não é um erro|not an error/)
    expect(hint).toMatch(/verify-login/)
  })
  it('says nothing about other results', () => {
    expect(microsoftHint('Outlook.com', 'list-mail-messages', result('{"value":[]}'))).toBeUndefined()
    expect(microsoftHint('Outlook.com', 'list-mail-messages', result('Graph said 404', true))).toBeUndefined()
  })
})
