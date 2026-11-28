// Which IP addresses belong to the machine or its inside network. The core uses this before it
// fetches a link someone typed (src/core/safe-fetch.ts); the window uses the same rule when a person
// gives a workspace an image address, so an image cannot point into the server's own network.
// One home for the rule: changing what counts as inside changes both places together.

// An IPv4 address as a number, or undefined.
function v4(ip: string): number | undefined {
  const p = ip.split('.')
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return undefined
  return p.reduce((n, x) => n * 256 + Number(x), 0)
}

// An IPv6 address as its eight 16-bit groups (a trailing dotted IPv4 included), or undefined.
function v6(ip: string): number[] | undefined {
  let s = ip
    .replace(/^\[|\]$/g, '')
    .split('%')[0]!
    .toLowerCase()
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (dotted) {
    const n = v4(dotted[1]!)
    if (n === undefined) return undefined
    s = s.slice(0, -dotted[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return undefined
  const part = (h: string): number[] => (h ? h.split(':').map((g) => parseInt(g, 16)) : [])
  const head = part(halves[0]!)
  const tail = halves.length === 2 ? part(halves[1]!) : []
  const fill = 8 - head.length - tail.length
  if ((halves.length === 2 ? fill < 0 : fill !== 0) || [...head, ...tail].some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return undefined
  return [...head, ...Array(Math.max(0, fill)).fill(0), ...tail]
}

const inV4 = (n: number, base: string, bits: number): boolean => {
  const b = v4(base)!
  const size = 2 ** (32 - bits)
  return Math.floor(n / size) === Math.floor(b / size)
}

const V4_INSIDE: [string, number][] = [
  ['0.0.0.0', 8], // "this network", 0.0.0.0 reaches loopback
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT (and Tailscale)
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, the cloud's metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved, broadcast
]

// Whether an address is of the inside (this machine, its networks, the cloud's metadata).
// Anything that isn't a plain IP is refused too.
export function blockedAddress(ip: string): boolean {
  const n4 = v4(ip)
  if (n4 !== undefined) return V4_INSIDE.some(([b, bits]) => inV4(n4, b, bits))
  const g = v6(ip)
  if (!g) return true
  const embedded = (hi: number, lo: number): boolean => blockedAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  if (g.slice(0, 6).every((x) => x === 0)) return true // ::, ::1, and the old IPv4-compatible ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6]!, g[7]!) // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6]!, g[7]!) // NAT64
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!) // 6to4
  if ((g[0]! & 0xffc0) === 0xfe80) return true // link-local
  if ((g[0]! & 0xfe00) === 0xfc00) return true // unique local (fd00::/8, the cloud's fd00::ec2::254)
  if ((g[0]! & 0xff00) === 0xff00) return true // multicast
  return false
}
