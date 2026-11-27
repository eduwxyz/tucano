// The map's push between pages, for a wiki too big to compare every page with every other.
// Pages are kept in a quadtree; a far group of them pushes as one, from its middle and with its
// whole count (Barnes–Hut). Same force as the exact sum (70 / distance², with the same floor),
// only grouped: a few thousand pages cost milliseconds instead of a frozen screen.

export type Point = { x: number; y: number; vx: number; vy: number }

// A cell pushes as one when its width is under THETA times its distance to the page.
const THETA2 = 1.44 // θ = 1.2, squared
// Pages on (nearly) the same spot stop splitting here and share a cell.
const MAX_DEPTH = 40

let cap = 0
let kid = new Int32Array(0) // 4 per cell: the cell's quadrants, -1 when empty
let leaf = new Int32Array(0) // the page of a cell holding exactly one, -1 when it holds none, -2 when it's split, -3 when it's a shared spot
let mass = new Float64Array(0)
let sumX = new Float64Array(0)
let sumY = new Float64Array(0)
let midX = new Float64Array(0)
let midY = new Float64Array(0)
let half = new Float64Array(0)
let used = 0
let stack = new Int32Array(0)

function grow(min: number): void {
  if (min <= cap) return
  const next = Math.max(min, cap * 2, 64)
  const copy = <T extends Int32Array | Float64Array>(a: T, size: number): T => {
    const b = new (a.constructor as new (n: number) => T)(size)
    b.set(a as never)
    return b
  }
  kid = copy(kid, next * 4)
  leaf = copy(leaf, next)
  mass = copy(mass, next)
  sumX = copy(sumX, next)
  sumY = copy(sumY, next)
  midX = copy(midX, next)
  midY = copy(midY, next)
  half = copy(half, next)
  cap = next
}

function cell(x: number, y: number, h: number): number {
  if (used >= cap) grow(used + 1)
  const c = used++
  kid.fill(-1, c * 4, c * 4 + 4)
  leaf[c] = -1
  mass[c] = 0
  sumX[c] = 0
  sumY[c] = 0
  midX[c] = x
  midY[c] = y
  half[c] = h
  return c
}

function child(c: number, q: number): number {
  const h = half[c]! / 2
  const k = cell(midX[c]! + (q & 1 ? h : -h), midY[c]! + (q & 2 ? h : -h), h)
  kid[c * 4 + q] = k
  return k
}

const quadrant = (c: number, x: number, y: number): number => (x >= midX[c]! ? 1 : 0) | (y >= midY[c]! ? 2 : 0)

function insert(points: readonly Point[], i: number): void {
  const p = points[i]!
  let c = 0
  for (let depth = 0; ; depth++) {
    const was = mass[c]!
    mass[c] = was + 1
    sumX[c] = sumX[c]! + p.x
    sumY[c] = sumY[c]! + p.y
    if (was === 0) {
      leaf[c] = i
      return
    }
    if (leaf[c] === -3) return
    if (leaf[c]! >= 0) {
      if (depth >= MAX_DEPTH) {
        leaf[c] = -3
        return
      }
      // the page already here moves one level down, then this one finds its own quadrant
      const j = leaf[c]!
      const o = points[j]!
      const k = child(c, quadrant(c, o.x, o.y))
      mass[k] = 1
      sumX[k] = o.x
      sumY[k] = o.y
      leaf[k] = j
      leaf[c] = -2
    }
    const q = quadrant(c, p.x, p.y)
    const next = kid[c * 4 + q]!
    if (next < 0) {
      const k = child(c, q)
      mass[k] = 1
      sumX[k] = p.x
      sumY[k] = p.y
      leaf[k] = i
      return
    }
    c = next
  }
}

// Adds to each point's velocity the push of every other, the far ones grouped.
export function repelGrouped(points: readonly Point[]): void {
  const n = points.length
  if (n < 2) return
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of points) {
    if (p.x < x0) x0 = p.x
    if (p.x > x1) x1 = p.x
    if (p.y < y0) y0 = p.y
    if (p.y > y1) y1 = p.y
  }
  used = 0
  grow(n * 2 + 1)
  cell((x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0, 1) / 2 + 1)
  for (let i = 0; i < n; i++) insert(points, i)
  if (stack.length < used * 4) stack = new Int32Array(used * 4)

  for (let i = 0; i < n; i++) {
    const p = points[i]!
    let fx = 0
    let fy = 0
    let top = 0
    stack[top++] = 0
    while (top) {
      const c = stack[--top]!
      const m = mass[c]!
      if (!m || leaf[c] === i) continue
      const dx = p.x - sumX[c]! / m
      const dy = p.y - sumY[c]! / m
      const d2 = dx * dx + dy * dy
      const h = half[c]!
      const inside = Math.abs(p.x - midX[c]!) <= h && Math.abs(p.y - midY[c]!) <= h
      if (leaf[c] !== -2 || (!inside && 4 * h * h < THETA2 * d2)) {
        const f = (70 * m) / Math.max(d2, 30)
        fx += dx * f
        fy += dy * f
        continue
      }
      for (let q = 0; q < 4; q++) {
        const k = kid[c * 4 + q]!
        if (k >= 0) stack[top++] = k
      }
    }
    p.vx += fx
    p.vy += fy
  }
}
