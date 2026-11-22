// What a page is when it is not the page the agent asked for: a bot check, a refusal, a sign-in
// wall, a cookie notice over the content, or nothing drawn at all. The browser says it in the tool
// result because a challenge answers 200, with a title and a few words, so the agent reads "it
// worked" on a page that never opened: it decides the site changed its interface and clicks again.
// Measured 2026-11-22: one session spent 143 of its 248 browser calls on a single host this way.
//
// The signs come from the page's own words and marks (SNAPSHOT in shared/page.ts); the reading is
// here so it can be tested without a browser.
import { L } from './lang'

export type WallKind = 'challenge' | 'failed' | 'blocked' | 'login' | 'consent' | 'empty'

// What the page script brings back about the page itself: the start of its visible words, how much
// of it there is, and the marks a bot check leaves in the DOM.
export interface PageSigns {
  chars: number // visible characters in the sample
  more: boolean // the sample was cut at its cap: the page has more words than that
  words: string // the sample, lowercased and collapsed, for the phrases below
  links: number
  fields: number
  buttons: number
  password: number // visible password fields: a sign-in wall almost always has one
  frames: string[] // the page's iframes, by address, lowercase
  marks: string[] // the ids and classes that name a bot check, as found on the page
}

export interface Wall {
  kind: WallKind
  why: string // the mark or the words that gave it away: the evidence, not a guess
}

// A page with more words than the sample cap (shared/page.ts) is a page, and whatever else it
// carries -- an invisible captcha on a form, a cookie banner over the content -- is not holding it.
// These name a bot check by themselves.
const BOT_MARKS = ['challenge-form', 'challenge-stage', 'cf-turnstile', 'g-recaptcha', 'h-captcha', 'px-captcha', 'datadome']
const BOT_FRAMES = ['challenges.cloudflare.com', 'recaptcha', 'hcaptcha', 'captcha-delivery', 'arkoselabs', 'funcaptcha']
// The challenger's own words, as the interstitials spell them. The first four are the page
// Cloudflare serves today, taken from backerkit.com and linkedin.com on 2026-11-22.
const BOT_WORDS = [
  'performing security verification',
  'security service to protect against malicious bots',
  'verifies you are not a bot',
  'performance and security by cloudflare',
  'just a moment',
  'verify you are human',
  'verifying you are human',
  'verify you are not a robot',
  'verify you are a robot',
  'checking your browser',
  'checking if the site connection is secure',
  'enable javascript and cookies to continue',
  'prove your humanity',
  'are you a robot',
  'unusual traffic',
  'pardon our interruption',
  'ddos protection by',
  'needs to review the security of your connection',
  'complete the security check',
  'press and hold'
]
// The navigation itself failed: Chrome's own error page, which is short, titled like the site and
// says nothing an agent can use.
const LOAD_WORDS = ['this site can’t be reached', "this site can't be reached", 'refused to connect', 'took too long to respond', 'isn’t available right now', 'dns_probe', 'server ip address could not be found']
// A refusal by the site itself, rather than a challenge with a way through. The last three are what
// idealo.de and x.com answered on 2026-11-22.
const BLOCK_WORDS = [
  '403 forbidden',
  'http error 403',
  'access denied',
  'was denied',
  'you don’t have authorization',
  "you don't have authorization",
  'you have been blocked',
  'whoa there',
  'request blocked',
  'too many requests',
  '429 too many',
  'cf-error',
  'service unavailable',
  'you are unable to access',
  'make sure your browser is updated to the latest version',
  'please verify you are a human'
]
const BLOCK_TITLES = ['403', 'access denied', 'forbidden', 'too many requests', 'attention required']
// The sign-in wall's own words, when the page has no password field to show it.
const LOGIN_WORDS = ['sign in to continue', 'log in to continue', 'you must be logged in', 'you must be signed in', 'sign in to see', 'log in to see', 'anmelden, um fortzufahren', 'inicia sessão para continuar', 'faça login para continuar']
// A consent wall: the notice holds the page, instead of sitting on top of it.
const CONSENT_WORDS = [
  'we value your privacy',
  'before you continue',
  'we use cookies',
  'this site uses cookies',
  'your privacy choices',
  'manage your consent',
  'consent to the use of cookies',
  'wir verwenden cookies',
  'diese website verwendet cookies',
  'alle akzeptieren',
  'datenschutz-einstellungen',
  'utilizamos cookies',
  'usamos cookies'
]

const found = (words: string, list: readonly string[]): string | undefined => list.find((w) => words.includes(w))

// How the page reads, from its own signs and its title. Nothing to say is undefined: the usual case.
export function readWall(signs: PageSigns | undefined, page: { url?: string; title?: string } = {}): Wall | undefined {
  if (!signs) return undefined
  const words = (signs.words || '').toLowerCase()
  const title = (page.title || '').toLowerCase()
  const short = !signs.more // the wall is the whole page: nothing longer can be held by one
  const controls = signs.links + signs.fields + signs.buttons
  const bot = signs.marks[0] ?? signs.frames.flatMap((f) => BOT_FRAMES.filter((b) => f.includes(b)))[0]
  const botWords = found(words, BOT_WORDS)
  // A mark or a captcha iframe says the page is a test only when the page is nothing: a real page
  // carries them too. Measured 2026-11-22 — linkedin.com/login has 20 clickable things, a password
  // field and an invisible reCAPTCHA, and it is a sign-in form; reddit's "Prove your humanity" has 6
  // links, no field and no password, and it is a test. The words are the strong sign; a mark or a
  // frame gets the benefit of the doubt only on a page with nothing on it.
  const nothingToDo = controls <= 10 && signs.password === 0
  if (short && botWords) return { kind: 'challenge', why: botWords }
  if (short && bot && nothingToDo) return { kind: 'challenge', why: bot }
  const gone = /err_[a-z_]+/.exec(words)?.[0] ?? (short ? found(words, LOAD_WORDS) : undefined)
  if (gone) return { kind: 'failed', why: gone }
  const refused =
    found(words, BLOCK_WORDS) ?? (short ? found(title, BLOCK_TITLES) : undefined) ?? (/^https?:\/\/[^/]*\/cdn-cgi\//.test(page.url || '') ? 'cloudflare' : undefined)
  if (short && refused) return { kind: 'blocked', why: refused }
  if (short && signs.password > 0) return { kind: 'login', why: L('campo de senha', 'a password field') }
  const asks = found(words, LOGIN_WORDS)
  if (short && asks) return { kind: 'login', why: asks }
  const consent = short && controls > 0 ? found(words, CONSENT_WORDS) : undefined
  if (consent) return { kind: 'consent', why: consent }
  if (signs.chars < 20 && controls < 3 && !signs.frames.length)
    return { kind: 'empty', why: L(`${signs.chars} caracteres`, `${signs.chars} characters`) }
  return undefined
}

// The line the agent reads, in place of the page's own words: what it landed on, and the one move
// that helps. Short on purpose — it goes in every action's result.
export function wallNote(w: Wall, me?: string): string {
  const who = me || L('a pessoa', 'the person')
  const said: Record<WallKind, string> = {
    challenge: L(
      `Barreira: desafio de robô (${w.why}) — isto não é o site, é um teste. Não clique de novo: espere com navegador_esperar, peça pra ${who} assumir o navegador, ou use outra fonte.`,
      `Wall: a bot check (${w.why}) — this is not the site, it is a test. Don't click again: wait with navegador_esperar, ask ${who} to take the browser over, or use another source.`
    ),
    blocked: L(
      `Barreira: o site recusou este navegador (${w.why}). Abrir o mesmo endereço de novo não muda nada: tente outra fonte, ou peça pra ${who} assumir o navegador.`,
      `Wall: the site refused this browser (${w.why}). Opening the same address again changes nothing: try another source, or ask ${who} to take the browser over.`
    ),
    login: L(
      `Barreira: a página pede login (${w.why}). Se o Cofre tem o login deste site, use navegador_login; senão, peça com pedir_chave (site).`,
      `Wall: the page wants a sign-in (${w.why}). If the Vault has this site's login, use navegador_login; otherwise ask for it with pedir_chave (site).`
    ),
    consent: L(
      `Barreira: um aviso de cookies cobre a página (${w.why}). Aceite pelo botão da lista, pelo número dele, e leia a página de novo.`,
      `Wall: a cookie notice covers the page (${w.why}). Accept it with the button in the list, by its number, and read the page again.`
    ),
    failed: L(
      `A página não carregou (${w.why}). Confira o endereço, tente uma vez mais, ou use outra fonte: clicar na tela não adianta.`,
      `The page did not load (${w.why}). Check the address, try once more, or use another source: clicking on it won't help.`
    ),
    empty: L(
      `Página vazia (${w.why}). Ou ainda está carregando (navegador_esperar), ou o site não desenhou nada: abrir de novo não resolve.`,
      `Empty page (${w.why}). It is either still loading (navegador_esperar) or the site drew nothing: opening it again won't fix it.`
    )
  }
  return said[w.kind]
}
