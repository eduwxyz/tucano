// Finding what looks like a path in a message. Only a candidate: the core checks that it exists and
// that this agent reaches it, and the text never decides what happens when it's clicked.
export type PathPart = { text: string } | { path: string; text: string }

const W = String.raw`\p{L}\p{M}\p{N}_` // not \w: folders here have accents, in either of macOS's forms
const PATH = new RegExp(String.raw`(?<![${W}:/.~@+-])(?:~/|/)(?:[${W}.@+-]+/)*[${W}.@+-]*`, 'gu')
const NAME = new RegExp(String.raw`(?<![${W}./~@+-])[${W}@+-][${W}.@+-]*\.[A-Za-z0-9]{1,8}(?![${W}/@+-])`, 'gu')
const TRAILING = /[.,;:!?]+$/

const worthIt = (p: string): boolean => p !== '/' && p !== '~/' && (p.match(/\//g) ?? []).length >= (p.startsWith('~') ? 1 : 2)

export const joinPath = (folder: string, name: string): string => (folder.endsWith('/') ? `${folder}${name}` : `${folder}/${name}`)

// Splits a piece of text. A name alone, like "home-390.png", counts only after a folder was cited:
// `folder` is the last one, and what's returned as `folder` goes on to the next piece.
export function splitPaths(text: string, folder?: string): { parts: PathPart[]; folder?: string } {
  const found: { at: number; end: number; path: string; text: string }[] = []
  let current = folder
  const paths = [...text.matchAll(PATH)].flatMap((m) => {
    const raw = m[0].replace(TRAILING, '')
    return worthIt(raw) ? [{ at: m.index, end: m.index + raw.length, raw }] : []
  })
  const names = [...text.matchAll(NAME)].flatMap((m) => {
    const raw = m[0].replace(TRAILING, '')
    return paths.some((p) => m.index < p.end && m.index + raw.length > p.at) ? [] : [{ at: m.index, end: m.index + raw.length, raw }]
  })
  for (const item of [...paths.map((p) => ({ ...p, isPath: true })), ...names.map((n) => ({ ...n, isPath: false }))].sort((a, b) => a.at - b.at)) {
    if (item.isPath) {
      found.push({ at: item.at, end: item.end, path: item.raw, text: item.raw })
      if (item.raw.endsWith('/')) current = item.raw
    } else if (current) found.push({ at: item.at, end: item.end, path: joinPath(current, item.raw), text: item.raw })
  }
  const parts: PathPart[] = []
  let last = 0
  for (const f of found) {
    if (f.at > last) parts.push({ text: text.slice(last, f.at) })
    parts.push({ path: f.path, text: f.text })
    last = f.end
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return { parts, folder: current }
}

// Inline code is taken whole, since a path there may have spaces ("Application Support").
export function codePath(code: string, folder?: string): string | undefined {
  const value = code.trim()
  if (value.includes('\n')) return undefined
  if (/^(~\/|\/)/.test(value)) return worthIt(value) ? value : undefined
  return folder && new RegExp(`^${NAME.source}$`, 'u').test(value) ? joinPath(folder, value) : undefined
}

interface Node {
  type: string
  value?: string
  url?: string
  children?: Node[]
}

export const LOCAL_LINK = 'tucano-local:'

// A remark plugin: paths in a message's text and inline code become links only this app understands.
// Code blocks and links stay as they are.
export function remarkLocalPaths(): (tree: Node) => void {
  return (tree) => {
    let folder: string | undefined
    const link = (path: string, children: Node[]): Node => ({ type: 'link', url: `${LOCAL_LINK}${encodeURIComponent(path)}`, children })
    const walk = (node: Node): void => {
      if (!node.children) return
      const next: Node[] = []
      for (const child of node.children) {
        if (child.type === 'text' && child.value) {
          const r = splitPaths(child.value, folder)
          folder = r.folder
          for (const p of r.parts) next.push('path' in p ? link(p.path, [{ type: 'text', value: p.text }]) : { type: 'text', value: p.text })
        } else if (child.type === 'inlineCode' && child.value) {
          const path = codePath(child.value, folder)
          if (path?.endsWith('/')) folder = path
          next.push(path ? link(path, [child]) : child)
        } else {
          if (child.type !== 'link' && child.type !== 'code') walk(child)
          next.push(child)
        }
      }
      node.children = next
    }
    walk(tree)
  }
}
