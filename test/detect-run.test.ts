import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from '../src/core/engines/detect'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(process.platform === 'win32')('running a command to detect something', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tucano-detect-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('gives the output of a command that ends', async () => {
    await expect(run('sh', ['-c', 'printf hello'])).resolves.toMatchObject({ code: 0, stdout: 'hello' })
  })

  // An interactive zsh ignores SIGTERM, and what it started keeps the output pipes open.
  it('answers at the time limit when a command ignores being asked to stop', async () => {
    const started = Date.now()
    const result = await run('sh', ['-c', "trap '' TERM; sleep 30"], 200)
    expect(result.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('takes what the command started with it at the time limit', async () => {
    const file = join(dir, 'pid')
    await run('sh', ['-c', `trap '' TERM; sleep 30 & echo $! > '${file}'; wait`], 300)
    expect(existsSync(file)).toBe(true)
    const pid = Number(readFileSync(file, 'utf8'))
    await expect.poll(() => alive(pid), { timeout: 2_000 }).toBe(false)
  })

  it('answers even when something outside the command holds its output open', async () => {
    const started = Date.now()
    const result = await run('sh', ['-c', "trap '' TERM; setsid sleep 4 & wait"], 200)
    expect(result.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})
