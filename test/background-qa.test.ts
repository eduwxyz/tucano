import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { backgroundOptions } from '../src/main/background-qa'
import { Workspaces } from '../src/main/workspaces'

const roots: string[] = []
const directory = (): string => { const dir = mkdtempSync(join(tmpdir(), 'tucano-qa-test-')); roots.push(dir); return dir }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const environment = (data = directory()): NodeJS.ProcessEnv => ({ TUCANO_DATA: data, TUCANO_FAKE_ENGINES: '1', TUCANO_WEBHOOK_PORT: '51001', TUCANO_GIT_PORT: '51002' })
const options = (env: NodeJS.ProcessEnv, profiles: string[] = []) => backgroundOptions(['--qa-background'], env, profiles, [47717, 47718])

it('leaves ordinary startup unchanged and supports an inactive normal launch', () => {
  expect(backgroundOptions([], {}, [], [])).toEqual({ background: false, qa: false })
  expect(backgroundOptions(['--background'], {}, [], [])).toEqual({ background: true, qa: false })
})

it('isolates and persists the scratch workspace ports', () => {
  const env = environment()
  const config = options(env)
  const registry = new Workspaces(env.TUCANO_DATA!, config.ports)
  expect(registry.selected()).toMatchObject({ webhookPort: 51001, gitPort: 51002 })
  expect(new Workspaces(env.TUCANO_DATA!, config.ports).selected()).toEqual(registry.selected())
  expect(() => new Workspaces(env.TUCANO_DATA!)).toThrow('Invalid workspaces')
})

it('refuses occupied profiles and their descendants or ancestors', () => {
  const profile = directory()
  const child = join(profile, 'scratch')
  mkdirSync(child)
  expect(() => options(environment(profile), [profile])).toThrow('application profile')
  expect(() => options(environment(child), [profile])).toThrow('application profile')
  expect(() => options(environment(profile), [child])).toThrow('application profile')
  const env = environment()
  writeFileSync(join(env.TUCANO_DATA!, 'tucano.db'), 'do not change')
  expect(() => options(env)).toThrow('empty')
})

it('refuses missing isolation, real engines and conflicting ports', () => {
  expect(() => options({})).toThrow('absolute')
  expect(() => options(environment('relative'))).toThrow('absolute')
  expect(() => options({ ...environment(), TUCANO_FAKE_ENGINES: '0' })).toThrow('fake engines')
  for (const value of [undefined, '0', '65536', '51002', '47717', '1e4']) {
    expect(() => options({ ...environment(), TUCANO_WEBHOOK_PORT: value })).toThrow('two distinct ports')
  }
})
