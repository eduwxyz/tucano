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
export function layoutOrg<T extends { id: string }>(roots: OrgNode<T>[], s: OrgSizes = ORG_SIZES, pile = true): OrgLayout {
  const stacked = (n: OrgNode<T>): boolean => pile && n.kids.length > 0 && n.kids.every((k) => k.kids.length === 0)
  const nodes: Placed[] = []
  const edges: OrgEdge[] = []
  const size = (n: OrgNode<T>): { w: number; h: number } => {
    if (!n.kids.length) return { w: s.w, h: s.h }
    if (stacked(n)) return { w: s.indent + s.w, h: s.h + n.kids.length * (s.h + s.stackGap) }
    const kids = n.kids.map(size)
    return { w: Math.max(s.w, kids.reduce((a, k) => a + k.w, 0) + s.gapX * (kids.length - 1)), h: s.h + s.gapY + Math.max(...kids.map((k) => k.h)) }
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
    const total = sizes.reduce((a, k) => a + k.w, 0) + s.gapX * (kids.length - 1)
    const ky = y + s.h + s.gapY
    let kx = x + (width - total) / 2
    const anchors = kids.map((k, i) => {
      const at = place(k.agent.id, k.kids, stacked(k), kx, ky, sizes[i]!.w)
      kx += sizes[i]!.w + s.gapX
      return at
    })
    const cx = (anchors[0]! + anchors.at(-1)!) / 2
    nodes.push({ id, x: cx - s.w / 2, y })
    anchors.forEach((at, i) => edges.push({ from: id, to: kids[i]!.agent.id, d: elbow(cx, y + s.h, at, ky, y + s.h + s.gapY / 2) }))
    return cx
  }
  const sizes = roots.map(size)
  const width = Math.max(s.w, sizes.reduce((a, k) => a + k.w, 0) + s.gapX * Math.max(0, roots.length - 1))
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
export const BOARD: OrgSizes = { w: 248, h: 92, gapX: 36, gapY: 76, stackGap: 0, indent: 0, r: 0 }

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

// Where everything goes when nobody placed it: the tree from me down, and below it, in a row, those on their own.
export function tidyBoard<T extends { id: string }>(roots: OrgNode<T>[], loose: T[], s: OrgSizes = BOARD): Spots {
  const tree = layoutOrg(roots, s, false)
  const row = loose.length * s.w + Math.max(0, loose.length - 1) * s.gapX
  const width = Math.max(tree.width, row)
  const spots: Spots = {}
  for (const n of tree.nodes) spots[n.id] = { x: Math.round(n.x + (width - tree.width) / 2), y: n.y }
  const y = tree.height + s.gapY
  loose.forEach((a, i) => (spots[a.id] = { x: Math.round((width - row) / 2 + i * (s.w + s.gapX)), y }))
  return spots
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
