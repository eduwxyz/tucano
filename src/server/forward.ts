import { connect, createServer, type Server, type Socket } from 'node:net'

// A private address: a home or office network, or Tailscale's 100.64.0.0/10.
export const isPrivate = (host: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host)

// Passes ports of the server's own loopback through at another of its addresses,
// as plain TCP (pages, their scripts, websockets alike), and stops when told.
export class Forwarder {
  private servers = new Map<number, { server: Server; open: Set<Socket> }>()

  constructor(private host: string) {}

  set(ports: Set<number>): void {
    // A service that stopped: no new connections, and the open ones end too.
    for (const [p, f] of this.servers)
      if (!ports.has(p)) {
        f.server.close()
        for (const c of f.open) c.destroy()
        this.servers.delete(p)
      }
    for (const p of ports) {
      if (this.servers.has(p)) continue
      const open = new Set<Socket>()
      const server = createServer((client) => {
        const to = connect(p, '127.0.0.1')
        open.add(client)
        client.pipe(to).pipe(client)
        const end = (): void => (open.delete(client), client.destroy(), void to.destroy())
        client.on('close', end)
        client.on('error', end)
        to.on('close', end)
        to.on('error', end)
      })
      server.on('error', () => this.servers.get(p)?.server === server && this.servers.delete(p)) // taken: nothing to pass through
      server.listen(p, this.host)
      this.servers.set(p, { server, open })
    }
  }

  get ports(): number[] {
    return [...this.servers.keys()]
  }
}
