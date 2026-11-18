import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { plainCipher, Secrets, type Cipher } from '../src/core/secrets'
import { derive, newKdf, newKey, newRecoveryCode, open, readRecoveryCode, safeEqual, seal } from '../src/core/vault/crypto'
import { canUse, cleanHost, DEVICE_SECRET, hostAllowed, Vault } from '../src/core/vault'
import { refsIn, scrubText, shellWithEnv, variants, VaultTurn } from '../src/core/vault/refs'
import { vaultHttp } from '../src/core/vault/tool'
import type { VaultItemInput } from '../src/shared/types'
import { errorFor } from '../src/shared/errors'

const agent = (id: string, extra: { kind?: 'tuca'; archived?: boolean } = {}) => ({ id, kind: extra.kind, archived: extra.archived ?? false }) as { id: string; kind?: 'tuca'; archived: boolean }

const input = (p: Partial<VaultItemInput> = {}): VaultItemInput => ({
  name: 'github_token',
  kind: 'api_key',
  description: 'GitHub',
  values: { value: 'ghp_supersecretvalue123' },
  access: { all: false, agentIds: ['a1'] },
  hosts: ['api.github.com'],
  scope: 'http',
  askEachUse: false,
  ...p
})

describe('vault crypto', () => {
  it('seals and opens, bound to its AAD and key', () => {
    const k = newKey()
    const s = seal(k, Buffer.from('hello'), 'item|1|1')
    expect(open(k, s, 'item|1|1').toString()).toBe('hello')
    expect(() => open(k, s, 'item|2|1')).toThrow() // moved to another item
    expect(() => open(k, s, 'item|1|2')).toThrow() // another version
    expect(() => open(newKey(), s, 'item|1|1')).toThrow()
    const b = Buffer.from(s, 'base64')
    b[b.length - 1] = b[b.length - 1]! ^ 1
    expect(() => open(k, b.toString('base64'), 'item|1|1')).toThrow() // tampered
  })

  it('reads its recovery code, forgiving case and dashes, refusing a typo', () => {
    const { code, secret } = newRecoveryCode()
    expect(code).toMatch(/^TUCANO(-[A-Z0-9]{1,6}){6}$/)
    expect(readRecoveryCode(code)?.equals(secret)).toBe(true)
    expect(readRecoveryCode(code.toLowerCase().replace(/-/g, ' '))?.equals(secret)).toBe(true)
    const chars = code.split('')
    const at = code.length - 3
    chars[at] = chars[at] === 'A' ? 'B' : 'A'
    expect(readRecoveryCode(chars.join(''))).toBeUndefined()
    expect(readRecoveryCode('nonsense')).toBeUndefined()
  })

  it('derives the same key from the same code and kdf', () => {
    const { secret } = newRecoveryCode()
    const kdf = newKdf()
    expect(derive(secret, kdf).equals(derive(secret, kdf))).toBe(true)
    expect(derive(secret, newKdf()).equals(derive(secret, kdf))).toBe(false)
  })

  it('compares in constant time, any length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('hosts', () => {
  it('cleans and matches', () => {
    expect(cleanHost('https://API.github.com/v3/')).toBe('api.github.com')
    expect(cleanHost('*.example.com')).toBe('*.example.com')
    expect(cleanHost('not a host')).toBeUndefined()
    expect(hostAllowed(new URL('https://api.github.com/x'), ['api.github.com'])).toBe(true)
    expect(hostAllowed(new URL('https://evil.com/?api.github.com'), ['api.github.com'])).toBe(false)
    expect(hostAllowed(new URL('https://a.example.com'), ['*.example.com'])).toBe(true)
    expect(hostAllowed(new URL('https://example.com'), ['*.example.com'])).toBe(false)
    expect(hostAllowed(new URL('https://badexample.com'), ['*.example.com'])).toBe(false)
    expect(hostAllowed(new URL('http://localhost:8123'), ['localhost:8123'])).toBe(true)
    expect(hostAllowed(new URL('http://localhost:9000'), ['localhost:8123'])).toBe(false)
  })
})

describe('Vault', () => {
  let dir: string
  let db: Db
  let secrets: Secrets
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tucano-vault-'))
    db = new Db(join(dir, 'test.db'))
    secrets = new Secrets(db, plainCipher)
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('stays empty until made, then opens on its own at the next start', async () => {
    const v = new Vault({ db, secrets })
    await v.start()
    expect(v.status().state).toBe('empty')
    const { recoveryCode } = await v.create()
    expect(recoveryCode).toMatch(/^TUCANO-/)
    v.save(input())
    const again = new Vault({ db, secrets })
    await again.start()
    expect(again.status()).toMatchObject({ state: 'open', count: 1, recoverySaved: false })
    expect(again.reveal(again.list()[0]!.id)).toEqual({ value: 'ghp_supersecretvalue123' })
  })

  it('never stores a value in the clear', async () => {
    const v = new Vault({ db, secrets })
    await v.create()
    v.save(input())
    const raw = JSON.stringify(db.vaultItems()) + JSON.stringify(db.vaultMeta())
    expect(raw).not.toContain('ghp_supersecretvalue123')
    expect(JSON.stringify(v.list())).not.toContain('ghp_supersecretvalue123')
  })

  it("needs the recovery code where this computer's key is gone, and the code brings it back", async () => {
    const v = new Vault({ db, secrets })
    const { recoveryCode } = await v.create()
    v.save(input())
    await secrets.set(DEVICE_SECRET, undefined) // a new computer: the keychain doesn't have it
    const lost = new Vault({ db, secrets })
    await lost.start()
    expect(lost.status().state).toBe('needs_recovery')
    expect(() => lost.save(input({ name: 'other' }))).toThrow(/recupera|recovery/i)
    await expect(lost.recover('TUCANO-AAAAAA-AAAAAA-AAAAAA-AAAAAA-AAAAAA-AAAAAA')).rejects.toThrow()
    await lost.recover(recoveryCode)
    expect(lost.status().state).toBe('open')
    const next = new Vault({ db, secrets })
    await next.start()
    expect(next.status().state).toBe('open')
    expect(next.reveal(next.list()[0]!.id).value).toBe('ghp_supersecretvalue123')
  })

  it("doesn't open with another computer's key", async () => {
    await new Vault({ db, secrets }).create()
    await secrets.set(DEVICE_SECRET, newKey().toString('base64'))
    const v = new Vault({ db, secrets })
    await v.start()
    expect(v.status().state).toBe('needs_recovery')
  })

  it('says why when there is no keychain to keep its key', async () => {
    const broken: Cipher = { encrypt: async () => Promise.reject(new Error('no keyring')), decrypt: async () => Promise.reject(new Error('no keyring')) }
    const v = new Vault({ db, secrets: new Secrets(db, broken) })
    await expect(v.create()).rejects.toThrow('no keyring')
    expect(db.vaultMeta()).toBeUndefined()
  })

  it('starting over keeping the items: same settings, no value, a new code; the old code opens nothing', async () => {
    const v = new Vault({ db, secrets })
    const old = (await v.create()).recoveryCode
    const item = v.save(input({ access: { all: true } }))
    await secrets.set(DEVICE_SECRET, undefined) // another computer
    const there = new Vault({ db, secrets })
    await there.start()
    expect(there.status().state).toBe('needs_recovery')
    const { recoveryCode } = await there.reset(true)
    expect(recoveryCode).not.toBe(old)
    expect(there.status()).toMatchObject({ state: 'open', count: 1 })
    const [kept] = there.list()
    expect(kept).toMatchObject({ id: item.id, name: 'github_token', description: 'GitHub', access: { all: true }, hosts: ['api.github.com'], missing: true })
    expect(() => there.reveal(item.id)).toThrow(/sem valor|no value/)
    // An agent is told what to do, and nothing is sent.
    const t = new VaultTurn(there, agent('a1'))
    expect(t.check({ h: '{{vault:github_token}}' }, 'http', 'vault_http', 'https://api.github.com').error).toMatch(/sem valor|no value/)
    // Editing without a value isn't enough; typed again, it works again.
    expect(() => there.save(input({ id: item.id, values: {} }))).toThrow()
    there.save(input({ id: item.id, values: { value: 'ghp_new_value_789' } }))
    expect(there.list()[0]!.missing).toBeUndefined()
    expect(there.reveal(item.id).value).toBe('ghp_new_value_789')
    // The old code is no use any more.
    await secrets.set(DEVICE_SECRET, undefined)
    const later = new Vault({ db, secrets })
    await later.start()
    await expect(later.recover(old)).rejects.toThrow()
    await later.recover(recoveryCode)
    expect(later.reveal(item.id).value).toBe('ghp_new_value_789')
  })

  it('starting from scratch leaves nothing', async () => {
    const v = new Vault({ db, secrets })
    await v.create()
    v.save(input())
    await v.reset(false)
    expect(v.status()).toMatchObject({ state: 'open', count: 0 })
  })

  it('a new recovery code retires the old one', async () => {
    const v = new Vault({ db, secrets })
    const first = (await v.create()).recoveryCode
    const second = v.newRecoveryCode().recoveryCode
    await secrets.set(DEVICE_SECRET, undefined)
    const lost = new Vault({ db, secrets })
    await lost.start()
    await expect(lost.recover(first)).rejects.toThrow()
    await lost.recover(second)
    expect(lost.isOpen()).toBe(true)
  })

  it('editing keeps the value unless typed again, and a new kind needs it again', async () => {
    const v = new Vault({ db, secrets })
    await v.create()
    const item = v.save(input())
    v.save(input({ id: item.id, description: 'new', values: {} }))
    expect(v.reveal(item.id).value).toBe('ghp_supersecretvalue123')
    v.save(input({ id: item.id, values: { value: 'ghp_other_value_456' } }))
    expect(v.reveal(item.id).value).toBe('ghp_other_value_456')
    expect(() => v.save(input({ id: item.id, kind: 'login', values: {} }))).toThrow()
  })

  it('refuses bad names, duplicates and an http item with no host', async () => {
    const v = new Vault({ db, secrets })
    await v.create()
    const first = v.save(input())
    expect(() => v.save(input({ name: 'Bad Name!' }))).toThrow()
    expect(() => v.save(input())).toThrow(/github_token/)
    expect(() => v.save(input({ name: 'GITHUB_TOKEN' }))).toThrow(/github_token/) // the same name, in other case
    const other = v.save(input({ name: 'other_token' }))
    expect(() => v.save(input({ id: other.id, name: 'github_token' }))).toThrow(/github_token/) // renamed onto a taken name
    expect(v.list().map((i) => i.name)).toEqual(['github_token', 'other_token'])
    expect(v.reveal(first.id).value).toBe('ghp_supersecretvalue123') // the first one untouched
    // The screen gets the message as written, not "something went wrong" (src/shared/errors.ts).
    let thrown: unknown
    try {
      v.save(input())
    } catch (e) {
      thrown = e
    }
    expect(errorFor(thrown, false)).toMatch(/github_token/)
    expect(() => v.save(input({ name: 'x1', hosts: [] }))).toThrow()
    expect(v.save(input({ name: 'x2', hosts: [], scope: 'any' })).scope).toBe('any')
  })

  it('"all agents" includes ones made later, never the Tuca; a list fails closed', async () => {
    expect(canUse({ access: { all: true } }, agent('new-one'))).toBe(true)
    expect(canUse({ access: { all: true } }, agent('t', { kind: 'tuca' }))).toBe(false)
    expect(canUse({ access: { all: true } }, agent('old', { archived: true }))).toBe(false)
    expect(canUse({ access: { all: false, agentIds: [] } }, agent('a1'))).toBe(false)
    expect(canUse({ access: { all: false, agentIds: ['a1'] } }, agent('a1'))).toBe(true)
    expect(canUse({ access: { all: false, agentIds: ['a1'] } }, agent('a2'))).toBe(false)
  })
})

describe('references', () => {
  it('finds them anywhere in the arguments', () => {
    const refs = refsIn({ url: 'https://x/{{vault:a}}', headers: { h: '{{ vault:b.username }}' }, list: ['{{vault:a}}'] })
    expect(refs.map((r) => [r.name, r.field])).toEqual([
      ['a', undefined],
      ['b', 'username']
    ])
  })

  it('turns them into variables quoted for where they stand', () => {
    const names = new Map([['{{vault:t}}', 'TUCANO_VAULT_1']])
    expect(shellWithEnv('curl -H "Authorization: Bearer {{vault:t}}" x', names)).toBe('curl -H "Authorization: Bearer ${TUCANO_VAULT_1}" x')
    expect(shellWithEnv("echo '{{vault:t}}'", names)).toBe(`echo ''"\${TUCANO_VAULT_1}"''`)
    expect(shellWithEnv('echo {{vault:t}}', names)).toBe('echo "${TUCANO_VAULT_1}"')
    expect(shellWithEnv('echo \\"{{vault:t}}', names)).toBe('echo \\""${TUCANO_VAULT_1}"')
    expect(shellWithEnv('echo {{vault:t}}', names, 'cmd')).toBe('echo %TUCANO_VAULT_1%')
  })

  it('masks a value in every form it comes back in', () => {
    const v = 'ghp_supersecretvalue123'
    const masks = [{ forms: variants(v), label: '[vault:gh]' }]
    for (const form of [v, Buffer.from(v).toString('base64'), Buffer.from(v).toString('hex'), encodeURIComponent(v + '/'), JSON.stringify({ t: v })]) expect(scrubText(`x ${form} y`, masks)).toContain('[vault:gh]')
    expect(variants('abc')).toEqual([]) // too short to mask
  })
})

describe('VaultTurn', () => {
  let dir: string
  let db: Db
  let vault: Vault
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tucano-vault-'))
    db = new Db(join(dir, 'test.db'))
    vault = new Vault({ db, secrets: new Secrets(db, plainCipher) })
    await vault.create()
    vault.save(input())
    vault.save(input({ name: 'db_pass', kind: 'login', values: { username: 'admin', password: 'p4ssw0rd-long' }, hosts: [], scope: 'any', askEachUse: true }))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('checks before anything runs: unknown and not allowed look the same', () => {
    const t = new VaultTurn(vault, agent('a1'))
    const other = new VaultTurn(vault, agent('a2'))
    expect(t.check({ x: '{{vault:nope}}' }, 'shell', 'bash').error).toMatch(/nope/)
    const a = other.check({ x: '{{vault:github_token}}' }, 'http', 'vault_http', 'https://api.github.com').error
    expect(a).toMatch(/github_token/)
    expect(a).not.toContain('ghp_')
  })

  it('keeps an http item to vault_http and its hosts', () => {
    const t = new VaultTurn(vault, agent('a1'))
    expect(t.check({ c: 'curl {{vault:github_token}}' }, 'shell', 'bash').error).toMatch(/vault_http/)
    expect(t.check({ h: '{{vault:github_token}}' }, 'http', 'vault_http', 'https://evil.com').error).toMatch(/api\.github\.com/)
    expect(t.check({ h: '{{vault:github_token}}' }, 'http', 'vault_http', 'https://api.github.com/user').error).toBeUndefined()
    expect(db.vaultUses(vault.list().find((i) => i.name === 'github_token')!.id).filter((u) => u.outcome === 'refused')).toHaveLength(2)
  })

  it('asks for approval when the item says so, and resolves fields', () => {
    const t = new VaultTurn(vault, agent('a1'))
    const c = t.check({ c: 'psql -U {{vault:db_pass.username}} -p {{vault:db_pass}}' }, 'shell', 'bash')
    expect(c).toMatchObject({ ask: true })
    const sh = t.shell('psql -U {{vault:db_pass.username}} -p {{vault:db_pass}}', 'bash')
    expect(sh.command).toBe('psql -U "${TUCANO_VAULT_1}" -p "${TUCANO_VAULT_2}"')
    expect(sh.env).toEqual({ TUCANO_VAULT_1: 'admin', TUCANO_VAULT_2: 'p4ssw0rd-long' })
    expect(db.vaultUses(vault.list().find((i) => i.name === 'db_pass')!.id).filter((u) => u.outcome === 'used')).toHaveLength(1)
  })

  it('masks every value the agent may use in what comes back', () => {
    const t = new VaultTurn(vault, agent('a1'))
    const r = t.scrubResult({ content: [{ type: 'text', text: 'token=ghp_supersecretvalue123 pass=p4ssw0rd-long' }] })
    expect((r.content[0] as { text: string }).text).toBe('token=[vault:github_token] pass=[vault:db_pass]')
  })

  it('says the vault needs its code while it does', async () => {
    await new Secrets(db, plainCipher).set(DEVICE_SECRET, undefined)
    const lost = new Vault({ db, secrets: new Secrets(db, plainCipher) })
    await lost.start()
    const t = new VaultTurn(lost, agent('a1'))
    expect(t.check({ h: '{{vault:github_token}}' }, 'http', 'vault_http', 'https://api.github.com').error).toMatch(/recupera|recovery/i)
  })
})

describe('vault_http', () => {
  let dir: string
  let db: Db
  let vault: Vault
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tucano-vault-'))
    db = new Db(join(dir, 'test.db'))
    vault = new Vault({ db, secrets: new Secrets(db, plainCipher) })
    await vault.create()
    vault.save(input())
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('sends the value only to its host, never follows a redirect, and masks the echo', async () => {
    const sent: { url: string; init: unknown }[] = []
    const fetch = (async (url: string, init: { headers?: Record<string, string>; redirect?: string }) => {
      sent.push({ url, init })
      return new Response(JSON.stringify({ echoed: init.headers?.['Authorization'] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as never
    const t = new VaultTurn(vault, agent('a1'))
    const r = await vaultHttp(t, { method: 'GET', url: 'https://api.github.com/user', headers: { Authorization: 'Bearer {{vault:github_token}}' } }, { fetch })
    expect(sent[0]!.init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { Authorization: 'Bearer ghp_supersecretvalue123' } })
    const text = (r.content[0] as { text: string }).text
    expect(text).toContain('HTTP 200')
    expect(text).toContain('Bearer [vault:github_token]')
    expect(text).not.toContain('ghp_')
    const refused = await vaultHttp(t, { method: 'GET', url: 'https://api.github.com.evil.com/', headers: { Authorization: '{{vault:github_token}}' } }, { fetch })
    expect(refused.isError).toBe(true)
    expect(sent).toHaveLength(1)
    const plain = await vaultHttp(t, { method: 'GET', url: 'https://api.github.com/' }, { fetch })
    expect(plain.isError).toBe(true) // no secret: not this tool's job
  })

  it('a note with quotes, line breaks and "&" goes in fitted to where it stands, and comes back masked', async () => {
    const note = 'Portão lateral.\nCódigo: 4821#\nFalar com "Seu João" & cia.'
    vault.save(input({ name: 'entrega', kind: 'note', values: { value: note } }))
    const sent: { url: string; body?: string }[] = []
    const fetch = (async (url: string, init: { body?: string }) => {
      sent.push({ url, body: init.body })
      return new Response(JSON.stringify({ received: init.body ? JSON.parse(init.body) : null }), { status: 201, headers: { 'content-type': 'application/json' } })
    }) as never
    const t = new VaultTurn(vault, agent('a1'))
    // JSON body: the note is a string of the JSON, escaped; the request is valid JSON.
    const r = await vaultHttp(t, { method: 'POST', url: 'https://api.github.com/orders', body: '{"cliente": "Livraria Sul", "total": 500.00, "notes": "{{vault:entrega}}"}' }, { fetch })
    expect(JSON.parse(sent[0]!.body!)).toEqual({ cliente: 'Livraria Sul', total: 500, notes: note })
    expect((r.content[0] as { text: string }).text).not.toMatch(/4821|Seu João/) // the echo is masked
    // A form body: URL-encoded.
    await vaultHttp(t, { method: 'POST', url: 'https://api.github.com/f', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1&notes={{vault:entrega}}' }, { fetch })
    expect(new URLSearchParams(sent[1]!.body!).get('notes')).toBe(note)
    // In a URL's query: encoded, so "&" and spaces don't split it.
    await vaultHttp(t, { method: 'GET', url: 'https://api.github.com/search?q={{vault:entrega}}&x=1' }, { fetch })
    expect(new URL(sent[2]!.url).searchParams.get('q')).toBe(note)
    expect(new URL(sent[2]!.url).searchParams.get('x')).toBe('1')
  })

  it('a secret URL put in whole, not encoded', async () => {
    vault.save(input({ name: 'hook', kind: 'url', values: { value: 'https://api.github.com/hooks/abc123secret?x=1' } }))
    const sent: string[] = []
    const fetch = (async (url: string) => (sent.push(url), new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }))) as never
    await vaultHttp(new VaultTurn(vault, agent('a1')), { method: 'POST', url: '{{vault:hook}}', body: '{}' }, { fetch })
    expect(sent[0]).toBe('https://api.github.com/hooks/abc123secret?x=1')
  })
})
