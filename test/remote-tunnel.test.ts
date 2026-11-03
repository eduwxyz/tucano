import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createServer, type Server } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }))
import { openSshTunnel } from '../src/main/remote'

const servers: Server[] = []
afterEach(async () => {
  mocked.spawn.mockReset()
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))))
})
function processFixture() {
  const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill: vi.fn(() => { child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); return true }) })
  return child
}
const reach = { via: 'ssh' as const, host: 'vps.example.com', user: 'alice', port: 22 }
it('owns the SSH process, binds only loopback, and terminates the tunnel on disconnect', async () => {
  const child = processFixture()
  mocked.spawn.mockImplementation((_exe, args) => {
    const forward = args[args.indexOf('-L') + 1]
    const port = Number(forward.split(':')[1])
    const server = createServer(s => s.destroy()); servers.push(server); server.listen(port, '127.0.0.1', () => child.stderr.write(`debug1: Local forwarding listening on 127.0.0.1 port ${port}.\r\ndebug1: channel 0: new port-listener [port listener] (inactive timeout: 0)\r\n`))
    return child
  })
  const tunnel = await openSshTunnel(reach, 7337)
  expect(tunnel.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(mocked.spawn.mock.calls[0]![2]).toMatchObject({ shell: false, windowsHide: true })
  const closed = vi.fn(); tunnel.onClose(closed); tunnel.close(); tunnel.close()
  expect(child.kill).toHaveBeenCalledTimes(1); expect(closed).toHaveBeenCalledTimes(1)
})
it('reports host-key failure without raw stderr and stops a failed child', async () => {
  const child = processFixture()
  mocked.spawn.mockImplementation(() => {
    setTimeout(() => { child.stderr.write('Host key verification failed. PRIVATE_SECRET'); child.emit('exit', 255) }, 10)
    return child
  })
  await expect(openSshTunnel(reach, 7337)).rejects.toThrow('Verify the VPS fingerprint')
  expect(child.kill).toHaveBeenCalled()
})
it('cancels a pending SSH startup and kills its child', async () => {
  const child = processFixture(); mocked.spawn.mockReturnValue(child)
  const controller = new AbortController(), pending = openSshTunnel(reach, 7337, controller.signal)
  await vi.waitFor(() => expect(mocked.spawn).toHaveBeenCalled())
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  expect(child.kill).toHaveBeenCalledTimes(1)
})

it('does not consider an accepting TCP port ready without the SSH post-listen diagnostic', async () => {
  const child = processFixture(), controller = new AbortController()
  let port = 0
  mocked.spawn.mockImplementation((_exe, args) => {
    port = Number(args[args.indexOf('-L') + 1].split(':')[1])
    const server = createServer(s => s.destroy()); servers.push(server); server.listen(port, '127.0.0.1')
    return child
  })
  let resolved = false
  const pending = openSshTunnel(reach, 7337, controller.signal).then(tunnel => { resolved = true; return tunnel })
  const failure = expect(pending).rejects.toThrow('cancelled')
  await vi.waitFor(() => expect(mocked.spawn).toHaveBeenCalled())
  // This diagnostic is pre-bind in OpenSSH; it is not enough by itself.
  child.stderr.write(`debug1: Local forwarding listening on 127.0.0.1 port ${port}.\n`)
  await new Promise(resolve => setTimeout(resolve, 250))
  expect(resolved).toBe(false)
  controller.abort(); await failure
})
it('requires the matching port and supports chunked older OpenSSH readiness output', async () => {
  const child = processFixture()
  let port = 0
  mocked.spawn.mockImplementation((_exe, args) => {
    port = Number(args[args.indexOf('-L') + 1].split(':')[1])
    const server = createServer(s => s.destroy()); servers.push(server); server.listen(port, '127.0.0.1')
    return child
  })
  let resolved = false
  const pending = openSshTunnel(reach, 7337).then(tunnel => { resolved = true; return tunnel })
  await vi.waitFor(() => expect(mocked.spawn).toHaveBeenCalled())
  child.stderr.write('debug1: Local forwarding listening on 127.0.0.1 port 1.\ndebug1: channel 0: new [port listener]\n')
  await new Promise(resolve => setTimeout(resolve, 150)); expect(resolved).toBe(false)
  child.stderr.write(`debug1: Local forwarding listening on 127.0.0.1 port ${port}.\ndebug1: channel 0: new [port lis`)
  await new Promise(resolve => setTimeout(resolve, 150)); expect(resolved).toBe(false)
  child.stderr.write('tener]\n')
  const tunnel = await pending; tunnel.close()
})
it('rejects an SSH process exiting before readiness despite an accepting TCP port', async () => {
  const child = processFixture()
  mocked.spawn.mockImplementation((_exe, args) => {
    const port = Number(args[args.indexOf('-L') + 1].split(':')[1])
    const server = createServer(s => s.destroy()); servers.push(server)
    server.listen(port, '127.0.0.1', () => {
      child.stderr.write(`debug1: Local forwarding listening on 127.0.0.1 port ${port}.\ndebug1: channel 0: new [port listener]\n`)
      child.emit('exit', 255)
    })
    return child
  })
  await expect(openSshTunnel(reach, 7337)).rejects.toThrow('SSH connection failed')
})
