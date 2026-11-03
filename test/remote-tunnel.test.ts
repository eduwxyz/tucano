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
    const server = createServer(s => s.destroy()); servers.push(server); server.listen(port, '127.0.0.1')
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
