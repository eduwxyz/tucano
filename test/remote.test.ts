import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteClient, sshArgs, sshError, type RemoteState } from '../src/main/remote'
import { RemoteStore, type SavedRemote, type SecretStorage } from '../src/main/remote-store'

const profile: SavedRemote = { id: 'saved', name: 'VPS', reach: { via: 'url', url: 'https://vps.example.com' }, remotePort: 7337, server: 'server-id', device: { id: 'device-id', label: 'Mac', created: 1, seen: 1 }, days: 30 }
const token = 'private-device-token-12345678'
const dirs: string[] = []
const clients: RemoteClient[] = []
afterEach(() => { for (const c of clients.splice(0)) c.disconnect(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.useRealTimers() })
const storage = (): SecretStorage => ({ isEncryptionAvailable: () => true, encryptString: s => Buffer.from([...s].reverse().join('')), decryptString: b => [...b.toString()].reverse().join('') })
function file(): string { const dir = mkdtempSync(join(tmpdir(), 'tucano-remote-')); dirs.push(dir); return join(dir, 'remote.json') }
const identity = () => new Response(JSON.stringify({ server: profile.server, protocol: 1 }))
function fixture(fetcher: typeof fetch, timeoutMs = 1000) {
  const states: RemoteState[] = [], messages: unknown[] = []
  const client = new RemoteClient({ fetch: fetcher, timeoutMs, onState: s => states.push(s), onMessage: m => messages.push(m) }); clients.push(client)
  return { client, states, messages }
}
function stream(text = 'event: hello\ndata: client-123\n\n') {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; c.enqueue(new TextEncoder().encode(text)) } })
  return { response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }), push: (text: string) => controller.enqueue(new TextEncoder().encode(text)), close: () => controller.close() }
}

describe('secure saved remote tokens', () => {
  it('persists encrypted tokens, POSIX private mode, metadata-only list and safe whitelisted fields', () => {
    const path = file(), store = new RemoteStore(path, storage())
    store.put({ ...profile, token: 'injected-secret' } as SavedRemote, token)
    expect(readFileSync(path, 'utf8')).not.toContain(token)
    expect(readFileSync(path, 'utf8')).not.toContain('injected-secret')
    // Windows stat/chmod expose only writable/read-only bits, not per-user ACLs.
    // Ciphertext, token isolation and persistence assertions still run on every platform.
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(new RemoteStore(path, storage()).get(profile.id)).toEqual({ profile, token })
    expect(store.list()).toEqual([profile])
    store.remove(profile.id); expect(store.list()).toEqual([])
  })
  it('refuses unavailable or plaintext fallback storage without touching the file', () => {
    const path = file()
    for (const adapter of [{ ...storage(), isEncryptionAvailable: () => false }, ...(process.platform === 'linux' ? [{ ...storage(), getSelectedStorageBackend: () => 'basic_text' }, { ...storage(), getSelectedStorageBackend: () => 'unknown' }] : [])])
      expect(() => new RemoteStore(path, adapter).put(profile, token)).toThrow('Secure storage is unavailable')
    expect(() => readFileSync(path)).toThrow()
  })
  it('lists without keychain access and sanitizes decryption failures', () => {
    const path = file(); new RemoteStore(path, storage()).put(profile, token)
    const store = new RemoteStore(path, { ...storage(), decryptString: () => { throw new Error(token) } })
    expect(store.list()).toEqual([profile]); expect(() => store.get(profile.id)).toThrow('Cannot unlock this server token')
    try { store.get(profile.id) } catch (e) { expect(String(e)).not.toContain(token) }
  })
  it('isolates multiple VPS tokens and renames metadata without unlocking the keychain', () => {
    const path = file(), adapter = storage(), store = new RemoteStore(path, adapter)
    const other = { ...profile, id: 'second', name: 'Staging', server: 'other-server' }
    store.put(profile, token); store.put(other, 'second-private-device-token')
    expect(store.get(profile.id)?.token).toBe(token)
    expect(store.get(other.id)?.token).toBe('second-private-device-token')
    const locked = new RemoteStore(path, { ...adapter, isEncryptionAvailable: () => false, decryptString: () => { throw new Error('must not decrypt') } })
    locked.rename(other.id, '  Development  ')
    expect(locked.list().find(p => p.id === other.id)?.name).toBe('Development')
    expect(store.get(other.id)?.token).toBe('second-private-device-token')
    expect(store.get(profile.id)?.profile.name).toBe('VPS')
    for (const name of ['', '  ', 'a'.repeat(61), 'bad\nname', 'bad\u0000name']) expect(() => locked.rename(other.id, name)).toThrow('Server name')
    expect(() => locked.rename('missing', 'Valid')).toThrow('not found')
    store.remove(other.id); expect(store.get(profile.id)?.token).toBe(token)
  })
  it('retains legacy HTTP metadata without unlocking tokens or blocking safe profiles', async () => {
    const path = file(), adapter = storage(), store = new RemoteStore(path, adapter)
    store.put(profile, token)
    for (const [id, url] of [['legacy-ip', 'http://100.64.0.2:7337'], ['legacy-name', 'http://vps.tail1234.ts.net:7337'], ['legacy-v6', 'http://[fd7a:115c:a1e0::1]:7337']]) {
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      saved.entries.push({ profile: { ...profile, id, reach: { via: 'url', url } }, encrypted: adapter.encryptString('legacy-token').toString('base64') })
      writeFileSync(path, JSON.stringify(saved))
    }
    const decrypt = vi.fn(adapter.decryptString), loaded = new RemoteStore(path, { ...adapter, decryptString: decrypt })
    expect(loaded.list()).toHaveLength(4)
    expect(loaded.get(profile.id)?.token).toBe(token); decrypt.mockClear()
    const fetcher = vi.fn<typeof fetch>(), { client } = fixture(fetcher)
    for (const legacy of loaded.list().filter(p => p.id.startsWith('legacy'))) {
      expect(() => loaded.get(legacy.id)).toThrow('plaintext HTTP outside localhost')
      await expect(client.connect(legacy, 'legacy-token')).rejects.toThrow('Invalid server credentials')
    }
    expect(decrypt).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
    loaded.rename('legacy-ip', 'Old server')
    expect(loaded.list().find(p => p.id === 'legacy-ip')?.reach).toEqual({ via: 'url', url: 'http://100.64.0.2:7337' })
    loaded.remove('legacy-ip'); expect(loaded.get(profile.id)?.token).toBe(token)
    expect(loaded.list()).toHaveLength(3)
  })
  it('does not silently overwrite corrupt saved data', () => {
    const path = file(); writeFileSync(path, 'bad json')
    expect(() => new RemoteStore(path, storage()).put(profile, token)).toThrow('unreadable')
    expect(readFileSync(path, 'utf8')).toBe('bad json')
  })
})

describe('managed SSH transport', () => {
  it('uses loopback forwarding, strict host checks and no interactive passwords or shell/config execution', () => {
    const args = sshArgs({ via: 'ssh', host: 'vps.example.com', user: 'alice', port: 2222 }, 7337, 49152)
    expect(args).toContain('127.0.0.1:49152:127.0.0.1:7337')
    for (const option of ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'ForwardAgent=no', 'PasswordAuthentication=no', 'PermitLocalCommand=no', 'ProxyCommand=none', 'ExitOnForwardFailure=yes']) expect(args).toContain(option)
    expect(args.slice(-5)).toEqual(['-p', '2222', '-l', 'alice', 'vps.example.com'])
    expect(args).not.toContain(token)
  })
  it('rejects malformed addresses and injected options before spawn', () => {
    for (const host of ['-oProxyCommand=evil', 'x;touch /tmp/x', 'x\n-oFoo']) expect(() => sshArgs({ via: 'ssh', host, user: 'alice', port: 22 }, 7337, 40000)).toThrow()
    expect(() => sshArgs({ via: 'ssh', host: 'vps.example.com', user: '-root', port: 22 }, 7337, 40000)).toThrow()
  })
  it('returns actionable authentication/host-key errors without reflecting stderr secrets', () => {
    expect(sshError(`Host key verification failed ${token}`)).toContain('Verify the VPS fingerprint')
    expect(sshError(`Permission denied ${token}`)).toContain('ssh-agent')
    expect(sshError(token)).not.toContain(token)
  })
})

describe('remote message bridge', () => {
  it('pairs via POST, never places credentials in a URL, and keeps errors free of response bodies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ server: profile.server, device: profile.device, days: 30, token })))
    const { client, states } = fixture(fetcher)
    const result = await client.pair({ code: 'K7QM-2XPD-9TWH', reach: profile.reach, remotePort: 7337, name: 'VPS' })
    expect(result.token).toBe(token); expect(result.profile.device).toEqual(profile.device)
    expect(fetcher.mock.calls[0]![0]).toBe('https://vps.example.com/pair')
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
    expect(JSON.stringify(states)).not.toContain(token)
    fetcher.mockResolvedValue(new Response(`invalid ${token}`, { headers: { 'content-type': 'application/json' } }))
    await expect(client.pair({ code: 'K7QM-2XPD-9TWH', reach: profile.reach, remotePort: 7337, name: 'VPS' })).rejects.toThrow('Pairing failed.')
    expect(JSON.stringify(states)).not.toContain(token)
  })
  it('bridges SSE messages and RPC, authenticated assets, disconnect and explicit reconnect', async () => {
    const s = stream('event: hello\ndata: client-123\n\ndata: {"event":{"type":"settings"}}\n\n')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(identity()).mockResolvedValueOnce(s.response).mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response('asset'))
    const { client, states, messages } = fixture(fetcher)
    await client.connect(profile, token)
    expect(states.at(-1)).toEqual({ status: 'connected' }); expect(messages).toHaveLength(1)
    await client.send({ id: 1, method: 'snapshot', params: null })
    expect(fetcher.mock.calls[2]![0]).toBe('https://vps.example.com/rpc?c=client-123')
    expect(fetcher.mock.calls[2]![1]?.headers).toMatchObject({ authorization: `Bearer ${token}` })
    expect(await (await client.asset('/artifact/00000000-0000-0000-0000-000000000000/a.html')).text()).toBe('asset')
    await expect(client.asset('//evil.example.com')).rejects.toThrow('Invalid remote asset')
    client.disconnect(); await expect(client.send({ id: 2 })).rejects.toThrow('disconnected')
    fetcher.mockResolvedValueOnce(identity()).mockResolvedValueOnce(stream().response); await client.connect(profile, token)
    expect(states.at(-1)?.status).toBe('connected')
  })
  it('reports revoked tokens, network failures, stream drops and rejects RPC while disconnected', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(identity()).mockResolvedValueOnce(new Response(token, { status: 401 }))
    const { client, states } = fixture(fetcher)
    await expect(client.connect(profile, token)).rejects.toThrow('revoked')
    expect(states.at(-1)?.status).toBe('error'); expect(JSON.stringify(states)).not.toContain(token)
    const s = stream(); fetcher.mockResolvedValueOnce(identity()).mockResolvedValueOnce(s.response); await client.connect(profile, token); s.close()
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe('error'))
    await expect(client.send({ id: 1 })).rejects.toThrow('disconnected')
  })
  it('verifies server identity without sending a token, failing closed if the same address changes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(identity()).mockResolvedValueOnce(stream().response)
    const { client, states } = fixture(fetcher)
    await client.connect(profile, token)
    expect(fetcher.mock.calls[0]![0]).toBe('https://vps.example.com/identity')
    expect(fetcher.mock.calls[0]![1]?.headers).not.toHaveProperty('authorization')
    expect(fetcher.mock.calls[1]![1]?.headers).toMatchObject({ authorization: `Bearer ${token}` })
    client.disconnect(); fetcher.mockClear()
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ server: 'different-server', protocol: 1 })))
    await expect(client.connect(profile, token)).rejects.toThrow('Server identity changed')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]![1]?.headers).not.toHaveProperty('authorization')
    expect(states.at(-1)?.status).toBe('error')
    await expect(client.asset('/artifact/00000000-0000-0000-0000-000000000000/a.html')).rejects.toThrow('disconnected')
  })
  it('refuses unknown identity protocols before bearer authentication', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ server: profile.server, protocol: 2 })))
    const { client } = fixture(fetcher)
    await expect(client.connect(profile, token)).rejects.toThrow('protocol is unsupported')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(token)
  })
  it('bounds an event stream without a hello handshake', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(identity()).mockResolvedValue(stream(': heartbeat\n\n').response)
    const { client, states } = fixture(fetcher, 30)
    await expect(client.connect(profile, token)).rejects.toThrow('timed out')
    expect(states.at(-1)?.status).toBe('error')
  })
  it('sanitizes fetch errors rather than reflecting credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(token))
    const { client, states } = fixture(fetcher)
    await expect(client.connect(profile, token)).rejects.toThrow('Cannot verify this server identity')
    expect(JSON.stringify(states)).not.toContain(token)
  })
})
