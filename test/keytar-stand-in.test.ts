// vendor/keytar: what the Microsoft connector's server finds when it reaches for the system keychain. It
// hands over only the key Tucano keeps in its vault, and never stores anything.
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const keytar = createRequire(import.meta.url)('../vendor/keytar') as {
  getPassword(s: string, a: string): Promise<string | null>
  setPassword(s: string, a: string, p: string): Promise<void>
  findCredentials(s: string): Promise<{ account: string; password: string }[]>
}
const KEY = Buffer.alloc(32, 7).toString('base64')
afterEach(() => delete process.env['TUCANO_MS365_CACHE_KEY'])

describe('the keytar stand-in', () => {
  it("hands over Tucano's key for the cache, and nothing else", async () => {
    process.env['TUCANO_MS365_CACHE_KEY'] = KEY
    expect(await keytar.getPassword('ms-365-mcp-server', 'cache-key')).toBe(KEY)
    expect(await keytar.getPassword('ms-365-mcp-server', 'msal-token-cache')).toBeNull() // tokens never live here
    expect(await keytar.getPassword('other', 'cache-key')).toBeNull()
    expect(await keytar.findCredentials('ms-365-mcp-server')).toEqual([{ account: 'cache-key', password: KEY }])
  })

  it('stores nothing: writing the same key is fine, anything else fails', async () => {
    process.env['TUCANO_MS365_CACHE_KEY'] = KEY
    await expect(keytar.setPassword('ms-365-mcp-server', 'cache-key', KEY)).resolves.toBeUndefined()
    await expect(keytar.setPassword('ms-365-mcp-server', 'cache-key', 'other')).rejects.toThrow(/vault/)
    await expect(keytar.setPassword('ms-365-mcp-server', 'msal-token-cache', 'x')).rejects.toThrow()
  })

  it('without a key, has none: the server then keeps its own beside the file', async () => {
    expect(await keytar.getPassword('ms-365-mcp-server', 'cache-key')).toBeNull()
    await expect(keytar.setPassword('ms-365-mcp-server', 'cache-key', KEY)).rejects.toThrow()
  })
})
