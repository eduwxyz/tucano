// A harness that failed its test (or a reply), said the way a person reads it: one plain line with
// what to do, never a stack trace or a file path. Known failures get their own line (an expired or
// invalid login, per harness and provider when the message says which; a limit; a timeout); anything
// else gets a short generic line, and the raw text goes only in "Ver detalhes".
import { L } from './lang'
import { ENGINES, type EngineId } from './types'

export type EngineProblemKind = 'login' | 'limit' | 'timeout' | 'other'

export interface EngineProblem {
  kind: EngineProblemKind
  line: string // one sentence, with what to do
  details?: string // the raw message, for "Ver detalhes" (absent when the line already says it all)
}

const PROVIDERS: [RegExp, string][] = [
  [/anthropic|claude\.ai|console\.anthropic/i, 'Anthropic'],
  [/openai|chatgpt/i, 'OpenAI'],
  [/google|gemini|vertex/i, 'Google'],
  [/\bx\.?ai\b|grok/i, 'xAI'],
  [/openrouter/i, 'OpenRouter'],
  [/github|copilot/i, 'GitHub'],
  [/cursor/i, 'Cursor']
]

const LOGIN = /invalid_grant|refresh[_ ]?token|token (has )?expired|expired token|oauth|\b401\b|unauthori[sz]ed|not (logged|signed) in|not authenticated|authentication (failed|required|error)|login required|please (log|sign) ?in|(log|sign) ?in again|invalid (api[_ ]?key|x-api-key|credentials)|credentials? (expired|invalid)/i
const EXPIRED = /expired|invalid_grant|refresh/i
const LIMIT = /\b429\b|rate.?limit|usage limit|hit your limit|quota|too many requests/i
const TIMEOUT = /timed? ?out|timeout|aborted|ETIMEDOUT|ECONNRESET/i
// A line someone wrote for people (the core's own messages): short, one line, nothing technical.
const TECHNICAL = /\n|\bat .+\(|file:\/\/|\/(opt|usr|home|Users|var|tmp)\/|[A-Z]:\\|node_modules|\{".*":|Error:|errno|stack/i

// The provider the message names, when the harness signs in to several (Pi, OpenCode).
export function providerOf(raw: string): string | undefined {
  // "… for anthropic: …" names it best; else the first one mentioned.
  const named = /\bfor ([a-z][\w.-]*)\b/i.exec(raw)?.[1]
  for (const [re, name] of PROVIDERS) if (named && re.test(named)) return name
  for (const [re, name] of PROVIDERS) if (re.test(raw)) return name
  return undefined
}

export function explainEngineError(engine: EngineId, raw: string): EngineProblem {
  const label = ENGINES[engine].label
  const text = raw.trim()
  if (LOGIN.test(text)) {
    // Pi and OpenCode sign in to providers; the others are the provider's own app.
    const provider = engine === 'pi' || engine === 'opencode' ? providerOf(text) : undefined
    const whose = provider ? L(`O login da ${provider} no ${label}`, `The ${provider} sign-in in ${label}`) : L(`O login do ${label}`, `${label}’s sign-in`)
    const state = EXPIRED.test(text) ? L('expirou', 'expired') : L('não está valendo', 'isn’t valid')
    return { kind: 'login', line: L(`${whose} ${state}. Entre de novo no ${label} pra usar.`, `${whose} ${state}. Sign in to ${label} again to use it.`), details: text }
  }
  if (LIMIT.test(text)) return { kind: 'limit', line: L(`O ${label} chegou no limite de uso. Tente de novo mais tarde.`, `${label} hit its usage limit. Try again later.`), details: text }
  if (TIMEOUT.test(text)) return { kind: 'timeout', line: L(`O ${label} demorou demais pra responder. Tente de novo.`, `${label} took too long to answer. Try again.`), details: text }
  if (text && text.length <= 140 && !TECHNICAL.test(text)) return { kind: 'other', line: text }
  return { kind: 'other', line: L(`O ${label} não funcionou agora.`, `${label} didn’t work just now.`), details: text || undefined }
}
