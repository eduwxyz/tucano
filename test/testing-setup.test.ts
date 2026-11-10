// The testing setup: one model for every checkout, named once, and no Claude assumption in it.
//
// The machine these runs are verified on has no Claude subscription. A core model of 'haiku' (or a
// seeded demo team on 'sonnet') is a model nobody there can call, and the app has nothing to say
// until someone notices; so a testing checkout names its own model, TUCANO_TEST_MODEL, and the core
// and the seed take it. That is the whole of the contract, and this file holds it in place.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { seed } from '../src/core/seed'
import { unlessTesting } from '../src/core/testing-model'
import type { Snapshot } from '../src/shared/rpc'
import { modelInfo } from '../src/shared/types'
import { bootCore } from './helpers/core'
import { isClaudeModel, TEST_CORE_MODEL, TEST_CORE_MODEL_LABEL } from './helpers/testing'

const here = import.meta.dirname
const root = join(here, '..')

// Run the pre-go in a throwaway checkout and say how it went.
function preGo(dir: string, ...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [join(root, 'scripts', 'pre-go.mjs'), '--root', dir, ...args], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

// A checkout as a fresh worktree starts: package.json and the testing contract, nothing else.
function emptyCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pre-go-'))
  writeFileSync(join(dir, 'package.json'), '{"name":"checkout"}')
  mkdirSync(join(dir, 'test'))
  copyFileSync(join(here, 'testing.json'), join(dir, 'test', 'testing.json'))
  return dir
}

// A checkout that already has an install, as a worktree linked to the main one has.
function installIn(dir: string): void {
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '.bin', 'vitest'), '')
}

const models = (db: Db): (string | undefined)[] => db.agents().map((a) => a.modelId)

describe('the model a test runs on', () => {
  it('is DeepSeek 4.1 Flash through Pi, not a Claude model', () => {
    expect(TEST_CORE_MODEL).toBe('pi:opencode-go/deepseek-v4.1-flash')
    expect(isClaudeModel(TEST_CORE_MODEL)).toBe(false)
    expect(TEST_CORE_MODEL_LABEL).toContain('DeepSeek V4.1 Flash')
    const info = modelInfo(TEST_CORE_MODEL)
    expect(info?.engine).toBe('pi')
    expect(info?.label).toBe('opencode-go/deepseek-v4.1-flash')
  })

  it('replaces what the app would have chosen, and only when it is set', () => {
    expect(unlessTesting('haiku', {})).toBe('haiku')
    expect(unlessTesting('haiku', { TUCANO_TEST_MODEL: '' })).toBe('haiku')
    expect(unlessTesting('haiku', { TUCANO_TEST_MODEL: '  ' })).toBe('haiku')
    expect(unlessTesting('haiku', { TUCANO_TEST_MODEL: TEST_CORE_MODEL })).toBe(TEST_CORE_MODEL)
    expect(unlessTesting('gpt-5.6-luna', { TUCANO_TEST_MODEL: ` ${TEST_CORE_MODEL} ` })).toBe(TEST_CORE_MODEL)
  })
})

describe('a testing checkout', () => {
  it('seeds its demo team on the testing model, not on models it cannot reach', () => {
    const db = new Db(join(mkdtempSync(join(tmpdir(), 'seed-')), 'tucano.db'))
    seed(db, { TUCANO_TEST_MODEL: TEST_CORE_MODEL })
    expect(models(db)).toEqual([TEST_CORE_MODEL, TEST_CORE_MODEL, TEST_CORE_MODEL])
    // The team is the same team: three agents, the three handles.
    expect(db.agents().map((a) => a.handle)).toEqual(['lia', 'theo', 'nina'])
  })

  it('leaves a real install exactly as it was: no variable, no change', () => {
    const db = new Db(join(mkdtempSync(join(tmpdir(), 'seed-')), 'tucano.db'))
    seed(db, {})
    expect(models(db)).toEqual(['sonnet', 'gpt-5.6-luna', 'sonnet'])
  })

  it('boots the core on it: the two small jobs and the team all run DeepSeek 4.1 Flash', async () => {
    process.env['TUCANO_TEST_MODEL'] = TEST_CORE_MODEL
    const core = await bootCore()
    const db = new Db(join(core.dataDir, 'tucano.db'))
    const snap = await core.connect().call<Snapshot>('snapshot')
    expect(snap.settings.routerModel).toBe(TEST_CORE_MODEL) // who replies in a channel
    expect(snap.settings.memoryModel).toBe(TEST_CORE_MODEL) // memory
    expect(models(db)).toEqual([TEST_CORE_MODEL, TEST_CORE_MODEL, TEST_CORE_MODEL])
  }, 60_000)
})

describe('pre-go, the one step before a checkout tests', () => {
  it('says a checkout with no install is not ready', () => {
    const dir = emptyCheckout()
    const { code, out } = preGo(dir, '--check')
    expect(code).toBe(1)
    expect(out).toContain('node_modules MISSING')
    expect(out).toContain(TEST_CORE_MODEL)
    expect(out).toContain('not marked yet')
  })

  it('marks a checkout that has an install, then says it is ready', () => {
    const dir = emptyCheckout()
    installIn(dir)
    const set = preGo(dir)
    expect(set.code).toBe(0)
    expect(set.out).toContain(`core model    ${TEST_CORE_MODEL}`)
    const mark = JSON.parse(readFileSync(join(dir, '.pre-go.json'), 'utf8')) as {
      model: string
      env: Record<string, string>
      fakeEngines: boolean
    }
    expect(mark).toMatchObject({ model: TEST_CORE_MODEL, fakeEngines: true, env: { TUCANO_TEST_MODEL: TEST_CORE_MODEL, TUCANO_FAKE_ENGINES: '1' } })
    const check = preGo(dir, '--check')
    expect(check.code).toBe(0)
    expect(check.out).toContain('node_modules ready')
    expect(check.out).toContain('as marked')
  })

  it('borrows an install from a checkout beside it instead of a second npm ci', () => {
    const shared = mkdtempSync(join(tmpdir(), 'shared-'))
    installIn(shared)
    const dir = emptyCheckout()
    const { code, out } = preGo(dir, '--from', shared)
    expect(code).toBe(0)
    expect(out).toContain('linked to')
    expect(existsSync(join(dir, 'node_modules', '.bin', 'vitest'))).toBe(true)
    const mark = JSON.parse(readFileSync(join(dir, '.pre-go.json'), 'utf8')) as { nodeModules: { linkedFrom?: string } }
    expect(mark.nodeModules.linkedFrom).toBe(join(shared, 'node_modules'))
  })

  it('runs a command with the model in its environment, which is the only way a shell gets it', () => {
    const dir = emptyCheckout()
    installIn(dir)
    const { code, out } = preGo(dir, '--run', process.execPath, '-p', 'process.env.TUCANO_TEST_MODEL + " " + process.env.TUCANO_FAKE_ENGINES')
    expect(code).toBe(0)
    expect(out).toContain(`${TEST_CORE_MODEL} 1`)
  })

  it('refuses a folder that is not a checkout, rather than guessing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-a-checkout-'))
    const { code, out } = preGo(dir)
    expect(code).toBe(1)
    expect(out).toContain('not a checkout')
  })

  it('is documented where a contributor looks', () => {
    const text = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8')
    expect(text).toContain('node scripts/pre-go.mjs')
    expect(text).toContain('A testing checkout')
    expect(text).toContain(TEST_CORE_MODEL)
    expect(text).toContain('TUCANO_TEST_MODEL')
  })
})
