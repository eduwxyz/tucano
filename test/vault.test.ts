import { describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { Secrets, plainCipher } from '../src/core/secrets'
import { maskKeys, Vault } from '../src/core/vault'
import { keyHint, keyNameError, parseEnv } from '../src/shared/vault'
import type { Agent } from '../src/shared/types'

const agent = (id: string): Agent => ({ id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1000, used: 0, grants: {}, memory: 'auto', computer: true, archived: false })
const admin = { id: 'owner', admin: true, team: true }
const ana = { id: 'ana', admin: false, team: true }
const alone = { id: 'owner', admin: true, team: false }

function setup(op?: (ref: string) => Promise<string>): { db: Db; vault: Vault } {
  const db = new Db(':memory:')
  for (const id of ['fin', 'mkt']) db.saveAgent(agent(id))
  return { db, vault: new Vault({ db, secrets: new Secrets(db, plainCipher), ...(op ? { readOp: op } : {}), now: () => 1000 }) }
}

describe('a key’s name', () => {
  it('is an environment variable’s, and not one the shell lives on', () => {
    expect(keyNameError('STRIPE_KEY')).toBeUndefined()
    expect(keyNameError('OPENAI_API_KEY')).toBeUndefined() // it never reaches the agent's own process
    expect(keyNameError('stripe')).toBeDefined()
    expect(keyNameError('PATH')).toBeDefined()
    expect(keyNameError('LD_PRELOAD')).toBeDefined()
    expect(keyNameError('TUCANO_DATA')).toBeDefined()
  })

  it('shows only its last characters', () => {
    expect(keyHint('sk_live_1234567890abcd')).toBe('••••abcd')
    expect(keyHint('short')).toBe('••••')
    expect(keyHint('op://Vault/Stripe/key')).toBe('1Password')
  })
})

describe('an .env read', () => {
  it('takes each NAME=value, quotes and comments off, and says why a line can’t be a key', () => {
    const lines = parseEnv(['# comment', 'export STRIPE_KEY="sk_live_x"', "DB_URL='postgres://a b'", 'PLAIN=abc # note', 'lower=1', 'EMPTY=', 'PLAIN=def'].join('\n'))
    expect(lines.map((l) => [l.name, l.value, !!l.error])).toEqual([
      ['STRIPE_KEY', 'sk_live_x', false],
      ['DB_URL', 'postgres://a b', false],
      ['lower', '1', true],
      ['EMPTY', '', true],
      ['PLAIN', 'def', false]
    ])
  })
})

describe('the two drawers', () => {
  it('an admin’s key is the team’s; a member’s is their own, and only they see it', async () => {
    const { vault } = setup()
    const team = await vault.save(admin, { name: 'STRIPE_KEY', value: 'sk_live_team_123', agents: ['fin'], approve: false })
    const own = await vault.save(ana, { name: 'GITHUB_TOKEN', value: 'ghp_ana_123456', agents: ['fin'], approve: false })
    expect(team.owner).toBeUndefined()
    expect(own.owner).toBe('ana')
    expect(vault.list(admin).map((k) => k.name)).toEqual(['STRIPE_KEY'])
    expect(vault.list(ana).map((k) => k.name).sort()).toEqual(['GITHUB_TOKEN', 'STRIPE_KEY'])
  })

  it('a member can’t change or delete the team’s keys', async () => {
    const { vault } = setup()
    const team = await vault.save(admin, { name: 'STRIPE_KEY', value: 'sk_live_team_123', agents: [], approve: false })
    await expect(vault.save(ana, { id: team.id, name: 'STRIPE_KEY', agents: ['fin'], approve: false })).rejects.toThrow()
    await expect(vault.remove(ana, team.id)).rejects.toThrow()
    expect(() => vault.setAgent(ana, team.id, 'fin', true)).toThrow()
  })

  it('alone, there is only the Cofre: no "mine"', async () => {
    const { vault } = setup()
    expect((await vault.save(alone, { name: 'A_KEY', value: 'value-123', mine: true, agents: [], approve: false })).owner).toBeUndefined()
  })

  it('a name once per drawer', async () => {
    const { vault } = setup()
    await vault.save(admin, { name: 'TOKEN', value: 'value-team', agents: [], approve: false })
    await expect(vault.save(admin, { name: 'TOKEN', value: 'value-again', agents: [], approve: false })).rejects.toThrow()
    await expect(vault.save(ana, { name: 'TOKEN', value: 'value-ana', agents: [], approve: false })).resolves.toBeDefined()
  })

  it('a new key needs a value; a change without one keeps it', async () => {
    const { vault } = setup()
    await expect(vault.save(admin, { name: 'X_KEY', agents: [], approve: false })).rejects.toThrow()
    const k = await vault.save(admin, { name: 'X_KEY', value: 'value-1234567890', agents: [], approve: false })
    const again = await vault.save(admin, { id: k.id, name: 'X_KEY', agents: ['fin'], approve: true })
    expect(again).toMatchObject({ hint: '••••7890', agents: ['fin'], approve: true })
  })
})

describe('an agent’s command', () => {
  it('uses only the keys given to it, and a person’s own only in work for that person', async () => {
    const { vault } = setup()
    await vault.save(admin, { name: 'STRIPE_KEY', value: 'sk_live_team_123', agents: ['fin'], approve: false })
    await vault.save(ana, { name: 'GITHUB_TOKEN', value: 'ghp_ana_123456', agents: ['fin'], approve: false })
    expect('keys' in vault.pick('fin', ['STRIPE_KEY'], 'joao')).toBe(true)
    expect(vault.pick('mkt', ['STRIPE_KEY'], 'ana')).toHaveProperty('error')
    expect(vault.pick('fin', ['GITHUB_TOKEN'], 'joao')).toHaveProperty('error')
    expect(vault.pick('fin', ['GITHUB_TOKEN'], 'ana')).toHaveProperty('keys')
  })

  it('a person’s own key of a name stands in for the team’s', async () => {
    const { vault } = setup()
    await vault.save(admin, { name: 'TOKEN', value: 'value-team-1', agents: ['fin'], approve: false })
    const own = await vault.save(ana, { name: 'TOKEN', value: 'value-ana-1', agents: ['fin'], approve: false })
    const r = vault.pick('fin', ['TOKEN'], 'ana')
    expect('keys' in r && r.keys[0]!.id).toBe(own.id)
  })

  it('opens the values into the environment, logs each use and masks them in what it prints', async () => {
    const { db, vault } = setup()
    const k = await vault.save(admin, { name: 'STRIPE_KEY', value: 'sk_live_team_123', agents: ['fin'], approve: false })
    const env = await vault.open([k], { agentId: 'fin', conversationId: 'c1', personId: 'ana', via: 'bash' })
    expect(env).toEqual({ STRIPE_KEY: 'sk_live_team_123' })
    expect(db.vaultUses()).toMatchObject([{ name: 'STRIPE_KEY', agentId: 'fin', personId: 'ana', via: 'bash' }])
    expect(db.vaultKey(k.id)?.usedAt).toBe(1000)
    expect(vault.mask('fin', 'key=sk_live_team_123 ok')).toBe('key=[cofre:STRIPE_KEY] ok')
    expect(vault.mask('mkt', 'key=sk_live_team_123')).toBe('key=sk_live_team_123') // not its key: never opened for it
  })

  it('reads a 1Password reference at use, and warming never asks 1Password', async () => {
    const reads: string[] = []
    const { vault } = setup(async (ref) => (reads.push(ref), 'from-1password-123'))
    const k = await vault.save(admin, { name: 'OP_KEY', value: 'op://Vault/Item/field', agents: ['fin'], approve: false })
    await vault.warm('fin')
    expect(reads).toEqual([])
    expect(await vault.open([k], { agentId: 'fin', via: 'bash' })).toEqual({ OP_KEY: 'from-1password-123' })
    expect(reads).toEqual(['op://Vault/Item/field'])
  })

  it('warming lets the mask know the values before the first use', async () => {
    const { vault } = setup()
    await vault.save(admin, { name: 'STRIPE_KEY', value: 'sk_live_team_123', agents: ['fin'], approve: false })
    const fresh = new Vault({ db: (vault as unknown as { deps: { db: Db } }).deps.db, secrets: new Secrets((vault as unknown as { deps: { db: Db } }).deps.db, plainCipher) })
    expect(fresh.mask('fin', 'sk_live_team_123')).toBe('sk_live_team_123')
    await fresh.warm('fin')
    expect(fresh.mask('fin', 'sk_live_team_123')).toBe('[cofre:STRIPE_KEY]')
  })

  it('a deleted key is gone with its value', async () => {
    const { db, vault } = setup()
    const k = await vault.save(admin, { name: 'GONE_KEY', value: 'value-123456', agents: ['fin'], approve: false })
    await vault.remove(admin, k.id)
    expect(db.vaultKeys()).toEqual([])
    expect(db.getSecret(`vault:${k.id}`)).toBeUndefined()
  })
})

describe('masking', () => {
  it('in the forms a program prints a value', () => {
    const keys = [{ name: 'K', value: 'a+b/c=d&e"f' }]
    expect(maskKeys('raw a+b/c=d&e"f', keys)).toBe('raw [cofre:K]')
    expect(maskKeys(`json ${JSON.stringify('a+b/c=d&e"f')}`, keys)).toBe('json "[cofre:K]"')
    expect(maskKeys(`url ${encodeURIComponent('a+b/c=d&e"f')}`, keys)).toBe('url [cofre:K]')
    expect(maskKeys(`b64 ${Buffer.from('a+b/c=d&e"f').toString('base64')}`, keys)).toContain('[cofre:K]')
  })

  it('a value that contains another is masked whole; a short one is left alone', () => {
    expect(maskKeys('xx abcdef123456 yy', [{ name: 'SHORT', value: 'abcdef' }, { name: 'LONG', value: 'abcdef123456' }])).toBe('xx [cofre:LONG] yy')
    expect(maskKeys('abc', [{ name: 'TINY', value: 'abc' }])).toBe('abc')
  })
})
