// Finding @handles in a message. The same rule the core uses to call an agent (`mentioned`), so what
// looks like a mention on screen is what calls someone. Whether a handle is an agent is up to the caller.
import { CODE_SPANS } from './types'

export const MENTION = /(^|[^\w@])@([a-z0-9][a-z0-9_-]{1,31})\b/gi

export type MentionPart = { text: string } | { handle: string; text: string }

function splitPlain(text: string, parts: MentionPart[]): void {
  let last = 0
  for (const m of text.matchAll(MENTION)) {
    const at = m.index + m[1]!.length
    if (at > last) parts.push({ text: text.slice(last, at) })
    parts.push({ handle: m[2]!, text: `@${m[2]}` })
    last = at + m[2]!.length + 1
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
}

// Handles inside code are quoted content, not a call (CODE_SPANS): they stay text, as in the core.
export function splitMentions(text: string): MentionPart[] {
  const parts: MentionPart[] = []
  let last = 0
  for (const m of text.matchAll(CODE_SPANS)) {
    splitPlain(text.slice(last, m.index), parts)
    parts.push({ text: m[0] })
    last = m.index + m[0].length
  }
  splitPlain(text.slice(last), parts)
  return parts
}

interface Node {
  type: string
  value?: string
  children?: Node[]
  data?: { hName?: string; hProperties?: Record<string, string>; hChildren?: Node[] }
}

// A remark plugin: each @handle in a message's text becomes a <span data-mention="handle">, for the
// renderer to show as the agent's chip (or as plain text, when no agent has that handle). Code and
// links stay as they are.
export function remarkMentions(): (tree: Node) => void {
  const mention = (handle: string, text: string): Node => ({ type: 'mention', data: { hName: 'span', hProperties: { dataMention: handle }, hChildren: [{ type: 'text', value: text }] } })
  const walk = (node: Node): void => {
    if (!node.children) return
    const next: Node[] = []
    for (const child of node.children) {
      if (child.type === 'text' && child.value?.includes('@')) {
        const parts: MentionPart[] = []
        splitPlain(child.value, parts)
        for (const p of parts) next.push('handle' in p ? mention(p.handle, p.text) : { type: 'text', value: p.text })
      } else {
        if (child.type !== 'link' && child.type !== 'code' && child.type !== 'inlineCode') walk(child)
        next.push(child)
      }
    }
    node.children = next
  }
  return walk
}
