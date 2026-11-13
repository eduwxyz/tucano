// An account's folder holds its own login, so removing the account has to take the folder with it,
// and a folder a CLI still has open must not put the account back in the list: what cannot go now
// goes at the next launch.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { dropAccountDir, sweepAccountDirs } from '../src/core/account-folders'

const made: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'af-'))
  made.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('takes the folder away with the login in it', () => {
  const account = join(scratch(), 'g1')
  mkdirSync(join(account, 'sessions'), { recursive: true })
  writeFileSync(join(account, 'auth.json'), '{}')
  expect(dropAccountDir(account)).toBe(true)
  expect(existsSync(account)).toBe(false)
})

// The removal already ran on another machine, or on this one a moment ago.
it('has nothing to take when the folder is already gone', () => {
  expect(dropAccountDir(join(scratch(), 'missing'))).toBe(true)
})

// Every folder the settings no longer name is nobody's login: left behind by a removal that could not
// finish, and taken here at the next launch.
it('sweeps the folders the settings no longer have, and only those', () => {
  const root = scratch()
  for (const name of ['keep1', 'gone1', 'gone2']) mkdirSync(join(root, name), { recursive: true })
  expect(sweepAccountDirs(root, ['keep1']).sort()).toEqual(['gone1', 'gone2'])
  expect(readdirSync(root)).toEqual(['keep1'])
})

it('says nothing where no accounts were ever added', () => {
  expect(sweepAccountDirs(join(scratch(), 'accounts'), [])).toEqual([])
})

// A CLI someone left open on the sign-in holds the folder, and on Windows one handle on a directory
// stops it being deleted: that is reported, not thrown, and the sweep finds it at the next launch.
it.skipIf(process.platform !== 'win32')('reports a folder it could not take instead of throwing', async () => {
  const account = join(scratch(), 'g1')
  mkdirSync(account)
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { cwd: account, stdio: 'ignore' })
  try {
    await new Promise((r) => setTimeout(r, 600))
    expect(dropAccountDir(account)).toBe(false)
    expect(existsSync(account)).toBe(true)
  } finally {
    holder.kill()
  }
  // And once the CLI is gone, the same folder goes: what the sweep does on the next launch.
  await new Promise((r) => setTimeout(r, 400))
  expect(dropAccountDir(account)).toBe(true)
})
