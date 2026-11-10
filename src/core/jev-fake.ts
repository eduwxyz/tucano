// A stand-in for TypeSafe's two questions — the listen one and the router's — for a machine with no
// TypeSafe key. Wired in only in fake engines mode, and only when TUCANO_FAKE_LISTEN names who
// should be brought in (`<handle>`) or says that nobody is (`none`), so a listening channel can be
// driven in the built app and in a test without spending a real question.
import { LISTEN_NONE } from './jev'

const LISTEN_NO = '__nao'

type Question = { criteria?: Record<string, string> }
type Body = { questions?: Record<string, Question> }

// The key Jev answers on when nobody set one: the listen and the router calls only need *a* key.
export const LISTEN_STUB_KEY = 'fake-listen'

export function listenStub(handle: string): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = (JSON.parse(String(init?.body ?? '{}')) ?? {}) as Body
    const answers: Record<string, unknown> = {}
    for (const [name, q] of Object.entries(body.questions ?? {})) {
      const criteria = q.criteria ?? {}
      const keys = Object.keys(criteria)
      // The listen question offers the listeners and "nobody": anyone not asked for is nobody.
      // The router's offers only agents, so it can't answer "nobody" and falls to the first.
      const choice =
        name === 'needed'
          ? LISTEN_NO
          : keys.includes(handle)
            ? handle
            : keys.includes(LISTEN_NONE)
              ? LISTEN_NONE
              : (keys[0] ?? '')
      answers[name] = { type: 'choice', choice, probabilities: { [choice]: 0.88 } }
    }
    return Response.json({ answers })
  }) as unknown as typeof fetch
}
