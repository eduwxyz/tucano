// Opt-in integration tests: the desktop's actual transport talks to a separately built Node server.
// npm run build && TUCANO_REMOTE_E2E=1 npx vitest run test/remote-live.test.ts
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto'
import { RemoteClient, type RemoteState } from '../src/main/remote'
import { RemoteStore, type SecretStorage } from '../src/main/remote-store'
import { parsePairLink, type PairLink } from '../src/shared/pairlink'
import type { Wire, Snapshot } from '../src/shared/rpc'

const enabled = process.env.TUCANO_REMOTE_E2E === '1'
const entry = resolve('out/main/server.js')
const cleanup: Array<() => void | Promise<void>> = []
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate: () => boolean, description: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`)
    await delay(25)
  }
}
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('No loopback port'))
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try { await until(() => child.exitCode !== null || child.signalCode !== null, 'child shutdown', 5_000) }
  catch { child.kill('SIGKILL'); await until(() => child.exitCode !== null || child.signalCode !== null, 'forced child shutdown') }
}
function fixtureDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
async function serverFixture() {
  if (!existsSync(entry)) throw new Error('Build first: npm run build')
  const dir = fixtureDir('tucano-remote-live-'), port = await freePort()
  const env = { ...process.env, TUCANO_DATA: dir, TUCANO_HOST: '127.0.0.1', TUCANO_PORT: String(port), TUCANO_TOKEN: '' }
  let child: ChildProcess, output = ''
  const start = async () => {
    const startAt = output.length
    child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const startedChild = child
    cleanup.push(() => stop(startedChild))
    child.stdout!.on('data', chunk => { output += String(chunk) })
    child.stderr!.on('data', chunk => { output += String(chunk) })
    await until(() => {
      if (child.exitCode !== null) throw new Error('Fixture server exited before listening')
      return output.slice(startAt).includes('Listening on this machine only')
    }, 'server readiness', 30_000)
  }
  await start()
  const origin = `http://127.0.0.1:${port}`
  const command = (...args: string[]) => {
    const result = spawnSync(process.execPath, [entry, ...args], { env, encoding: 'utf8', timeout: 15_000 })
    expect(result.status, `server CLI ${args[0]}`).toBe(0)
    output += result.stdout + result.stderr
    return result.stdout
  }
  const pairLink = (ssh?: string): PairLink => {
    const text = command('pair', '--label', 'Live test Mac', ...(ssh ? ['--ssh', ssh] : ['--url', origin]))
    const link = /tucano:\/\/pair\?\S+/.exec(text)?.[0]
    expect(link).toBeTruthy()
    const parsed = parsePairLink(link!)
    if (!parsed.ok) throw new Error(parsed.error)
    return parsed.link
  }
  return { dir, port, origin, command, pairLink, log: () => output,
    restart: async () => { await stop(child); await start() },
    ownerToken: () => readFileSync(join(dir, 'server-token'), 'utf8').trim() }
}
function clientFixture(openTunnel?: ConstructorParameters<typeof RemoteClient>[0]['openTunnel']) {
  const messages: Wire[] = [], states: RemoteState[] = []
  const client = new RemoteClient({ onMessage: message => messages.push(message as Wire), onState: state => states.push(state), openTunnel, timeoutMs: 5_000 })
  cleanup.push(() => client.disconnect())
  let id = 0
  const rpc = async (method: string, params: unknown = {}) => {
    const requestId = ++id
    await client.send({ id: requestId, method, params })
    await until(() => messages.some(message => 'id' in message && message.id === requestId), `RPC ${method}`)
    const response = messages.find(message => 'id' in message && message.id === requestId)!
    if (!('id' in response)) throw new Error('Missing RPC response')
    expect(response.error).toBeUndefined()
    return response.result
  }
  return { client, messages, states, rpc }
}
// Stand-in only for the OS keychain, with actual authenticated encryption and a fixture-only key.
// Electron safeStorage and macOS Keychain are deliberately not claimed by this Node test.
function fixtureSecrets(): SecretStorage {
  const key = randomBytes(32)
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), data])
    },
    decryptString: data => {
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
      cipher.setAuthTag(data.subarray(12, 28))
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8')
    }
  }
}
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

describe.skipIf(!enabled)('desktop RemoteClient against the real built server', () => {
  it('pairs once, carries RPC/events/assets, persists across restart, isolates servers and revokes tokens', async () => {
    const server = await serverFixture(), other = await serverFixture()
    const { client, rpc, messages, states } = clientFixture()
    const link = server.pairLink()
    const paired = await client.pair(link)
    expect(paired.profile.device.label).toBe('Live test Mac')
    expect(paired.token.startsWith('tk_')).toBe(true)
    await expect(client.pair(link)).rejects.toThrow(/invalid|expired/i)
    await client.connect(paired.profile, paired.token)
    expect(states.at(-1)?.status).toBe('connected')
    expect((await rpc('snapshot') as Snapshot).conversations).toBeInstanceOf(Array)
    const channel = await rpc('createChannel', { name: 'remote-live-proof' })
    await until(() => messages.some(message => 'event' in message && message.event.type === 'conversation' && message.event.conversation.id === channel), 'conversation SSE event')
    const artifactId = randomUUID(), artifactDir = join(server.dir, 'artifacts', artifactId)
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, 'proof.txt'), 'authenticated remote artifact')
    const path = `/artifact/${artifactId}/proof.txt`
    expect((await fetch(server.origin + path)).status).toBe(401)
    expect(await (await client.asset(path)).text()).toBe('authenticated remote artifact')
    await expect(client.asset('https://example.com/steal')).rejects.toThrow(/Invalid/)
    const secrets = fixtureSecrets(), savedFile = join(fixtureDir('tucano-client-store-'), 'remotes.json')
    new RemoteStore(savedFile, secrets).put(paired.profile, paired.token)
    expect(readFileSync(savedFile, 'utf8')).not.toContain(paired.token)
    await server.restart()
    await until(() => states.at(-1)?.status === 'error', 'lost server stream detected')
    const restored = new RemoteStore(savedFile, secrets).get(paired.profile.id)!
    expect(restored.profile).toEqual(paired.profile)
    await client.connect(restored.profile, restored.token)
    expect((await rpc('snapshot') as Snapshot).conversations.some(conversation => conversation.id === channel)).toBe(true)
    expect(await (await client.asset(path)).text()).toBe('authenticated remote artifact')
    const foreign = clientFixture().client
    await expect(foreign.connect({ ...paired.profile, reach: { via: 'url', url: other.origin } }, paired.token)).rejects.toThrow(/identity changed/i)
    server.command('revoke', paired.profile.device.id)
    await expect(client.send({ id: 99, method: 'snapshot', params: {} })).rejects.toThrow(/revoked|expired/i)
    await expect(client.connect(restored.profile, restored.token)).rejects.toThrow(/revoked|expired/i)
    expect(states.at(-1)?.status).toBe('error')
    expect(server.log()).not.toContain(paired.token)
    expect(server.log()).not.toContain(server.ownerToken())
    expect(JSON.stringify(states)).not.toContain(paired.token)
    expect(JSON.stringify(messages)).not.toContain(paired.token)
  }, 90_000)
})

// No system SSH config, authorized_keys, known_hosts or SSH agent is changed. The wrapper adds
// only fixture identity/known-hosts files; all tunnel options and lifecycle run through production code.
describe.skipIf(!enabled || process.platform === 'win32' || process.env.TUCANO_REMOTE_SSH_E2E !== '1')('real OpenSSH transport', () => {
  it('pairs and exchanges RPC through a loopback SSH daemon with verified ephemeral host keys', async (context) => {
    const sshd = ['/usr/sbin/sshd', '/usr/local/sbin/sshd'].find(existsSync)
    if (!sshd || !existsSync('/usr/bin/ssh')) {
      if (process.env.TUCANO_REMOTE_SSH_E2E === '1') throw new Error('Required SSH integration tools are missing')
      context.skip('Install OpenSSH server/client or set TUCANO_REMOTE_SSH_E2E=1 to require them')
      return
    }
    const dir = fixtureDir('tucano-ssh-live-'), port = await freePort()
    for (const name of ['host', 'identity']) {
      const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, name)], { encoding: 'utf8' })
      expect(result.status, 'create ephemeral SSH fixture key').toBe(0)
    }
    writeFileSync(join(dir, 'authorized_keys'), readFileSync(join(dir, 'identity.pub')))
    const hostPublic = readFileSync(join(dir, 'host.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')
    writeFileSync(join(dir, 'known_hosts'), `[127.0.0.1]:${port} ${hostPublic}\n`)
    const config = [
      `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'host')}`,
      `PidFile ${join(dir, 'pid')}`, `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
      'StrictModes no', 'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
      'PubkeyAuthentication yes', 'PermitRootLogin prohibit-password', 'AllowTcpForwarding local',
      'GatewayPorts no', 'PermitTTY no', 'X11Forwarding no', `AllowUsers ${userInfo().username}`
    ].join('\n') + '\n'
    writeFileSync(join(dir, 'sshd_config'), config)
    const check = spawnSync(sshd, ['-t', '-f', join(dir, 'sshd_config')], { encoding: 'utf8' })
    expect(check.status, `isolated sshd configuration: ${check.stderr}`).toBe(0)
    const daemon = spawn(sshd, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] })
    let daemonLog = ''
    daemon.stderr!.on('data', chunk => { daemonLog += String(chunk) })
    cleanup.push(() => stop(daemon))
    await until(() => {
      if (daemon.exitCode !== null) throw new Error(`Fixture sshd exited: ${daemonLog}`)
      return daemonLog.includes('Server listening on')
    }, 'isolated SSH daemon readiness')
    const bin = join(dir, 'bin'); mkdirSync(bin)
    // Absolute paths are generated by mkdtemp, never user-controlled shell input.
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -i ${quote(join(dir, 'identity'))} -o IdentitiesOnly=yes -o UserKnownHostsFile=${quote(join(dir, 'known_hosts'))} -o GlobalKnownHostsFile=/dev/null "$@"\n`)
    chmodSync(join(bin, 'ssh'), 0o700)
    const oldPath = process.env.PATH
    process.env.PATH = `${bin}:${oldPath ?? ''}`
    cleanup.push(() => { process.env.PATH = oldPath })
    const server = await serverFixture()
    const { client, rpc, states } = clientFixture()
    const paired = await client.pair(server.pairLink(`${userInfo().username}@127.0.0.1:${port}`))
    expect(paired.profile.reach.via).toBe('ssh')
    await client.connect(paired.profile, paired.token)
    expect(states.at(-1)?.status).toBe('connected')
    const channel = await rpc('createChannel', { name: 'ssh-live-proof' })
    expect((await rpc('snapshot') as Snapshot).conversations.some(conversation => conversation.id === channel)).toBe(true)
    client.disconnect()
    // A known-host mismatch must be a hard failure, not auto-accepted or downgraded.
    const wrongKey = readFileSync(join(dir, 'identity.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')
    writeFileSync(join(dir, 'known_hosts'), `[127.0.0.1]:${port} ${wrongKey}\n`)
    await expect(client.connect(paired.profile, paired.token)).rejects.toThrow(/host key/i)
    expect(server.log()).not.toContain(paired.token)
    expect(daemonLog).not.toContain(paired.token)
  }, 90_000)
})
