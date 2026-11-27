import { L, locale } from './lang'

// A subscription window as it stands now. Claude Code and Codex only report a window when a reply
// runs, so the last report can outlive the window: once its reset time has passed, the window started
// over and what it had used no longer counts.
export interface WindowNow {
  used: number // 0..1
  reset: boolean // the reported window is over: the next one starts empty
}

export function windowNow(w: { utilization: number; resetsAt: number }, now = Date.now()): WindowNow {
  if (w.resetsAt > 0 && w.resetsAt <= now) return { used: 0, reset: true }
  return { used: Math.min(1, Math.max(0, w.utilization)), reset: false }
}

const DAY = 86_400_000

// When a window starts over, said so it can't pass for the wrong day: minutes and hours under a day,
// the weekday within the six days ahead, the date beyond that. The weekday alone read "Mon, 21:00" on a
// Monday for a monthly limit renewing the Monday after, and passed for that same night.
export function resetsIn(at: number, now = Date.now()): string {
  const left = at - now
  if (left <= 0) return L('agora', 'now')
  const total = Math.round(left / 60_000) // in whole minutes, so it never says "1 h 60 min"
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h < 24) return L(`em ${h ? `${h} h ` : ''}${m} min`, `in ${h ? `${h} h ` : ''}${m} min`)
  const d = new Date(at)
  const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
  const day = left < 6 * DAY ? d.toLocaleDateString(locale(), { weekday: 'short' }).replace('.', '') : d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' })
  return `${day}, ${time}`
}
