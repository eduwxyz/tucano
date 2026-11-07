// Every method of the core's API, called with junk (nothing, null, the wrong types): each one
// answers (a result or an error) and the core goes on. Nothing reaches the process as an
// unhandled rejection or exception: on a server, one of those would take everyone's Tucano down.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SHAPES } from '../src/shared/rpc-shapes'
import type { Method } from '../src/shared/rpc'
import { bootCore, type Client } from './helpers/core'

const rpc = readFileSync(join(import.meta.dirname, '..', 'src', 'shared', 'rpc.ts'), 'utf8')
const api = rpc.slice(rpc.indexOf('export interface Api {'))
const methods = [...api.matchAll(/^ {2}(\w+)\((?:p: \{([^\n]*?)\})?\)/gm)].map((m) => ({ name: m[1]!, fields: [...(m[2] ?? '').matchAll(/(?:^|;)\s*(\w+)\??:/g)].map((f) => f[1]!) }))
// What opens something on this computer (a terminal, a browser, a folder) or goes out to the
// internet when given a well-typed value: called only with values the guard refuses.
const OUTSIDE = new Set(['installEngine', 'loginEngine', 'loginAccount', 'openLocal', 'openExternal', 'setTelegramToken', 'setJevKey', 'wikiAddLink', 'authorizeConnector', 'finishConnectorAuth', 'setWikiDir', 'harnessMcps', 'importHarnessMcp'])
const crashes: unknown[] = []
const onCrash = (e: unknown): void => void crashes.push(e)
let owner: Client

beforeAll(async () => {
  process.on('unhandledRejection', onCrash)
  process.on('uncaughtException', onCrash)
  owner = (await bootCore({ server: true })).connect()
  await owner.call('snapshot')
}, 30_000)
afterAll(() => {
  process.off('unhandledRejection', onCrash)
  process.off('uncaughtException', onCrash)
})

// A value of the type the contract asks for, with nothing real in it.
const typed = (spec: string): unknown => {
  const k = spec.replace(/\?$/, '').replace(/\|null$/, '')
  return k === 'n' ? 1 : k === 'b' ? true : k === 'o' ? {} : k === 'a' || k === 'S' ? [] : k.startsWith('[') ? k.slice(1, -1).split(',')[0] : 'zz-nope'
}

const settle = (p: Promise<unknown>, ms = 5000): Promise<'ok' | 'error' | 'hang'> =>
  Promise.race([p.then(() => 'ok' as const, () => 'error' as const), new Promise<'hang'>((r) => setTimeout(() => r('hang'), ms))])

describe('every RPC with junk params', () => {
  it('reads the methods from the contract, each with its shape', () => {
    expect(methods.length).toBeGreaterThan(130)
    expect(methods.map((m) => m.name).sort()).toEqual(Object.keys(SHAPES).sort())
    for (const m of methods) expect(Object.keys(SHAPES[m.name as Method]), m.name).toEqual(m.fields)
    expect(methods.find((m) => m.name === 'voiceDownload')?.fields).toEqual(['model'])
  })

  it('answers each call and never crashes the core', async () => {
    const junk = (name: string, fields: string[]): [string, unknown, boolean][] => [
      ['nothing', undefined, false],
      ['null', null, false],
      ['{}', {}, false],
      ['a string', 'x', false],
      ['an array', [1], false],
      ['nulls', Object.fromEntries(fields.map((f) => [f, null])), false],
      ['numbers', Object.fromEntries(fields.map((f) => [f, 42])), false],
      ['objects', Object.fromEntries(fields.map((f) => [f, { a: 1 }])), false],
      ['strings', Object.fromEntries(fields.map((f) => [f, 'zz-nope'])), true],
      ['the right types, empty inside', Object.fromEntries(fields.map((f) => [f, typed(SHAPES[name as Method]?.[f] ?? 's')])), true]
    ]
    const hung: string[] = []
    for (const m of methods) {
      if (['installDesktop', 'desktopPermissions', 'openBackups', 'openWikiFolder'].includes(m.name)) continue // no params: it would really do it
      for (const [label, params, typed] of junk(m.name, m.fields)) {
        if (typed && OUTSIDE.has(m.name)) continue
        if (m.fields.length === 0 && label !== 'nothing' && label !== '{}') continue
        const r = await settle(owner.call(m.name, params))
        if (r === 'hang') hung.push(`${m.name} ${label}`)
      }
    }
    await new Promise((r) => setTimeout(r, 300)) // what was left running in the background
    expect(crashes.map((e) => String(e instanceof Error ? e.stack : e).slice(0, 300))).toEqual([])
    expect(hung).toEqual([])
    expect(await owner.call('snapshot')).toBeTruthy()
  }, 300_000)

  it('refuses a call whose params are the wrong shape, saying so', async () => {
    await expect(owner.call('voiceDownload', {})).rejects.toThrow(/Pedido inválido/)
    await expect(owner.call('removeConnector', { id: 7 })).rejects.toThrow(/Pedido inválido/)
    await expect(owner.call('stopService', null)).rejects.toThrow(/Pedido inválido/)
  })
})
