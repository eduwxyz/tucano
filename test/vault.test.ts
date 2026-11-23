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

describe('a site’s login', () => {
  it('in the two drawers, as keys: the site and username shown, never the password', async () => {
    const { db, vault } = setup()
    await vault.saveLogin(admin, { site: 'conta.luz.com.br/entrar', username: 'edu@x.com', password: 'senha-123', agents: ['fin'] })
    await vault.saveLogin(ana, { site: 'https://app.banco.com', username: 'ana@x.com', password: 'senha-ana', agents: ['fin'] })
    expect(vault.logins(admin).map((l) => l.origin)).toEqual(['https://conta.luz.com.br'])
    expect(vault.logins(ana).map((l) => l.origin).sort()).toEqual(['https://app.banco.com', 'https://conta.luz.com.br'])
    expect(JSON.stringify(db.vaultLogins())).not.toContain('senha')
    await expect(vault.saveLogin(admin, { site: 'http://conta.luz.com.br', username: 'a', password: 'b', agents: [] })).rejects.toThrow() // never over plain http
    expect(() => vault.setLoginAgent(ana, vault.logins(admin)[0]!.id, 'mkt', true)).toThrow() // the team's: an admin's
  })

  it('an agent has one per site: giving it another takes the first off', async () => {
    const { vault } = setup()
    const a = await vault.saveLogin(admin, { site: 'conta.luz.com.br', username: 'um@x.com', password: 'senha-1', agents: ['fin'] })
    const b = await vault.saveLogin(admin, { site: 'conta.luz.com.br', username: 'dois@x.com', password: 'senha-2', agents: ['mkt'] })
    vault.setLoginAgent(admin, b.id, 'fin', true)
    expect(vault.logins(admin).find((l) => l.id === a.id)?.agents).toEqual([])
    expect(vault.logins(admin).find((l) => l.id === b.id)?.agents.sort()).toEqual(['fin', 'mkt'])
  })

  it('typed only for whom it may be: the person’s own in their work, and each use logged', async () => {
    const { db, vault } = setup()
    await vault.saveLogin(admin, { site: 'conta.luz.com.br', username: 'time@x.com', password: 'senha-time', agents: ['fin'] })
    await vault.saveLogin(ana, { site: 'conta.luz.com.br', username: 'ana@x.com', password: 'senha-ana', agents: ['fin'] })
    expect(await vault.loginFor('fin', 'https://conta.luz.com.br', { personId: 'joao' })).toEqual({ username: 'time@x.com', password: 'senha-time' })
    expect(await vault.loginFor('fin', 'https://conta.luz.com.br', { personId: 'ana' })).toEqual({ username: 'ana@x.com', password: 'senha-ana' })
    expect(await vault.loginFor('mkt', 'https://conta.luz.com.br', {})).toBeUndefined()
    expect(await vault.loginFor('fin', 'https://conta.luz.com.br.golpe.com', {})).toBeUndefined()
    expect(db.vaultUses().map((u) => [u.via, u.personId])).toEqual([['login', 'ana'], ['login', 'joao']])
  })

  it('the logins saved on an agent’s page before the Cofre move in as the team’s, one per account', async () => {
    const { db, vault } = setup()
    const secrets = (vault as unknown as { deps: { secrets: Secrets } }).deps.secrets
    await secrets.set('browser-login:fin:https://conta.luz.com.br', JSON.stringify({ username: 'edu@x.com', password: 'senha-1' }))
    await secrets.set('browser-login:mkt:https://conta.luz.com.br', JSON.stringify({ username: 'edu@x.com', password: 'senha-1' }))
    await secrets.set('browser-login:mkt:https://app.banco.com', JSON.stringify({ username: 'mkt@x.com', password: 'senha-2' }))
    expect(await vault.moveOldLogins()).toBe(3)
    expect(db.secretKeys('browser-login:')).toEqual([])
    expect(db.vaultLogins().map((l) => [l.origin, l.owner, l.agents.sort()])).toEqual([
      ['https://app.banco.com', undefined, ['mkt']],
      ['https://conta.luz.com.br', undefined, ['fin', 'mkt']]
    ])
    expect(await vault.loginFor('mkt', 'https://conta.luz.com.br', {})).toEqual({ username: 'edu@x.com', password: 'senha-1' })
    expect(await vault.moveOldLogins()).toBe(0) // once
  })
})

describe('pedir_chave’s card', () => {
  it('a key pasted goes to the person’s own and to the agent; an admin may keep it for the team', async () => {
    const { vault } = setup()
    const own = await vault.answer(ana, 'fin', { nome: 'STRIPE_KEY' }, { value: 'sk_live_ana_123' })
    expect(own).toMatchObject({ kind: 'key', created: true, item: { name: 'STRIPE_KEY', owner: 'ana', agents: ['fin'] } })
    const team = await vault.answer(admin, 'fin', { nome: 'STRIPE_KEY' }, { value: 'sk_live_team_123', team: true })
    expect(team.item.owner).toBeUndefined()
    const notTeam = await vault.answer(ana, 'mkt', { nome: 'OTHER_KEY' }, { value: 'value-123456', team: true }) // a member can't say "the team's"
    expect(notTeam.item.owner).toBe('ana')
  })

  it('a key already there by that name gets the new value and the agent', async () => {
    const { vault } = setup()
    const k = await vault.save(admin, { name: 'STRIPE_KEY', value: 'sk_live_old_1234', agents: ['mkt'], approve: true })
    const r = await vault.answer(admin, 'fin', { nome: 'STRIPE_KEY' }, { value: 'sk_live_new_5678', team: true })
    expect(r).toMatchObject({ created: false, item: { id: k.id, hint: '••••5678', approve: true } })
    expect(r.item.agents.sort()).toEqual(['fin', 'mkt'])
  })

  it('one already in the Cofre is given: the team’s only by an admin', async () => {
    const { vault } = setup()
    const k = await vault.save(admin, { name: 'STRIPE_KEY', value: 'sk_live_team_123', agents: [], approve: false })
    await expect(vault.answer(ana, 'fin', { nome: 'STRIPE_KEY' }, { existing: k.id })).rejects.toThrow()
    expect((await vault.answer(admin, 'fin', { nome: 'STRIPE_KEY' }, { existing: k.id })).item.agents).toEqual(['fin'])
  })

  it('a login pasted needs the username and the password', async () => {
    const { vault } = setup()
    await expect(vault.answer(alone, 'fin', { site: 'https://conta.luz.com.br' }, { password: 'x' })).rejects.toThrow()
    const r = await vault.answer(alone, 'fin', { site: 'https://conta.luz.com.br' }, { username: 'edu@x.com', password: 'senha-123' })
    expect(r).toMatchObject({ kind: 'login', item: { origin: 'https://conta.luz.com.br', agents: ['fin'] } })
    expect(vault.loginSites('fin')).toEqual(['https://conta.luz.com.br'])
  })
})
