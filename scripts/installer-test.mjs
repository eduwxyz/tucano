// Self-contained installer regressions. No network, root, real service manager or built app required.
// Run: node --test scripts/installer-test.mjs (Node 24+ and POSIX sh/tar).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, readlinkSync, rmSync, symlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const installer = resolve('install-server.sh')
const fixtureSource = `
const fs = require('node:fs');
fs.mkdirSync(process.env.TUCANO_DATA, {recursive:true});
fs.writeFileSync(process.env.TUCANO_DATA + '/server-id', 'fixture-server');
if (process.argv[2] === 'pair') {
  fs.appendFileSync(process.env.TUCANO_DATA + '/pair-calls', 'pair\\n');
  const args = process.argv.slice(3);
  const value = key => args[args.indexOf(key)+1];
  const code = 'AAAA-BBBB-CCCC';
  console.log('Pairing code: ' + code);
  const reach = args.includes('--url') ? 'url=' + encodeURIComponent(value('--url')) : args.includes('--ssh') ? 'ssh=' + encodeURIComponent(value('--ssh')) : '';
  if (reach) console.log('For the Mac app: tucano://pair?v=1&code=' + code + '&' + reach);
}
`
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tucano-installer-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home with spaces')
  const mocks = join(root, 'mocks')
  mkdirSync(home); mkdirSync(mocks)
  function mock(name, body) { writeFileSync(join(mocks, name), '#!/bin/sh\n' + body, { mode: 0o755 }) }
  mock('systemctl', `echo "systemctl $*" >> "$TEST_LOG"
case "$*" in
  *restart*) if [ -n "\${TEST_FAIL_RESTART:-}" ] && [ ! -f "$TEST_FAIL_RESTART" ]; then touch "$TEST_FAIL_RESTART"; exit 1; fi ;;
  *--property=Environment*) echo "TUCANO_HOST=\${TEST_BIND_HOST:-127.0.0.1}" ;;
  *disable*) [ "\${TEST_FAIL_STOP:-}" != 1 ] || exit 1 ;;
  *show-environment*) [ "\${TEST_NO_SESSION:-}" != 1 ] || exit 1 ;;
esac
`)
  mock('loginctl', 'echo "loginctl $*" >> "$TEST_LOG"\necho yes\n')
  mock('curl', 'echo "curl $*" >> "$TEST_LOG"\nprintf %s "${TEST_HTTP_CODE:-401}"\n')
  mock('sleep', ':\n')
  mock('journalctl', 'echo fixture-journal\n')
  mock('uname', 'case "$1" in -s) echo Linux ;; *) echo x86_64 ;; esac\n')
  // Test identity checks without creating users or assuming the runner is non-root.
  mock('id', 'case "$1" in -u) echo "${TEST_UID:-1000}" ;; -un) echo tucano-test ;; *) exit 1 ;; esac\n')
  const app = join(home, '.local/share/tucano-server')
  const data = join(home, '.tucano-server')
  const bin = join(home, '.local/bin')
  const unit = join(home, '.config/systemd/user/tucano.service')
  const env = { ...process.env, HOME: home, PATH: mocks + ':' + process.env.PATH, LANG: 'en_US.UTF-8', TUCANO_NODE: process.execPath, TEST_LOG: join(root, 'calls.log') }
  for (const key of ['TUCANO_HOME', 'TUCANO_DATA', 'TUCANO_BIN', 'TUCANO_PORT', 'TUCANO_SHA256', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SUDO_UID', 'SSH_CONNECTION']) delete env[key]
  function pack(version = '1.0.0', symlink = false) {
    const stage = mkdtempSync(join(root, 'package-'))
    const src = join(stage, 'tucano-server')
    mkdirSync(join(src, 'out/main'), { recursive: true })
    writeFileSync(join(src, 'out/main/server.js'), fixtureSource)
    writeFileSync(join(src, 'VERSION'), version)
    mkdirSync(join(src, 'scripts'))
    writeFileSync(join(src, 'scripts/server-desktop.sh'), `#!/bin/sh
if [ "$1" = --check ]; then
  echo 'desktop check' >> "$TEST_LOG"
  [ "\${TEST_DESKTOP_MISSING:-}" != 1 ] || { echo 'Missing Xvfb' >&2; exit 1; }
  exit 0
fi
printf '%s\\n' "$@" > "$TEST_LAUNCH_ARGS"
echo 'desktop launch' >> "$TEST_LOG"
exec "$@"
`, { mode: 0o755 })
    if (symlink) symlinkSync('/tmp', join(src, 'outside'))
    const tarball = join(stage, 'server.tar.gz')
    const tar = spawnSync('tar', ['-czf', tarball, '-C', stage, 'tucano-server'])
    assert.equal(tar.status, 0, tar.stderr.toString())
    writeFileSync(tarball + '.sha256', createHash('sha256').update(readFileSync(tarball)).digest('hex') + '  server.tar.gz\n')
    env.TUCANO_TARBALL = tarball
    return tarball
  }
  function run(args = [], overrides = {}) {
    const result = spawnSync('sh', [installer, ...args], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000 })
    assert.ifError(result.error)
    return { ...result, output: result.stdout + result.stderr }
  }
  function ok(args = [], overrides = {}) { const result = run(args, overrides); assert.equal(result.status, 0, result.output); return result.output }
  function bad(args = [], overrides = {}) { const result = run(args, overrides); assert.notEqual(result.status, 0, result.output); return result.output }
  pack()
  return { root, home, app, data, bin, unit, env, pack, run, ok, bad, calls: () => existsSync(env.TEST_LOG) ? readFileSync(env.TEST_LOG, 'utf8') : '' }
}

test('fresh install writes private user service and SSH pairing instructions', t => {
  const f = fixture(t)
  const output = f.ok(['--host', 'vps.example.com:2222', '--port', '7399'])
  assert.match(output, /Pairing code/)
  assert.match(output, /ssh=tucano-test%40vps.example.com%3A2222/)
  assert.match(output, /ssh -N -L 17337:127.0.0.1:7399 -p 2222 tucano-test@vps.example.com/)
  const unit = readFileSync(f.unit, 'utf8')
  assert.match(unit, /Restart=on-failure/)
  assert.match(unit, /UMask=0077/)
  assert.match(unit, /StandardOutput=null/)
  assert.equal(statSync(f.unit).mode & 0o077, 0)
  assert.match(f.calls(), /systemctl --user enable tucano.service/)
})

test('sudo target user cannot inherit runner XDG directories or session bus', t => {
  const f = fixture(t)
  const foreign = join(f.root, 'foreign-config')
  f.ok(['--no-pair'], { SUDO_UID: '2000', XDG_CONFIG_HOME: foreign, XDG_RUNTIME_DIR: '/run/user/2000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/2000/bus' })
  assert.ok(existsSync(f.unit))
  assert.ok(!existsSync(foreign))
})

test('native custom XDG config directory is honored', t => {
  const f = fixture(t), config = join(f.home, 'custom-config')
  f.ok(['--no-pair'], { XDG_CONFIG_HOME: config })
  assert.ok(existsSync(join(config, 'systemd/user/tucano.service')))
})

test('--no-service neither contacts systemd nor starts the server', t => {
  const f = fixture(t)
  f.ok(['--no-service', '--no-pair'])
  assert.equal(f.calls(), '')
  assert.ok(!existsSync(f.unit))
  assert.ok(!existsSync(f.data))
})

test('updates preserve port and device state without issuing codes; keep two releases', t => {
  const f = fixture(t)
  f.ok(['--no-service', '--port', '7399'])
  writeFileSync(join(f.data, 'device-state'), 'keep-token')
  f.pack('2.0.0')
  assert.doesNotMatch(f.ok(['--no-service']), /Pairing code/)
  assert.match(readFileSync(join(f.bin, 'tucano-server'), 'utf8'), /TUCANO_PORT='7399'/)
  f.pack('3.0.0'); f.ok(['--no-service'])
  assert.deepEqual(readdirSync(join(f.app, 'versions')).sort(), ['2.0.0', '3.0.0'])
  assert.equal(readFileSync(join(f.data, 'device-state'), 'utf8'), 'keep-token')
  assert.equal(readFileSync(join(f.data, 'pair-calls'), 'utf8'), 'pair\n')
})

test('same-version reinstall does not overwrite the active release', t => {
  const f = fixture(t)
  f.ok(['--no-service', '--no-pair'])
  const old = readlinkSync(join(f.app, 'current'))
  assert.match(f.ok(['--no-service']), /reinstalled/)
  assert.notEqual(readlinkSync(join(f.app, 'current')), old)
  assert.ok(existsSync(join(f.app, old, 'out/main/server.js')))
})

test('failed restart rolls back program, command and unit before reporting failure', t => {
  const f = fixture(t)
  f.ok(['--no-pair', '--port', '7399'])
  const target = readlinkSync(join(f.app, 'current'))
  const command = readFileSync(join(f.bin, 'tucano-server'), 'utf8')
  const unit = readFileSync(f.unit, 'utf8')
  f.pack('2.0.0')
  assert.match(f.bad(['--port', '7400'], { TEST_FAIL_RESTART: join(f.root, 'restart-failed') }), /restored the previous version/)
  assert.equal(readlinkSync(join(f.app, 'current')), target)
  assert.equal(readFileSync(join(f.bin, 'tucano-server'), 'utf8'), command)
  assert.equal(readFileSync(f.unit, 'utf8'), unit)
})

test('wrong checksum does not change an existing release', t => {
  const f = fixture(t)
  f.ok(['--no-service', '--no-pair'])
  const target = readlinkSync(join(f.app, 'current'))
  f.pack('2.0.0')
  assert.match(f.bad(['--no-service'], { TUCANO_SHA256: '0'.repeat(64) }), /checksum/)
  assert.equal(readlinkSync(join(f.app, 'current')), target)
})

test('unsafe versions, links, and paths are rejected', t => {
  const f = fixture(t)
  for (const version of ['.', '..', '../escape', 'bad\nversion']) {
    f.pack(version)
    assert.match(f.bad(['--no-service']), /Invalid version/)
  }
  f.pack('1.0.0', true)
  assert.match(f.bad(['--no-service']), /links or special files/)
  for (const path of ['relative', f.home + '/..', f.home + '/new\npath', f.home + '/bad%path']) {
    assert.notEqual(f.run(['--uninstall'], { TUCANO_HOME: path }).status, 0)
  }
})

test('direct HTTPS/Tailscale pairing forwards --url and does not print SSH instructions', t => {
  const f = fixture(t)
  for (const url of ['https://tucano.example.com', 'http://100.64.0.2:7337']) {
    const output = f.ok(['--no-service', '--pair', '--url', url], { SSH_CONNECTION: '1.2.3.4 1234 5.6.7.8 22' })
    assert.ok(output.includes('url=' + encodeURIComponent(url)))
    assert.ok(output.includes(url + '/?pair=AAAA-BBBB-CCCC'))
    assert.doesNotMatch(output, /ssh -N|opens the SSH tunnel/)
  }
  assert.match(f.bad(['--host', 'vps', '--url', 'https://example.com']), /not both/)
})

test('uninstall keeps data by default; explicit purge deletes only recognized data', t => {
  const f = fixture(t)
  f.ok(['--no-service'])
  f.ok(['--uninstall'])
  assert.ok(!existsSync(f.app))
  assert.ok(existsSync(f.data))
  f.ok(['--uninstall', '--purge'])
  assert.ok(!existsSync(f.data))
  mkdirSync(f.data); writeFileSync(join(f.data, 'unrelated'), 'keep')
  assert.match(f.ok(['--uninstall', '--purge']), /doesn't look like Tucano/)
  assert.ok(existsSync(join(f.data, 'unrelated')))
  assert.match(f.bad(['--purge']), /requires --uninstall/)
})

test('root, missing session and non-authenticated HTTP status cannot report healthy service', t => {
  const f = fixture(t)
  assert.match(f.bad([], { TEST_UID: '0' }), /not as root/)
  assert.match(f.bad([], { TEST_NO_SESSION: '1' }), /no systemd user session/)
  assert.match(f.bad([], { TEST_HTTP_CODE: '200' }), /didn't answer/)
})


test('service readiness honors a persistent private bind override', t => {
  const f = fixture(t)
  f.ok(['--no-pair'], { TEST_BIND_HOST: '100.64.0.2' })
  assert.match(f.calls(), /http:\/\/100\.64\.0\.2:7337\//)
})

test('uninstall does not remove code when the service cannot be stopped', t => {
  const f = fixture(t)
  f.ok(['--no-pair'])
  assert.match(f.bad(['--uninstall'], { TEST_FAIL_STOP: '1' }), /nothing was removed/)
  assert.ok(existsSync(join(f.app, 'current/out/main/server.js')))
  assert.ok(existsSync(f.unit))
})

test('uninstall refuses unrelated nonempty directories', t => {
  const f = fixture(t), unrelated = join(f.root, 'unrelated')
  mkdirSync(unrelated); writeFileSync(join(unrelated, 'important'), 'keep')
  assert.match(f.bad(['--uninstall'], { TUCANO_HOME: unrelated }), /unrecognized/)
  assert.ok(existsSync(join(unrelated, 'important')))
})


test('concurrent installer lock refuses install and uninstall without changes', t => {
  const f = fixture(t)
  f.ok(['--no-service', '--no-pair'])
  const target = readlinkSync(join(f.app, 'current'))
  mkdirSync(f.app + '.install-lock')
  assert.match(f.bad(['--no-service']), /Another installer may be running/)
  assert.match(f.bad(['--uninstall']), /Another installer may be running/)
  assert.equal(readlinkSync(join(f.app, 'current')), target)
})


test('desktop opt-in uses quoted launcher, Node and server arguments; CLI pairing stays headless', t => {
  const f = fixture(t)
  f.ok(['--desktop', '--no-pair'])
  const unit = readFileSync(f.unit, 'utf8')
  assert.ok(unit.includes(`ExecStart="${f.app}/current/scripts/server-desktop.sh" "${process.execPath}" "${f.app}/current/out/main/server.js"`))
  assert.match(unit, /Environment="TUCANO_SERVER_DESKTOP=1"/)
  assert.ok(unit.includes(`Environment="PATH=${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:`))
  assert.match(f.calls(), /desktop check/)
  assert.doesNotMatch(f.calls(), /desktop launch/)
  const argsFile = join(f.root, 'launch-args')
  const run = spawnSync(join(f.bin, 'tucano-server'), [], { env: { ...f.env, TEST_LAUNCH_ARGS: argsFile }, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(readFileSync(argsFile, 'utf8').trimEnd().split('\n'), [process.execPath, join(f.app, 'current/out/main/server.js')])
  const before = f.calls()
  const pair = spawnSync(join(f.bin, 'tucano-server'), ['pair', '--label', 'My Mac'], { env: f.env, encoding: 'utf8' })
  assert.equal(pair.status, 0, pair.stderr)
  assert.match(pair.stdout, /Pairing code/)
  assert.equal(f.calls(), before)
})

test('missing desktop prerequisite fails before replacing a working release or service', t => {
  const f = fixture(t)
  f.ok(['--no-pair'])
  const oldTarget = readlinkSync(join(f.app, 'current'))
  const oldUnit = readFileSync(f.unit, 'utf8')
  const oldCommand = readFileSync(join(f.bin, 'tucano-server'), 'utf8')
  const restarts = f.calls().split('systemctl --user restart').length
  f.pack('2.0.0')
  assert.match(f.bad(['--desktop'], { TEST_DESKTOP_MISSING: '1' }), /prerequisites are missing; the service was not changed/)
  assert.equal(readlinkSync(join(f.app, 'current')), oldTarget)
  assert.equal(readFileSync(f.unit, 'utf8'), oldUnit)
  assert.equal(readFileSync(join(f.bin, 'tucano-server'), 'utf8'), oldCommand)
  assert.equal(f.calls().split('systemctl --user restart').length, restarts)
})

test('desktop choice persists across update and --no-desktop explicitly turns it off', t => {
  const f = fixture(t)
  f.ok(['--desktop', '--no-pair'])
  f.pack('2.0.0'); f.ok([])
  assert.match(readFileSync(f.unit, 'utf8'), /Environment="TUCANO_SERVER_DESKTOP=1"/)
  assert.match(readFileSync(join(f.bin, 'tucano-server'), 'utf8'), /^# TUCANO_SERVER_DESKTOP=1$/m)
  f.pack('3.0.0'); f.ok(['--no-desktop'], { TEST_DESKTOP_MISSING: '1' })
  assert.match(readFileSync(f.unit, 'utf8'), /Environment="TUCANO_SERVER_DESKTOP=0"/)
  assert.doesNotMatch(readFileSync(f.unit, 'utf8'), /ExecStart=.*server-desktop/)
  f.pack('4.0.0'); f.ok([], { TEST_DESKTOP_MISSING: '1' })
  assert.match(readFileSync(f.unit, 'utf8'), /Environment="TUCANO_SERVER_DESKTOP=0"/)
})
