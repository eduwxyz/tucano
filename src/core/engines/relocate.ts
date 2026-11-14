// A harness found at one path when the app started may move while it runs (Claude Code going from
// /opt/homebrew/bin to ~/.local/bin on an update): its next spawn fails with ENOENT. Before a turn,
// a path that's gone is looked for again; a turn that fails with ENOENT before saying anything
// looks again and runs once more from where it is now. Still nowhere: a plain error that says so.
import { existsSync } from 'node:fs'
import { L } from '../../shared/lang'
import type { Engine, EngineEvent, Turn } from './types'

const ENOENT = /\bENOENT\b/

export function relocating(engine: Engine, o: { path: () => string | undefined; label: string; redetect: () => Promise<void> }): Engine {
  let looking: Promise<void> | undefined
  // One look at a time, shared by the turns that ran into it together.
  const lookAgain = (): Promise<void> =>
    (looking ??= o.redetect().catch((e: unknown) => console.error('[engines] detect', e)).finally(() => (looking = undefined)))
  const missing = (): string | undefined => {
    const p = o.path()
    return p && !existsSync(p) ? p : undefined
  }
  const gone = (p: string | undefined): EngineEvent => ({
    type: 'error',
    message: L(
      `Não encontrei o ${o.label}${p ? ` em ${p}` : ''}. Ele foi movido ou desinstalado? Instale de novo, ou confira em Configurações › Motores.`,
      `I couldn't find ${o.label}${p ? ` at ${p}` : ''}. Was it moved or uninstalled? Install it again, or check Settings › Harnesses.`
    )
  })
  return {
    ...engine,
    // Asked each time, not copied as it stood when the app opened: Codex keeps sessions only while
    // its app-server can take every turn. A copy that stayed true kept asking it to resume
    // conversations it had answered through exec, and every other reply failed.
    get sessions() {
      return engine.sessions
    },
    async *run(turn: Turn): AsyncIterable<EngineEvent> {
      let looked = false
      const before = missing()
      if (before) {
        await lookAgain()
        looked = true
        if (missing() || !o.path()) return void (yield gone(before))
      }
      for (let attempt = 0; ; attempt++) {
        let said = false
        let lost: EngineEvent | undefined
        for await (const ev of engine.run(turn)) {
          if (!said && ev.type === 'error' && ENOENT.test(ev.message) && attempt === 0 && !turn.signal.aborted) {
            lost = ev
            break
          }
          said = true
          yield ev
        }
        if (!lost) return
        const was = o.path()
        if (!looked) await lookAgain()
        looked = true
        if (missing() || !o.path()) return void (yield gone(was))
      }
    }
  }
}
