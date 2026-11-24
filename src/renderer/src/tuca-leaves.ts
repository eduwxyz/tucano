// What a person let the Tuca do himself (src/core/tuca-leave.ts), as a screen says it: what each leave
// lets him use, where it holds, and nothing else of it.
import { L } from '../../shared/lang'
import type { State, TucaLeave } from './store'
import { tucaTitle } from './tuca-conversations'

export interface LeaveRow {
  id: string
  kind: string // the kind of thing, in the person's own words for it
  uses: string // "a web, Linear (leitura)"
  where: string // one conversation, or always
}

export const leaveUses = (l: TucaLeave, connectors: { id: string; name: string }[]): string =>
  [...(l.web ? [L('a web', 'the web')] : []), ...Object.entries(l.grants ?? {}).map(([id, g]) => `${connectors.find((c) => c.id === id)?.name ?? L('um serviço removido', 'a removed service')} (${g === 'read_write' ? L('leitura e escrita', 'read and write') : L('leitura', 'read')})`)].join(', ') ||
  L('nada além de escrever', 'nothing beyond writing')

export function leaveRows(s: Pick<State, 'leaves' | 'connectors' | 'conversations' | 'messages'>): LeaveRow[] {
  return s.leaves.map((l) => {
    const there = l.conversationId ? s.conversations.find((c) => c.id === l.conversationId) : undefined
    const where = !l.conversationId ? L('sempre, sem perguntar', 'always, without asking') : there ? L(`só em “${tucaTitle(s, there)}”`, `only in “${tucaTitle(s, there)}”`) : L('só numa conversa', 'in one conversation only')
    return { id: l.id, kind: l.kind, uses: leaveUses(l, s.connectors), where }
  })
}
