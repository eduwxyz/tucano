// A request as a card's title (the board, src/renderer/src/board.ts): a few words that say what it's
// about. The core asks a cheap model for one (src/core/titles.ts) and keeps it on the request; until
// it comes, and when it can't, `shortTitle` makes one out of the words themselves.

export const TITLE_MAX = 60

// The first line of a reply that has words, without Markdown marks: what a list shows of it.
export const firstLine = (text: string): string =>
  text
    .split('\n')
    .map((l) =>
      l
        .replace(/^[#>\-*\s]+/, '')
        .replace(/[*_`]+/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .trim()
    )
    .find(Boolean) ?? ''

// The words of a line, without mentions, links, Markdown or extra spaces.
const clean = (line: string): string =>
  line
    .replace(/@[\w.-]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/^\s*(?:#+|>+|[-•])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()

// What opens a request without saying what it's about: a greeting, the name it's addressed to, "I want the following".
const OPENERS = [
  /^(?:oi|olá|ola|opa|bom dia|boa tarde|boa noite|e a[ií]|hey|hi|hello|good (?:morning|afternoon|evening))\b[\s,!.:-]*/iu,
  /^\p{Lu}[\p{L}]+,\s+/u, // "Otto, publique…"
  /^(?:quero|queria|preciso de|i want|i need) (?:o seguinte|the following)[\s.:,-]*/iu,
  /^(?:por favor|please)[\s,:-]*/iu
]

// Cut at a word, under `max`, with "…" when something was left out.
export function clip(text: string, max = TITLE_MAX): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const at = cut.lastIndexOf(' ')
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

// A request's own words as a title: its first line that says something, past greetings and the
// name it's addressed to, up to its first sentence, short.
export function shortTitle(text: string, max = TITLE_MAX): string {
  const lines = text.split('\n').map(clean).filter(Boolean)
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    for (let again = true; again; ) {
      again = false
      for (const re of OPENERS) {
        const next = line.replace(re, '')
        // Only when words are left: "E aí?" alone stays "E aí?", not "?".
        if (next !== line && /\p{L}{2}/u.test(next)) {
          line = next.trim()
          again = true
        }
      }
    }
    // The first sentence, when the line goes on: "Quero o seguinte. Hoje a gente…" keeps "Hoje a gente…".
    const sentence = line.split(/(?<=[.!?;])\s+/)[0]!.replace(/[.;:,]+$/, '').trim()
    // A line that's only a nudge ("E aí?", "ok") says nothing: the next one, if there is one.
    if (sentence.split(' ').length < 3 && sentence.length < 16 && i < lines.length - 1) continue
    return capital(clip(sentence || line, max))
  }
  return ''
}

// A title that came back from a model: one line, no quotes, no closing period, short.
export function cleanTitle(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const bare = line.replace(/^(?:t[ií]tulo|title)\s*:\s*/i, '').replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').replace(/[.;:]+$/, '').trim()
  return bare ? capital(clip(bare)) : ''
}

// Short enough already: one line of a few words is its own title, no model needed.
export const titledAlready = (text: string): boolean => {
  const lines = text.split('\n').map(clean).filter(Boolean)
  return lines.length === 1 && lines[0]!.length <= 48 && lines[0]!.split(' ').length <= 8
}
