import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serverDesktopState } from '../src/server/desktop'

const session = { TUCANO_SERVER_DESKTOP: '1', DISPLAY: ':99', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/private-bus' }
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
describe('explicit server desktop capabilities', () => {
  it('keeps desktop disabled despite inheriting a graphical session', () => {
    for (const flag of [undefined, '', '0', 'true']) expect(serverDesktopState({ ...session, TUCANO_SERVER_DESKTOP: flag }, 'linux', true).reason).toBe('disabled')
  })
  it('never targets Mac or Windows apps from a server', () => {
    for (const os of ['darwin', 'win32'] as const) expect(serverDesktopState(session, os, true).reason).toBe('platform')
  })
  it('requires a local graphical session, Unix bus and installed helper', () => {
    for (const display of ['', ' ', 'remote:0', 'localhost:10.0']) expect(serverDesktopState({ ...session, DISPLAY: display }, 'linux', true).reason).toBe('display')
    for (const bus of ['', 'tcp:host=example.org']) expect(serverDesktopState({ ...session, DBUS_SESSION_BUS_ADDRESS: bus }, 'linux', true).reason).toBe('dbus')
    expect(serverDesktopState(session, 'linux', false).reason).toBe('helper')
    expect(serverDesktopState(session, 'linux', true)).toEqual({ enabled: true, ready: true })
    expect(serverDesktopState({ ...session, DISPLAY: ':101.0' }, 'linux', true).ready).toBe(true)
  })
})

const launcher = resolve('scripts/server-desktop.sh')
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'tucano-desktop-test-')); dirs.push(home)
  const bin = join(home, 'bin'); mkdirSync(bin)
  const put = (name: string, text: string): void => writeFileSync(join(bin, name), `#!/bin/bash\n${text}\n`, { mode: 0o700 })
  for (const cmd of ['Xvfb', 'xauth', 'agent-desktop', 'xdpyinfo']) put(cmd, 'exit 0')
  put('id', 'echo 1000')
  put('openbox', 'echo $$ > "$HOME/wm-pid"; exec /bin/sleep 60')
  put('xvfb-run', '[[ "$1" == --auto-servernum && "$2" == *-nolisten\\ tcp* ]] || exit 91; shift 2; export DISPLAY=:99; exec "$@"')
  put('dbus-run-session', '[[ "$1" == -- ]] || exit 92; shift; export DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/test-bus; exec "$@"')
  const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, DISPLAY: 'other-host:0', DBUS_SESSION_BUS_ADDRESS: 'tcp:host=other' }
  return { home, bin, put, env }
}
describe.skipIf(process.platform !== 'linux')('private desktop launcher with fixtures only', () => {
  it('has valid shell syntax and a read-only prerequisite check', () => {
    execFileSync('/bin/bash', ['-n', launcher])
    const f = fixture()
    expect(spawnSync('/bin/bash', [launcher, '--check'], { env: f.env }).status).toBe(0)
    expect(existsSync(join(f.home, '.tucano-desktop-runtime'))).toBe(false)
    expect(existsSync(join(f.home, 'tucano-workspace'))).toBe(false)
  })
  it('fails closed before launching when prerequisites are unavailable', () => {
    const f = fixture()
    // Isolate PATH entirely, including the uname probe needed by --check.
    f.put('uname', 'echo Linux')
    const r = spawnSync('/bin/bash', [launcher, '--check'], { env: { ...f.env, PATH: f.bin } })
    expect(r.status).toBe(1)
    expect(r.stderr.toString()).toContain('Missing bash')
    expect(existsSync(join(f.home, 'tucano-workspace'))).toBe(false)
  })
  it('launches only within the private session and propagates server failure', () => {
    const f = fixture()
    const entry = join(f.home, 'server fixture.sh')
    writeFileSync(entry, 'printf "%s\\n" "$TUCANO_SERVER" "$TUCANO_SERVER_DESKTOP" "$DISPLAY" "$DBUS_SESSION_BUS_ADDRESS" "$PWD" > "$HOME/observed"\nexit 7\n')
    const result = spawnSync('/bin/bash', [launcher, '/bin/bash', entry], { env: f.env, timeout: 10000 })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr.toString()).toBe(7)
    if (existsSync(join(f.home, 'wm-pid'))) expect(() => process.kill(Number(readFileSync(join(f.home, 'wm-pid'), 'utf8')), 0)).toThrow()
    expect(readFileSync(join(f.home, 'observed'), 'utf8').split('\n').slice(0, 5)).toEqual(['1', '1', ':99', 'unix:path=/tmp/test-bus', join(f.home, 'tucano-workspace')])
  })
})
