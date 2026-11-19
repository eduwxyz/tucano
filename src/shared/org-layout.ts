// Where each card of the organogram goes, and the lines between them (src/shared/org.ts has the tree).
// Me at the top; a level that goes on spreads sideways; those with no one below stack under their
// boss, so a wide team stays readable. Everything in the same units (px before any zoom), top-left
// corners, so the cards and the lines are drawn from one source and never drift apart.
import type { OrgNode } from './org'

export const ME = 'me'

export interface OrgSizes {
  w: number // a card
  h: number
  gapX: number // between side-by-side branches
  gapY: number // between a card and the row below it
  stackGap: number // between stacked cards
  indent: number // how far a stack sits to the right of its boss's left edge
  r: number // the corner of a line
  rootGap?: number // between the trees at the top (each a sector, with its zone around it); unset: gapX
  rootDrop?: number // more room between me and the tops, for the top of their zones; unset: none
}
export const ORG_SIZES: OrgSizes = { w: 220, h: 72, gapX: 28, gapY: 48, stackGap: 12, indent: 34, r: 10 }

export interface Placed {
  id: string
  x: number
  y: number
}
export interface OrgEdge {
  from: string
  to: string
  d: string // an SVG path, from the boss down to the one below
}
export interface OrgLayout {
  nodes: Placed[]
  edges: OrgEdge[]
  width: number
  height: number
}

// `pile: false` spreads every level sideways (the board, whose lines leave a card from below).
// `over`: the entry points. Sectors hang from me and from them: those branches get rootGap and rootDrop.
export function layoutOrg<T extends { id: string }>(roots: OrgNode<T>[], s: OrgSizes = ORG_SIZES, pile = true, over: string[] = []): OrgLayout {
  const sectorsUnder = (id: string): boolean => id === ME || over.includes(id)
  const gapUnder = (id: string): number => (sectorsUnder(id) ? s.rootGap ?? s.gapX : s.gapX)
  const stacked = (n: OrgNode<T>): boolean => pile && n.kids.length > 0 && n.kids.every((k) => k.kids.length === 0)
  const nodes: Placed[] = []
  const edges: OrgEdge[] = []
  const size = (n: OrgNode<T>): { w: number; h: number } => {
    if (!n.kids.length) return { w: s.w, h: s.h }
    if (stacked(n)) return { w: s.indent + s.w, h: s.h + n.kids.length * (s.h + s.stackGap) }
    const kids = n.kids.map(size)
    return { w: Math.max(s.w, kids.reduce((a, k) => a + k.w, 0) + gapUnder(n.agent.id) * (kids.length - 1)), h: s.h + s.gapY + Math.max(...kids.map((k) => k.h)) }
  }
  // Down from (x1, y1), across at `mid`, down to (x2, y2), with rounded corners.
  const elbow = (x1: number, y1: number, x2: number, y2: number, mid: number): string => {
    const dx = x2 - x1
    if (Math.abs(dx) < 1) return `M${x1} ${y1}V${y2}`
    const r = Math.min(s.r, Math.abs(dx) / 2, mid - y1, y2 - mid)
    const dir = Math.sign(dx)
    return `M${x1} ${y1}V${mid - r}Q${x1} ${mid} ${x1 + dir * r} ${mid}H${x2 - dir * r}Q${x2} ${mid} ${x2} ${mid + r}V${y2}`
  }
  // Places the branch in the box starting at (x, y); returns the middle of its own card, for the line from above.
  const place = (id: string, kids: OrgNode<T>[], pile: boolean, x: number, y: number, width: number): number => {
    const gap = gapUnder(id)
    if (!kids.length) {
      nodes.push({ id, x, y })
      return x + s.w / 2
    }
    if (pile) {
      nodes.push({ id, x, y })
      const spine = x + s.indent / 2
      kids.forEach((k, i) => {
        const ky = y + s.h + s.stackGap + i * (s.h + s.stackGap)
        nodes.push({ id: k.agent.id, x: x + s.indent, y: ky })
        const cy = ky + s.h / 2
        edges.push({ from: id, to: k.agent.id, d: `M${spine} ${y + s.h}V${cy - s.r}Q${spine} ${cy} ${spine + s.r} ${cy}H${x + s.indent}` })
      })
      return x + s.w / 2
    }
    const sizes = kids.map(size)
    const total = sizes.reduce((a, k) => a + k.w, 0) + gap * (kids.length - 1)
    const ky = y + s.h + s.gapY + (sectorsUnder(id) ? s.rootDrop ?? 0 : 0)
    let kx = x + (width - total) / 2
    const anchors = kids.map((k, i) => {
      const at = place(k.agent.id, k.kids, stacked(k), kx, ky, sizes[i]!.w)
      kx += sizes[i]!.w + gap
      return at
    })
    const cx = (anchors[0]! + anchors.at(-1)!) / 2
    nodes.push({ id, x: cx - s.w / 2, y })
    anchors.forEach((at, i) => edges.push({ from: id, to: kids[i]!.agent.id, d: elbow(cx, y + s.h, at, ky, y + s.h + (ky - y - s.h) / 2) }))
    return cx
  }
  const sizes = roots.map(size)
  const width = Math.max(s.w, sizes.reduce((a, k) => a + k.w, 0) + gapUnder(ME) * Math.max(0, roots.length - 1))
  place(ME, roots, false, 0, 0, width)
  // A lone card sits in the middle of nothing; with roots, its place came from theirs.
  const left = Math.min(...nodes.map((n) => n.x))
  if (left < 0) for (const n of nodes) n.x -= left
  const height = Math.max(...nodes.map((n) => n.y)) + s.h
  return { nodes, edges, width: Math.max(...nodes.map((n) => n.x)) + s.w, height }
}

// The lines a piece of handed work travels: from whoever asked down to whoever does it, by way of everyone between.
export function pathBetween(bossOfId: (id: string) => string | undefined, from: string, to: string): [string, string][] {
  const hops: [string, string][] = []
  const seen = new Set<string>()
  for (let at = to; at !== from && !seen.has(at); ) {
    seen.add(at)
    const boss = bossOfId(at)
    if (!boss) return [] // not below `from` any more: the tree changed since
    hops.unshift([boss, at])
    at = boss
  }
  return hops
}

// ---------- the board: cards anywhere, a view that pans and zooms ----------
// What a sector's zone keeps around its cards, at the sides (OrgSectors.tsx draws it), above its head
// (where its chip is) and below.
export const ZONE_PAD = 32
export const ZONE_TOP = 68
export const ZONE_BOTTOM = 32
// The shape the tidy board leans to, when the sectors don't fit one row: about a screen's.
export const BOARD_RATIO = 4 / 3
// Two sectors side by side stay a branch's gap apart once each has its zone around it: the zones never overlap.
// And I sit clear of the top of the zones, where each sector's name is.
export const BOARD: OrgSizes = { w: 248, h: 92, gapX: 36, gapY: 76, stackGap: 0, indent: 0, r: 0, rootGap: 36 + ZONE_PAD * 2, rootDrop: 48 }

export interface Point {
  x: number
  y: number
}
export type Spots = Record<string, Point>
export interface View {
  x: number // where the board's origin is, in the window's px
  y: number
  k: number // zoom
}
export interface Box {
  x: number
  y: number
  w: number
  h: number
}
export const MIN_K = 0.3
export const MAX_K = 1.6

// Where everything goes when nobody placed it: the tree from me down, and below it those on their own.
// `over`: the entry points, whose branches are sectors too.
export function tidyBoard<T extends { id: string }>(roots: OrgNode<T>[], loose: T[], s: OrgSizes = BOARD, over: string[] = []): Spots {
  return tidyLayout(roots, loose, s, over).spots
}

// How far a value is from the shape the board leans to, either way.
const offShape = (w: number, h: number): number => Math.abs(Math.log(w / Math.max(1, h) / BOARD_RATIO))

// The tidy board, and the lines that can't go straight. The sectors hang from me (or from the entry point,
// when it's the only top) side by side; when that row would be much wider than a screen, they wrap into
// rows, in order, as many to a row as brings the whole board closest to BOARD_RATIO. A line to a sector in
// a lower row goes down the gap between two columns of sectors, never across another sector: its path is
// in `routes`, by `${from}>${to}`. Those on their own go under everything, in as many rows as keep them
// within the board's width.
export function tidyLayout<T extends { id: string }>(roots: OrgNode<T>[], loose: T[], s: OrgSizes = BOARD, over: string[] = []): { spots: Spots; routes: Record<string, string> } {
  const spots: Spots = {}
  const routes: Record<string, string> = {}
  const drop = s.h + s.gapY + (s.rootDrop ?? 0) // from a card that sectors hang from down to them
  const sideGap = s.rootGap ?? s.gapX
  // The entry point, when it tops the only tree: it sits under me and the sectors hang from it.
  const hub = roots.length === 1 && over.includes(roots[0]!.agent.id) && roots[0]!.kids.length > 0 ? roots[0]! : undefined
  const blocks = hub ? hub.kids : roots
  const hubs = hub ? [ME, hub.agent.id] : [ME]
  const top = hubs.length * drop // where the first row of sectors starts

  // Each sector laid out on its own, from its head down, its head at y 0.
  const laid = blocks.map((b) => {
    const l = layoutOrg([b], s, false, over)
    const nodes = l.nodes.filter((n) => n.id !== ME).map((n) => ({ id: n.id, x: n.x, y: n.y - drop }))
    const left = Math.min(...nodes.map((n) => n.x))
    for (const n of nodes) n.x -= left
    return { id: b.agent.id, nodes, w: Math.max(...nodes.map((n) => n.x)) + s.w, h: Math.max(...nodes.map((n) => n.y)) + s.h }
  })
  // Rows of `cols` sectors: each column as wide as its widest, each row as tall as its tallest.
  const rowGap = ZONE_BOTTOM + s.gapX + ZONE_TOP // a row's zones, a gap, the next row's zones with their chips
  const grid = (cols: number) => {
    const widths = Array.from({ length: cols }, (_, c) => Math.max(0, ...laid.filter((_, i) => i % cols === c).map((b) => b.w)))
    const heights = Array.from({ length: Math.ceil(laid.length / cols) }, (_, r) => Math.max(...laid.slice(r * cols, r * cols + cols).map((b) => b.h)))
    const w = widths.reduce((a, x) => a + x, 0) + sideGap * (cols - 1)
    const h = top + heights.reduce((a, x) => a + x, 0) + rowGap * (heights.length - 1)
    return { cols, widths, heights, w, h }
  }
  let g = grid(Math.max(1, laid.length))
  for (let cols = laid.length - 1; cols >= 1; cols--) {
    const next = grid(cols)
    if (offShape(next.w, next.h) < offShape(g.w, g.h) - 1e-9) g = next
  }

  // The sectors, each centered in its column, the rows from `top` down.
  const colX = g.widths.map((_, c) => g.widths.slice(0, c).reduce((a, x) => a + x + sideGap, 0))
  const rowY = g.heights.map((_, r) => top + g.heights.slice(0, r).reduce((a, x) => a + x + rowGap, 0))
  const heads: { id: string; col: number; row: number; x: number; y: number }[] = []
  laid.forEach((b, i) => {
    const col = i % g.cols
    const row = Math.floor(i / g.cols)
    const x0 = colX[col]! + (g.widths[col]! - b.w) / 2
    for (const n of b.nodes) spots[n.id] = { x: x0 + n.x, y: rowY[row]! + n.y }
    heads.push({ id: b.id, col, row, ...spots[b.id]! })
  })
  // Me (and the entry point) over the middle of the first row's heads; alone, at the top.
  const first = heads.filter((h) => h.row === 0)
  const hubX = first.length ? (first[0]!.x + first.at(-1)!.x) / 2 : 0
  hubs.forEach((id, i) => (spots[id] = { x: hubX, y: i * drop }))

  // A line to a lower row: down to the gap over the first row, along it to the gap between this column and
  // the next one toward me, down that gap, along the gap over its row, and down to the head.
  const from = hubs.at(-1)!
  const a = { x: hubX + s.w / 2, y: spots[from]!.y + s.h }
  for (const h of heads.filter((h) => h.row > 0)) {
    const toward = h.x + s.w / 2 < a.x ? 1 : -1
    const c = g.cols === 1 ? -1 : h.col + (toward > 0 ? (h.col < g.cols - 1 ? 1 : 0) : h.col > 0 ? 0 : 1)
    const gapX = c <= 0 ? -sideGap / 2 : colX[c]! - sideGap / 2
    const overFirst = top - ZONE_TOP - (drop - s.h - ZONE_TOP) / 2
    const overRow = rowY[h.row]! - ZONE_TOP - s.gapX / 2
    routes[`${from}>${h.id}`] = orthogonal([a, { x: a.x, y: overFirst }, { x: gapX, y: overFirst }, { x: gapX, y: overRow }, { x: h.x + s.w / 2, y: overRow }, { x: h.x + s.w / 2, y: h.y }], 14)
  }

  // Those on their own: under everything, as many to a row as fit the board's width, or as keep it
  // closest to its shape when the board has nothing else to be as wide as.
  const treeH = Math.max(...Object.values(spots).map((p) => p.y)) + s.h
  const rowW = (n: number): number => n * s.w + (n - 1) * s.gapX
  let per = loose.length
  if (loose.length > 1) {
    const fit = Math.max(1, Math.floor((g.w + s.gapX) / (s.w + s.gapX)))
    if (rowW(loose.length) > g.w) {
      const shape = (n: number): number => offShape(Math.max(g.w, rowW(n)), treeH + s.gapY + Math.ceil(loose.length / n) * (s.h + s.gapX) - s.gapX)
      per = fit
      for (let n = fit + 1; n <= loose.length; n++) if (shape(n) < shape(per) - 1e-9) per = n
    }
  }
  const width = Math.max(g.w, s.w, loose.length ? rowW(per) : 0)
  // Everything centered on the widest part; the left edge at 0.
  const shift = (width - Math.max(g.w, s.w)) / 2
  for (const id of Object.keys(spots)) spots[id] = { x: Math.round(spots[id]!.x + shift), y: Math.round(spots[id]!.y) }
  if (shift) for (const k of Object.keys(routes)) routes[k] = movePath(routes[k]!, shift)
  loose.forEach((agent, i) => {
    const row = Math.floor(i / per)
    const inRow = Math.min(per, loose.length - row * per)
    spots[agent.id] = { x: Math.round((width - rowW(inRow)) / 2 + (i % per) * (s.w + s.gapX)), y: treeH + s.gapY + row * (s.h + s.gapX) }
  })
  return { spots, routes }
}

// A path through `points`, straight between them, with rounded corners of up to `r`.
export function orthogonal(points: Point[], r: number): string {
  const p = points.filter((q, i) => i === 0 || q.x !== points[i - 1]!.x || q.y !== points[i - 1]!.y)
  let d = `M${p[0]!.x} ${p[0]!.y}`
  for (let i = 1; i < p.length; i++) {
    const at = p[i]!
    const next = p[i + 1]
    if (!next) {
      d += `L${at.x} ${at.y}`
      break
    }
    const prev = p[i - 1]!
    const into = Math.hypot(at.x - prev.x, at.y - prev.y)
    const out = Math.hypot(next.x - at.x, next.y - at.y)
    const k = Math.min(r, into / 2, out / 2)
    const before = { x: at.x - ((at.x - prev.x) / into) * k, y: at.y - ((at.y - prev.y) / into) * k }
    const after = { x: at.x + ((next.x - at.x) / out) * k, y: at.y + ((next.y - at.y) / out) * k }
    d += `L${before.x} ${before.y}Q${at.x} ${at.y} ${after.x} ${after.y}`
  }
  return d
}

// The same path moved `dx` to the side (its numbers come in x, y pairs).
const movePath = (d: string, dx: number): string => {
  let i = 0
  return d.replace(/-?\d+(\.\d+)?/g, (n) => String(i++ % 2 === 0 ? Number(n) + dx : Number(n)))
}

// The board as it is: what was placed by hand stays; whoever came after goes in a row under everything.
export function spotsOf(ids: string[], tidy: Spots, saved: Spots | undefined, s: OrgSizes = BOARD): Spots {
  const kept = Object.entries(saved ?? {}).filter(([id, p]) => ids.includes(id) && Number.isFinite(p?.x) && Number.isFinite(p?.y))
  if (!kept.length) return tidy
  const spots: Spots = Object.fromEntries(kept.map(([id, p]) => [id, { x: p.x, y: p.y }]))
  const box = boundsOf(Object.values(spots), s)
  let i = 0
  for (const id of ids) if (!spots[id]) spots[id] = { x: box.x + i++ * (s.w + s.gapX), y: box.y + box.h + s.gapY }
  return spots
}

export function boundsOf(points: Point[], s: OrgSizes = BOARD): Box {
  if (!points.length) return { x: 0, y: 0, w: s.w, h: s.h }
  const x = Math.min(...points.map((p) => p.x))
  const y = Math.min(...points.map((p) => p.y))
  return { x, y, w: Math.max(...points.map((p) => p.x)) + s.w - x, h: Math.max(...points.map((p) => p.y)) + s.h - y }
}

const clampK = (k: number): number => Math.max(MIN_K, Math.min(MAX_K, k))

// The view that shows the whole box in the room there is, never larger than life.
export function fitView(box: Box, room: { w: number; h: number }, pad = 56): View {
  const k = clampK(Math.min(1, (room.w - pad * 2) / box.w, (room.h - pad * 2) / box.h))
  return { k, x: Math.round((room.w - box.w * k) / 2 - box.x * k), y: Math.round((room.h - box.h * k) / 2 - box.y * k) }
}

// Zooms keeping what is under `at` (the window's px, from the board's corner) where it is.
export function zoomAt(view: View, at: Point, k: number): View {
  const next = clampK(k)
  const f = next / view.k
  return { k: next, x: at.x - (at.x - view.x) * f, y: at.y - (at.y - view.y) * f }
}

// From the window's px to the board's own.
export const toBoard = (view: View, at: Point): Point => ({ x: (at.x - view.x) / view.k, y: (at.y - view.y) / view.k })

// A line from under one point down (or around) to above another, leaving and arriving upright.
export function curve(from: Point, to: Point): string {
  const bend = Math.max(36, Math.abs(to.y - from.y) / 2)
  return `M${from.x} ${from.y}C${from.x} ${from.y + bend} ${to.x} ${to.y - bend} ${to.x} ${to.y}`
}
export const under = (p: Point, s: OrgSizes = BOARD): Point => ({ x: p.x + s.w / 2, y: p.y + s.h })
export const above = (p: Point, s: OrgSizes = BOARD): Point => ({ x: p.x + s.w / 2, y: p.y })
