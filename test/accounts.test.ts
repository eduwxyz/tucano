import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Account, Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { accountDir, accountLogin } from '../src/core/engines/detect'
import { claudeEngine } from '../src/core/engines/claude'
import { grokAccountEnv, grokEngine } from '../src/core/engines/grok'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const agent = (extra: Partial<Agent> = {}): Agent => ({ id: 'a1', name: 'lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
const counted = (engine: Engine): Engine & { turns: Turn[] } => {
  const turns: Turn[] = []
  return { id: engine.id, turns, run: (t) => (turns.push(t), engine.run(t)) }
}

let db: Db
let data: string
let settings: Settings
let claude: ReturnType<typeof counted>
const work: Account = { id: 'w1', engine: 'claude', name: 'Trabalho', loggedIn: true }

function runner(): Runner {
  claude = counted(fakeEngine('claude', { delayMs: 1 }))
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), dataDir: data })
}
const reply = (): Message => db.messages().find((m) => m.author.kind === 'agent')!

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'ad-data-'))
  db = new Db(join(data, 'test.db'))
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt', accounts: [work] }
  db.saveAgent(agent({ accountId: 'w1' }))
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

describe('accounts', () => {
  it('keeps the agent’s account, and clears it', () => {
    expect(db.agent('a1')!.accountId).toBe('w1')
    db.saveAgent(agent())
    expect(db.agent('a1')!.accountId).toBeUndefined()
  })

  it('runs the agent on its account’s folder, even with the usual login signed out', async () => {
    settings = { ...settings, engines: { ...settings.engines, claude: { installed: true, loggedIn: false } } }
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('done')
    expect(claude.turns[0]!.account).toBe(accountDir(data, 'w1'))
  })

  it('runs on the usual login without an account, or with one of another harness', async () => {
    db.saveAgent(agent({ accountId: undefined }))
    let r = runner()
    await r.send('d1', 'oi')
    await r.idle()
    expect(claude.turns[0]!.account).toBeUndefined()

    settings = { ...settings, accounts: [{ ...work, engine: 'codex' }] }
    db.saveAgent(agent({ accountId: 'w1' }))
    r = runner()
    await r.send('d1', 'de novo')
    await r.idle()
    expect(claude.turns[0]!.account).toBeUndefined()
  })

  it('says so, without starting the CLI, when the account isn’t signed in', async () => {
    settings = { ...settings, accounts: [{ ...work, loggedIn: false }] }
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('failed')
    expect(reply().run?.error).toContain('Trabalho')
    expect(claude.turns).toHaveLength(0)
  })

  it('reads the CLIs’ own status for an account', () => {
    expect(accountLogin('claude', { code: 1, stdout: '{"loggedIn": false, "authMethod": "none"}', stderr: '' })).toEqual({ loggedIn: false })
    expect(accountLogin('claude', { code: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max", "email": "a@b.co"}', stderr: '' })).toEqual({ loggedIn: true, detail: 'Plano Claude Max · a@b.co' })
    expect(accountLogin('codex', { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' })).toEqual({ loggedIn: true, detail: 'Plano ChatGPT' })
    expect(accountLogin('codex', { code: 1, stdout: 'Not logged in', stderr: '' })).toEqual({ loggedIn: false })
    // Grok lists its models signed out too: only the first line says whether there is a login.
    const grokModels = '\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5'
    expect(accountLogin('grok', { code: 0, stdout: `You are logged in with grok.com.${grokModels}`, stderr: '' })).toEqual({ loggedIn: true, detail: 'Plano Grok' })
    expect(accountLogin('grok', { code: 0, stdout: `You are using XAI_API_KEY.${grokModels}`, stderr: '' })).toEqual({ loggedIn: true, detail: 'Chave de API' })
    expect(accountLogin('grok', { code: 1, stdout: `You are not authenticated.${grokModels}`, stderr: '' })).toEqual({ loggedIn: false })
  })

  it('points an account of Grok at its own folder, with no API key to answer in its place', () => {
    const env = grokAccountEnv('/contas/g1', { PATH: '/bin', XAI_API_KEY: 'xai-key', GROK_CODE_XAI_API_KEY: 'xai-code' })
    expect(env['GROK_HOME']).toBe('/contas/g1')
    expect(env['GROK_AUTH_PATH']).toBe(join('/contas/g1', 'auth.json'))
    expect(env['XAI_API_KEY']).toBeUndefined()
    expect(env['GROK_CODE_XAI_API_KEY']).toBeUndefined()
    expect(env['PATH']).toBe('/bin')
  })

  // The stand-in CLI is a shell script, which Windows can't run.
  it.skipIf(process.platform === 'win32')('points Claude Code at the account’s folder', async () => {
    // A stand-in CLI that prints the folder it was given, as a result line.
    const dir = mkdtempSync(join(tmpdir(), 'ad-bin-'))
    const bin = join(dir, 'claude')
    const { writeFileSync, chmodSync } = await import('node:fs')
    writeFileSync(bin, '#!/bin/sh\ncat >/dev/null\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"result\\":\\"$CLAUDE_CONFIG_DIR\\",\\"usage\\":{}}"\n')
    chmodSync(bin, 0o755)
    const turn = { model: 'sonnet', effort: 'low' as const, system: '', prompt: 'oi', cwd: dir, signal: new AbortController().signal, account: '/contas/w1' }
    const texts: string[] = []
    for await (const ev of claudeEngine(() => bin, async () => ({ env: {} })).run(turn)) if (ev.type === 'done') texts.push(ev.text)
    expect(texts).toEqual(['/contas/w1'])
  })

  // The same for Grok, whose login in an account's folder is its auth.json.
  it.skipIf(process.platform === 'win32')('points Grok at the account’s auth.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ad-grok-'))
    const bin = join(dir, 'grok')
    const { writeFileSync, chmodSync } = await import('node:fs')
    writeFileSync(
      bin,
      '#!/bin/sh\ncat >/dev/null\necho "{\\"type\\":\\"text\\",\\"data\\":\\"$GROK_AUTH_PATH\\"}"\necho "{\\"type\\":\\"end\\",\\"stopReason\\":\\"end_turn\\",\\"usage\\":{\\"input_tokens\\":1,\\"output_tokens\\":1}}"\n'
    )
    chmodSync(bin, 0o755)
    const turn = { model: 'grok-4.6', effort: 'low' as const, system: '', prompt: 'oi', cwd: dir, signal: new AbortController().signal, account: '/contas/g1' }
    const texts: string[] = []
    for await (const ev of grokEngine(() => bin, async () => ({})).run(turn)) if (ev.type === 'done') texts.push(ev.text)
    expect(texts).toEqual([join('/contas/g1', 'auth.json')])
  })
})
