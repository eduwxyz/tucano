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
