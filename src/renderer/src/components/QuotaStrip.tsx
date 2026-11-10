// The little bars in a session's header: what each provider has left, one bar per provider, and
// only the window that lasts longest. A plan is decided by the month, not by the five hours it
// happens to be in — a month at 8% left is the number that matters, and the short window under it
// only says how the next few hours go. So the header draws the month where there is one, the week
// where there isn't, and the short window for a provider that reports nothing longer.
//
// A wallet (a balance with no cap) draws no bar: it has no denominator and no reset, and inventing
// one would read as "nearly full" when it says nothing. Its money is on the Usage page.
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { ProviderQuota, QuotaWindow } from '../../../shared/types'
import { amAdmin, loadQuotas, navigate, useStore } from '../store'
import { left, share, until } from './Usage'

type Span = 'month' | 'week' | 'session'
// Longest first: the first window a provider reports is the one the header keeps.
const SPANS: readonly Span[] = ['month', 'week', 'session']
const NAMES: Record<Span, () => string> = {
  month: () => L('no mês', 'this month'),
  week: () => L('na semana', 'this week'),
  session: () => L('na janela curta', 'in the short window')
}

// The one window a provider shows in the header: its longest, and only if it has a cap to draw.
export function longest(p: ProviderQuota): { span: Span; w: QuotaWindow } | undefined {
  for (const span of SPANS) {
    const w = p[span]
    if (w && w.limit !== undefined && w.limit > 0 && w.remaining !== undefined) return { span, w }
  }
  return undefined
}

// Reading every provider's quota costs a request each, so the strip keeps what it read for a while
// instead of asking again on every conversation the person opens. The Usage page reads on its own.
const FRESH = 10 * 60_000
let cache: { list: ProviderQuota[]; at: number } | null = null
export const forgetQuotaStrip = (): void => {
  cache = null
}

// `admin` gates the read, and is named as such: what only an admin may ask is only asked by one.
function useQuotas(admin: boolean): ProviderQuota[] {
  const [list, setList] = useState<ProviderQuota[]>(cache && Date.now() - cache.at < FRESH ? cache.list : [])
  useEffect(() => {
    if (!admin) return
    if (cache && Date.now() - cache.at < FRESH) {
      setList(cache.list)
      return
    }
    let live = true
    loadQuotas()
      .then((l) => {
        cache = { list: l, at: Date.now() }
        if (live) setList(l)
      })
      // A failed read is not a strip of zeros: it draws nothing and the Usage page says why.
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [admin])
  return list
}

export function QuotaStrip(): ReactNode {
  // Whose logins are read is an admin's, as everywhere else: a member's app never asks.
  const admin = useStore(amAdmin)
  const list = useQuotas(admin)
  if (!admin) return null
  const bars = list.map((p) => ({ p, pick: longest(p) })).filter((b): b is { p: ProviderQuota; pick: { span: Span; w: QuotaWindow } } => b.pick !== undefined)
  if (bars.length === 0) return null
  return (
    <button
      type="button"
      className="quota-strip"
      title={L('O que cada provedor ainda tem, na janela mais longa de cada um. Clique para ver tudo.', 'What each provider has left, in its longest window. Click to see everything.')}
      aria-label={L('Uso e limites', 'Usage and limits')}
      onClick={() => navigate({ kind: 'usage' })}
    >
      {bars.map(({ p, pick }) => {
        const s = share(pick.w)
        const tone = s === undefined ? '' : s <= 0.1 ? 'is-danger' : s <= 0.3 ? 'is-warn' : ''
        return (
          <span
            key={p.id}
            className={`quota-strip__pill ${tone}`}
            data-provider={p.id}
            data-span={pick.span}
            title={`${p.label} · ${left(pick.w)} ${L('livre', 'left')} ${NAMES[pick.span]()}${pick.w.resetsAt ? ` · ${L('zera', 'resets')} ${until(pick.w.resetsAt)}` : ''}`}
          >
            <i style={{ width: `${Math.round((s ?? 0) * 100)}%` }} />
          </span>
        )
      })}
    </button>
  )
}
