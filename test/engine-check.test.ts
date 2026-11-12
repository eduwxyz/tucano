import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkingFindings, EngineCheck, type EngineFindings, type OneFinding } from '../src/core/engine-check'
import { ENGINE_IDS, type EngineId, type EngineStatus } from '../src/shared/types'

// A promise the test settles by hand: a check that takes as long as the test wants.
function later<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const signedIn: EngineStatus = { installed: true, loggedIn: true, path: '/bin/claude', version: '2.0.0', route: 'plan' }
const findings = (over: Partial<Record<EngineId, EngineStatus>> = {}): Omit<EngineFindings, 'accounts'> => {
  const base = checkingFindings()
  const engines = Object.fromEntries(Object.keys(base.engines).map((e) => [e, { installed: false, loggedIn: false }])) as Record<EngineId, EngineStatus>
  return { engines: { ...engines, ...over }, listed: { opencode: [] }, codexCatalog: [] }
}
const tmpFile = (): string => join(mkdtempSync(join(tmpdir(), 'tucano-engines-')), 'engines.json')

describe('checking the harnesses', () => {
  it('shares one check among everyone who asks while it runs', async () => {
    const runs: ReturnType<typeof later<Omit<EngineFindings, 'accounts'>>>[] = []
    const check = new EngineCheck({
      all: () => {
        const r = later<Omit<EngineFindings, 'accounts'>>()
        runs.push(r)
        return r.promise
      },
      one: async () => ({ status: signedIn })
    })
    const a = check.detect()
    const b = check.detect()
    const c = check.detect()
    expect(runs).toHaveLength(1) // three callers, one check
    expect(b).toBe(a)
    runs[0]!.resolve(findings({ claude: signedIn }))
    const [ra, rb, rc] = await Promise.all([a, b, c])
    expect(ra.engines.claude.loggedIn).toBe(true)
    expect(rb).toBe(ra)
    expect(rc).toBe(ra)
    // Once it ended, the next call is a new check.
    void check.detect()
    expect(runs).toHaveLength(2)
    runs[1]!.resolve(findings())
  })

  it('a check that fails lets the next one run', async () => {
    let n = 0
    const check = new EngineCheck({
      all: async () => {
        n++
        if (n === 1) throw new Error('a CLI hung')
        return findings({ claude: signedIn })
      },
      one: async () => ({ status: signedIn })
    })
    await expect(check.detect()).rejects.toThrow('a CLI hung')
    expect(check.known).toBe(false)
    expect((await check.detect()).engines.claude.loggedIn).toBe(true)
    expect(n).toBe(2)
  })

  it('checks only the harness being signed into, and joins a full check already running', async () => {
    const full = later<Omit<EngineFindings, 'accounts'>>()
    const asked: EngineId[] = []
    const one = later<OneFinding>()
    let fulls = 0
    const check = new EngineCheck({
      all: () => (fulls++, full.promise),
      one: (e) => (asked.push(e), one.promise)
    })
    // A full check running: a recheck waits for it instead of starting its own.
    const running = check.detect()
    expect(check.recheck('codex')).toBe(running)
    expect(asked).toEqual([])
    full.resolve(findings({ claude: signedIn }))
    await running

    // Nothing running: only that harness, once however many times it's asked.
    const r1 = check.recheck('codex')
    const r2 = check.recheck('codex')
    expect(r2).toBe(r1)
    expect(asked).toEqual(['codex'])
    one.resolve({ status: { installed: true, loggedIn: true, route: 'plan' }, listed: ['gpt-5.6-luna'], codexCatalog: [{ slug: 'gpt-5.6-luna', label: 'Luna' }] })
    const after = await r1
    expect(fulls).toBe(1)
    expect(after.engines.codex.loggedIn).toBe(true)
    expect(after.engines.claude.loggedIn).toBe(true) // the others stay as the last check found them
    expect(after.listed.codex).toEqual(['gpt-5.6-luna'])
    expect(after.listed.opencode).toEqual([])
    expect(after.codexCatalog.map((m) => m.slug)).toEqual(['gpt-5.6-luna'])
  })

  it('the accounts are checked inside the same check, and only that harness’s on a recheck', async () => {
    const seen: (EngineId | undefined)[] = []
    const check = new EngineCheck({
      all: async () => findings({ claude: signedIn }),
      one: async () => ({ status: signedIn }),
      after: async (_found, engine) => {
        seen.push(engine)
        return { accounts: { work: { loggedIn: true, detail: 'Plano Claude Max' } } }
      }
    })
    expect((await check.detect()).accounts).toEqual({ work: { loggedIn: true, detail: 'Plano Claude Max' } })
    await check.recheck('claude')
    expect(seen).toEqual([undefined, 'claude'])
  })
})

describe('the last check, kept', () => {
  it('before any check, every harness says it is being checked', () => {
    const check = new EngineCheck({ file: tmpFile(), all: async () => findings(), one: async () => ({ status: signedIn }) })
    expect(check.known).toBe(false)
    expect(Object.values(check.current.engines).every((s) => s.checking && !s.installed)).toBe(true)
  })

  it('the next start opens on what the last check found, until the new one ends', async () => {
    const file = tmpFile()
    const first = new EngineCheck({ file, all: async () => findings({ claude: signedIn }), one: async () => ({ status: signedIn }), after: async () => ({ accounts: { a1: { loggedIn: true } } }) })
    await first.detect()
    expect(existsSync(file)).toBe(true)

    const slow = later<Omit<EngineFindings, 'accounts'>>()
    const next = new EngineCheck({ file, all: () => slow.promise, one: async () => ({ status: signedIn }) })
    expect(next.known).toBe(true)
    expect(next.current.engines.claude).toEqual(signedIn)
    expect(next.current.engines.codex.checking).toBeUndefined()
    expect(next.current.accounts).toEqual({ a1: { loggedIn: true } })
    const done = next.detect()
    slow.resolve(findings())
    expect((await done).engines.claude.loggedIn).toBe(false) // signed out since: the new check wins
    expect((JSON.parse(readFileSync(file, 'utf8')) as EngineFindings).engines.claude.loggedIn).toBe(false)
  })

  it('a damaged file, or one from a version with fewer harnesses, is read safely', () => {
    const file = tmpFile()
    writeFileSync(file, '{ not json')
    expect(new EngineCheck({ file, all: async () => findings(), one: async () => ({ status: signedIn }) }).known).toBe(false)
    writeFileSync(file, JSON.stringify({ engines: { claude: signedIn }, listed: {}, codexCatalog: [] }))
    const check = new EngineCheck({ file, all: async () => findings(), one: async () => ({ status: signedIn }) })
    expect(check.known).toBe(true)
    expect(check.current.engines.claude).toEqual(signedIn)
    expect(check.current.engines.grok.checking).toBe(true)
  })

  it('knows every harness from the first moment, also over a check kept by an older version', () => {
    // Before any check, and on a file written when there were fewer harnesses: each one has a status
    // to read (still checking), so no screen finds a hole where the newest one should be.
    expect(Object.keys(checkingFindings().engines).sort()).toEqual([...ENGINE_IDS].sort())
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ engines: { claude: signedIn }, listed: {}, codexCatalog: [] }))
    const check = new EngineCheck({ all: async () => findings(), one: async () => ({ status: signedIn }), file })
    for (const e of ENGINE_IDS) expect(check.current.engines[e], e).toBeDefined()
    expect(check.current.engines.claude).toEqual(signedIn)
    expect(check.current.engines[ENGINE_IDS[ENGINE_IDS.length - 1]!].checking).toBe(true)
  })
})
