// Main-process transport: credentials never cross the renderer's MessagePort.
import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { formatPairLink, parsePairLink, type PairLink, type Reach } from '../shared/pairlink'
import { validProfile, validReach, type SavedRemote } from './remote-store'

export type RemoteState = { status: 'disconnected' | 'connecting' | 'connected' | 'error'; error?: string }
export type Tunnel = { origin: string; close(): void; onClose(listener: () => void): void }
type SshReach = Extract<Reach, { via: 'ssh' }>
export function sshArgs(reach: SshReach, remotePort: number, localPort: number): string[] {
  if (!validReach(reach) || ![remotePort, localPort].every(p => Number.isInteger(p) && p > 0 && p <= 65535)) throw new Error('Invalid SSH destination.')
  return ['-F', process.platform === 'win32' ? 'NUL' : '/dev/null', '-N', '-T', '-v',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-o', 'ForwardAgent=no', '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, '-p', String(reach.port), '-l', reach.user, reach.host]
}
export function sshError(stderr: string): string {
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr))
    return 'SSH host key is unknown or changed. Verify the VPS fingerprint with its provider, then connect once in Terminal with ssh before retrying. Tucano never accepts host keys automatically.'
  if (/permission denied|authentication failed/i.test(stderr))
    return 'SSH key authentication failed. Add your key to ssh-agent and authorize its public key on the VPS, then retry. Passwords are not stored or requested.'
  if (/address already in use|forwarding failed|cannot listen/i.test(stderr)) return 'SSH could not open its local tunnel. Retry the connection.'
  return 'SSH connection failed. Check the host, port, network and your SSH key in Terminal.'
}
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address !== 'string' ? address.port : 0
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}
export async function openSshTunnel(reach: SshReach, remotePort: number, signal?: AbortSignal): Promise<Tunnel> {
  const port = await freePort()
  if (signal?.aborted) throw new Error('Connection cancelled.')
  const child = spawn('ssh', sshArgs(reach, remotePort, port), { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, shell: false })
  let stderr = '', pendingLine = '', stopped = false, processExited = false, expectedListener = false, listenerReady = false
  const listeners = new Set<() => void>()
  const close = (): void => { if (!stopped) { stopped = true; child.kill(); } }
  child.stderr.on('data', chunk => {
    stderr = (stderr + String(chunk)).slice(-8192)
    pendingLine += String(chunk)
    let newline: number
    while ((newline = pendingLine.indexOf('\n')) >= 0) {
      const line = pendingLine.slice(0, newline).replace(/\r$/, '')
      pendingLine = pendingLine.slice(newline + 1)
      // OpenSSH prints 'Local forwarding listening' BEFORE bind/listen. Only the
      // subsequent channel_new diagnostic proves that this process owns a listener.
      // Accept old/new portable and Windows OpenSSH formats; unknown formats fail closed.
      if (line === `debug1: Local forwarding listening on 127.0.0.1 port ${port}.`) expectedListener = true
      else if (expectedListener && /^debug1: channel \d+: new (?:port-listener )?\[port listener\](?: \(inactive timeout: \d+(?:\.\d+)?\))?$/.test(line)) listenerReady = true
      else if (/^(?:bind |listen |debug1: Local forwarding listening)/.test(line)) expectedListener = false
    }
    if (pendingLine.length > 8192) pendingLine = ''
  })
  child.once('exit', () => { processExited = true })
  signal?.addEventListener('abort', close, { once: true })
  child.once('close', () => { stopped = true; signal?.removeEventListener('abort', close); for (const listener of listeners) listener() })
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (error?: Error): void => {
      if (done) return
      done = true; clearInterval(poll); clearTimeout(timeout)
      child.removeListener('error', failed); child.removeListener('exit', exited)
      if (error) { close(); reject(error) }
      else resolve({ origin: `http://127.0.0.1:${port}`, close, onClose: listener => { if (stopped) listener(); else listeners.add(listener) } })
    }
    const failed = (): void => finish(new Error('Cannot start SSH. Install the system OpenSSH client and retry.'))
    const exited = (): void => finish(new Error(signal?.aborted ? 'Connection cancelled.' : sshError(stderr)))
    child.once('error', failed); child.once('exit', exited)
    const poll = setInterval(() => {
      if (!listenerReady || stopped || processExited) return
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.setTimeout(200)
      socket.once('connect', () => { socket.destroy(); if (listenerReady && !stopped && !processExited && child.exitCode == null && child.signalCode == null) finish() })
      socket.once('error', () => socket.destroy()); socket.once('timeout', () => socket.destroy())
    }, 100)
    const timeout = setTimeout(() => finish(new Error('SSH tunnel readiness timed out. Check the network and use a supported OpenSSH client; try connecting in Terminal.')), 20_000)
  })
}

export class RemoteClient {
  private controller?: AbortController
  private tunnel?: Tunnel
  private origin = ''
  private token = ''
  private client = ''
  private generation = 0
  private readonly fetcher: typeof fetch
  constructor(private readonly options: {
    onState(state: RemoteState): void; onMessage(message: unknown): void
    fetch?: typeof fetch; openTunnel?: typeof openSshTunnel; timeoutMs?: number
  }) { this.fetcher = options.fetch ?? fetch }
  private state(state: RemoteState): void { this.options.onState(state) }
  disconnect(): void {
    this.generation++
    this.controller?.abort(); this.controller = undefined
    this.tunnel?.close(); this.tunnel = undefined
    this.origin = ''; this.token = ''; this.client = ''
    this.state({ status: 'disconnected' })
  }
  private fail(error: string, generation: number): void {
    if (generation !== this.generation) return
    this.disconnect(); this.state({ status: 'error', error })
  }
  private async destination(reach: Reach, port: number, signal: AbortSignal): Promise<string> {
    if (!validReach(reach)) throw new Error('Invalid server address.')
    if (reach.via === 'url') return reach.url
    const tunnel = await (this.options.openTunnel ?? openSshTunnel)(reach, port, signal)
    if (signal.aborted) { tunnel.close(); throw new Error('Connection cancelled.') }
    this.tunnel = tunnel
    return tunnel.origin
  }
  private async request(path: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
    if (!this.controller || this.controller.signal.aborted || !this.origin) throw new Error('Server is disconnected.')
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.options.timeoutMs ?? 20_000)])
    try {
      const res = await this.fetcher(`${this.origin}${path}`, { ...init, redirect: 'error', credentials: 'omit', signal,
        headers: { ...init.headers, ...(authenticated ? { authorization: `Bearer ${this.token}` } : {}) } })
      if (res.status === 401) throw new Error(authenticated ? 'Device token expired or was revoked. Pair this Mac again.' : path === '/identity' ? 'Server identity is unavailable. Update Tucano on the VPS before reconnecting.' : 'Pairing code is invalid or expired. Generate a new code on the VPS.')
      if (res.status === 429) throw new Error('Too many attempts. Wait a moment before trying again.')
      if (!res.ok) throw new Error(`Server request failed (${res.status}).`)
      return res
    } catch (error) {
      if (error instanceof Error && /^(Device token|Pairing code|Too many attempts|Server request failed|Server identity)/.test(error.message)) throw error
      throw new Error('Cannot reach the server securely. Check the address, network and TLS certificate, then retry.')
    }
  }
  async pair(link: PairLink, label = 'Tucano desktop'): Promise<{ profile: SavedRemote; token: string }> {
    // Revalidate even typed input: IPC callers are not a trust boundary.
    if (!link || !validReach(link.reach) || !Number.isInteger(link.remotePort) || link.remotePort < 1 || link.remotePort > 65535 || !parsePairLink(formatPairLink(link)).ok) throw new Error('Invalid pairing link.')
    this.disconnect(); const generation = this.generation
    this.controller = new AbortController(); this.state({ status: 'connecting' })
    try {
      const origin = await this.destination(link.reach, link.remotePort, this.controller.signal)
      if (generation !== this.generation) throw new Error('Connection cancelled.')
      this.origin = origin
      const response = await this.request('/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: link.code, label: label.slice(0, 60) }) }, false)
      const value = await response.json()
      const profile: SavedRemote = { id: randomUUID(), name: link.name, reach: link.reach, remotePort: link.remotePort, server: value.server, device: value.device, days: value.days }
      if (!validProfile(profile) || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{20,512}$/.test(value.token)) throw new Error('Invalid pairing response.')
      if (generation !== this.generation) throw new Error('Connection cancelled.')
      this.disconnect()
      return { profile, token: value.token }
    } catch (error) {
      const message = error instanceof Error && /^(Connection cancelled|Invalid pairing response|Pairing code|Too many attempts|Server request failed|Cannot reach|SSH |Cannot start SSH)/.test(error.message) ? error.message : 'Pairing failed. Check the server and generate a new code if needed.'
      this.fail(message, generation); throw new Error(message)
    }
  }
  async connect(profile: SavedRemote, token: string): Promise<void> {
    if (!validProfile(profile) || !token || /\s/.test(token)) throw new Error('Invalid server credentials.')
    this.disconnect(); const generation = this.generation
    this.controller = new AbortController(); this.state({ status: 'connecting' })
    try {
      const origin = await this.destination(profile.reach, profile.remotePort, this.controller.signal)
      if (generation !== this.generation) throw new Error('Connection cancelled.')
      this.origin = origin
      let identity: unknown
      try {
        const response = await this.request('/identity', { method: 'GET' }, false)
        identity = await response.json()
      } catch {
        throw new Error('Cannot verify this server identity. Check the connection and update the VPS server before reconnecting.')
      }
      if (!identity || typeof identity !== 'object' || !('protocol' in identity) || identity.protocol !== 1 || !('server' in identity) || typeof identity.server !== 'string')
        throw new Error('Server identity protocol is unsupported. Update the VPS server before reconnecting.')
      if (identity.server !== profile.server)
        throw new Error('Server identity changed. This address belongs to a different server or database. Verify the VPS and pair again; no device token was sent.')
      if (generation !== this.generation) throw new Error('Connection cancelled.')
      this.token = token
      // Stream lifetime has its own heartbeat deadline, not request()'s short total timeout.
      const controller = this.controller
      await new Promise<void>((resolve, reject) => {
        let hello = false
        let timer: ReturnType<typeof setTimeout>
        const expired = (): void => {
          reject(new Error('Server event stream timed out. Reconnect to try again.'))
          this.fail('Server event stream timed out. Reconnect to try again.', generation)
        }
        const heartbeat = (): void => { clearTimeout(timer); timer = setTimeout(expired, hello ? 60_000 : (this.options.timeoutMs ?? 20_000)) }
        heartbeat()
        this.tunnel?.onClose(() => { if (generation === this.generation) controller.abort() })
        void (async () => {
          const res = await this.fetcher(`${this.origin}/events`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal, redirect: 'error', credentials: 'omit' })
          if (res.status === 401) throw new Error('Device token expired or was revoked. Pair this Mac again.')
          if (!res.ok || !res.body || !res.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Server event stream is unavailable.')
          const reader = res.body.getReader(), decoder = new TextDecoder()
          let buffer = ''
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) throw new Error('Server disconnected. Reconnect to continue.')
              if (hello) heartbeat()
              buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
              if (buffer.length > 8 * 1024 * 1024) throw new Error('Server event is too large.')
              let boundary: number
              while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
                const lines = frame.split('\n'), event = lines.find(l => l.startsWith('event:'))?.slice(6).trim()
                const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
                if (!data) continue
                if (event === 'hello') {
                  if (hello || !/^[A-Za-z0-9-]{1,128}$/.test(data)) throw new Error('Invalid server handshake.')
                  if (generation !== this.generation) throw new Error('Connection cancelled.')
                  this.client = data; hello = true; heartbeat(); this.state({ status: 'connected' }); resolve()
                } else {
                  if (!hello) throw new Error('Missing server handshake.')
                  this.options.onMessage(JSON.parse(data))
                }
              }
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
        })().catch(error => {
          const message = error instanceof Error && /^(Device token|Server |Invalid server|Missing server)/.test(error.message) ? error.message : 'Server connection lost. Check the network and reconnect.'
          reject(new Error(message)); this.fail(message, generation)
        }).finally(() => clearTimeout(timer))
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Server connection failed.'
      this.fail(message, generation); throw new Error(message)
    }
  }
  async send(message: unknown): Promise<void> {
    if (!this.client) throw new Error('Server is disconnected.')
    const generation = this.generation
    try { await this.request(`/rpc?c=${encodeURIComponent(this.client)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) }) }
    catch (error) { const message = (error as Error).message; this.fail(message, generation); throw new Error(message) }
  }
  async asset(path: string): Promise<Response> {
    if (!this.client) throw new Error('Server is disconnected.')
    // Do not turn a renderer-supplied URL into a credential-bearing arbitrary fetch.
    if (!/^\/artifact\/[0-9a-f-]{36}\/[^/?#]+$/.test(path) || /%2f|%5c/i.test(path)) throw new Error('Invalid remote asset path.')
    let name: string
    try { name = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)) } catch { throw new Error('Invalid remote asset path.') }
    if (name === '.' || name === '..' || /[\/\\\u0000-\u001f]/.test(name)) throw new Error('Invalid remote asset path.')
    return this.request(path)
  }
}
