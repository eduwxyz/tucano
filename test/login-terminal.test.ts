import { describe, expect, it } from 'vitest'
import { LoginTerminal, loginCommand, type Pty } from '../src/core/login-terminal'
import { Screen, signInHints } from '../src/core/vt-screen'

describe('Screen', () => {
  it('keeps text, carriage returns and line erases as a terminal would', () => {
    const s = new Screen(20, 5)
    s.write('hello\r\nworld\rW')
    expect(s.lines()).toEqual(['hello', 'World'])
    s.write('\x1b[2K\rgone')
    expect(s.lines()).toEqual(['hello', 'gone'])
  })

  it('redraws a menu in place with cursor moves, and drops colors', () => {
    const s = new Screen(30, 6)
    s.write('\x1b[36m●\x1b[39m One\r\n○ Two\r\n')
    s.write('\x1b[2A\r○ One\r\n\x1b[32m●\x1b[39m Two')
    expect(s.lines()).toEqual(['○ One', '● Two'])
  })

  it('wraps at the edge, joining the wrapped line back, and scrolls at the bottom', () => {
    const s = new Screen(4, 3)
    s.write('abcdefgh\r\nij')
    expect(s.lines()).toEqual(['abcdefgh', 'ij'])
    s.write('\r\nkl\r\nmn')
    expect(s.lines()).toEqual(['ij', 'kl', 'mn'])
    const t = new Screen(4, 3)
    t.write('abcd\r\nef')
    expect(t.lines()).toEqual(['abcd', 'ef']) // full to the edge, then a new line: no wrap
  })

  it('takes an escape sequence cut between two writes', () => {
    const s = new Screen(20, 3)
    s.write('ab\x1b[')
    s.write('2Dx')
    expect(s.lines()).toEqual(['xb'])
  })

  it('starts clean on the alternate screen and positions with H', () => {
    const s = new Screen(10, 4)
    s.write('old\x1b[?1049h\x1b[3;2Hhi')
    expect(s.lines()).toEqual(['', '', ' hi'])
  })
})

describe('signInHints', () => {
  it('finds the page across wrapped lines, and a device code', () => {
    const s = new Screen(30, 10)
    s.write('1. Open https://auth.example.com/device?x=1234567890\r\n2. Enter this code\r\n   6D5A-HIJNZ\r\n')
    expect(signInHints(s)).toEqual({ url: 'https://auth.example.com/device?x=1234567890', code: '6D5A-HIJNZ' })
  })

  it('prefers a link the program marked', () => {
    const s = new Screen(40, 4)
    s.write('\x1b]8;;https://marked.example.com/a\x07click here\x1b]8;;\x07 or https://other.example.com')
    expect(signInHints(s).url).toBe('https://marked.example.com/a')
  })
})

describe('loginCommand', () => {
  it('signs in with no browser on this machine', () => {
    expect(loginCommand('codex').args).toEqual(['login', '--device-auth'])
    expect(loginCommand('grok').args).toEqual(['login', '--device-auth'])
    expect(loginCommand('cursor').env).toEqual({ NO_OPEN_BROWSER: '1' })
    expect(loginCommand('antigravity').hint).toMatch(/código|code/)
    expect(loginCommand('pi').hint).toMatch(/\/login/)
  })
})

function fakePty() {
  let out: (t: string) => void = () => {}
  let end: (code: number) => void = () => {}
  const written: string[] = []
  const pty: Pty & { written: string[]; print: (t: string) => void; end: (code: number) => void; killed: boolean } = {
    written,
    killed: false,
    write: (d) => void written.push(d),
    output: (on) => void (out = on),
    exit: new Promise<number>((r) => (end = r)),
    kill: () => void ((pty.killed = true), end(1)),
    print: (t) => out(t),
    end: (c) => end(c)
  }
  return pty
}

describe('LoginTerminal', () => {
  const setup = (signedIn: () => boolean) => {
    const pty = fakePty()
    const spawned: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
    const t = new LoginTerminal({
      spawn: (bin, args, env) => (spawned.push({ bin, args, env }), pty),
      bin: () => '/bin/codex',
      env: (_e, account) => ({ WHERE: account ?? 'usual' }),
      signedIn: async () => signedIn(),
      pollMs: 5,
      pasteGapMs: 0
    })
    return { pty, spawned, t }
  }

  it('runs the CLI with its variables and shows its screen', () => {
    const { pty, spawned, t } = setup(() => false)
    const s = t.start('cursor', 'acc1')!
    expect(spawned[0]).toMatchObject({ bin: '/bin/codex', args: ['login'], env: { WHERE: 'acc1', NO_OPEN_BROWSER: '1' } })
    pty.print('Open https://cursor.com/login?x=1\r\n')
    expect(t.current()).toMatchObject({ id: s.id, engine: 'cursor', account: 'acc1', state: 'running', url: 'https://cursor.com/login?x=1' })
    t.stop()
  })

  it('types a code, then Enter apart, and named keys', async () => {
    const { pty, t } = setup(() => false)
    const s = t.start('claude')!
    await t.send(s.id, { text: 'abc#def\n', enter: true })
    await t.send(s.id, { key: 'down' })
    expect(pty.written).toEqual(['abc#def', '\r', '\x1b[B'])
    await t.send('someone-else', { text: 'x' })
    expect(pty.written).toHaveLength(3)
    t.stop()
  })

  it('is done once the harness is signed in, and ends the CLI', async () => {
    let yes = false
    const { pty, t } = setup(() => yes)
    t.start('antigravity')
    yes = true
    await new Promise((r) => setTimeout(r, 30))
    expect(t.current()?.state).toBe('done')
    expect(pty.killed).toBe(true)
  })

  it('fails with the last lines when the CLI quits signed out', async () => {
    const { pty, t } = setup(() => false)
    t.start('codex')
    pty.print('Error: device code expired\r\n')
    pty.end(1)
    await new Promise((r) => setTimeout(r, 10))
    expect(t.current()).toMatchObject({ state: 'failed', error: expect.stringContaining('device code expired') })
  })

  it('a stop cancels; with no terminal on this system there is nothing to start', () => {
    const { t } = setup(() => false)
    const s = t.start('codex')!
    t.stop(s.id)
    expect(t.current()?.state).toBe('cancelled')
    const none = new LoginTerminal({ spawn: () => undefined, bin: () => 'x', env: () => ({}), signedIn: async () => false })
    expect(none.start('codex')).toBeUndefined()
  })
})
