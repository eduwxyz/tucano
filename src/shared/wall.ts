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
  media?: number // pictures, videos, canvases and embedded documents big enough to be the page
}

export interface Wall {
  kind: WallKind
  why: string // the mark or the words that gave it away: the evidence, not a guess
}

// How big a wall is. Every one seen (the study of 2026-11-22 and the vendors' own pages) is a few
// hundred characters and a handful of controls, so a page past either limit is not one, whatever it
// quotes: an article about captchas has the words of a captcha in it.
const WALL_CHARS = 700
const WALL_CONTROLS = 12
// A wall opens with what it is. Weak words count only there or in the title: "access denied" heading a
// page is a refusal, and the same words further down are a page talking about one.
const OPENS_WITHIN = 40

const BOT_FRAMES = ['challenges.cloudflare.com', 'recaptcha', 'hcaptcha', 'captcha-delivery', 'arkoselabs', 'funcaptcha']
// The challenger's own sentences, which nothing but the interstitial says. The first four are the page
// Cloudflare serves today, taken from backerkit.com and linkedin.com on 2026-11-22.
const BOT_WORDS = [
  'performing security verification',
  'security service to protect against malicious bots',
  'verifies you are not a bot',
  'performance and security by cloudflare',
  'performance & security by cloudflare',
  'checking if the site connection is secure',
  'enable javascript and cookies to continue',
  'pardon our interruption',
  'ddos protection by',
  'needs to review the security of your connection',
  'to confirm you are a human'
]
// Words an article can use too: a bot check only when the page opens with them or is titled by them.
const BOT_OPENERS = [
  'just a moment',
  'verify you are human',
  'verifying you are human',
  'verify you are not a robot',
  'verify you are a robot',
  'checking your browser',
  'prove your humanity',
  'are you a robot',
  'unusual traffic',
  'complete the security check'
]
// The navigation itself failed: Chrome's own error page, which is short, titled like the site and
// says nothing an agent can use. It opens with one of these.
const LOAD_WORDS = ['this site can’t be reached', "this site can't be reached", 'this page isn’t working', "this page isn't working", 'refused to connect', 'took too long to respond', 'isn’t available right now', 'dns_probe', 'server ip address could not be found']
// Chrome's codes, listed rather than matched by shape: what's quoted from here goes into the line the
// agent trusts, and "err_" plus anything is a sentence a page could write for it.
const NET_ERRORS = [
  'err_connection_reset',
  'err_connection_refused',
  'err_connection_timed_out',
  'err_connection_closed',
  'err_connection_failed',
  'err_name_not_resolved',
  'err_internet_disconnected',
  'err_address_unreachable',
  'err_network_changed',
  'err_network_access_denied',
  'err_timed_out',
  'err_empty_response',
  'err_invalid_response',
  'err_too_many_redirects',
  'err_tunnel_connection_failed',
  'err_proxy_connection_failed',
  'err_ssl_protocol_error',
  'err_ssl_version_or_cipher_mismatch',
  'err_cert_authority_invalid',
  'err_cert_common_name_invalid',
  'err_cert_date_invalid',
  'err_http2_protocol_error',
  'err_quic_protocol_error',
  'err_blocked_by_client',
  'err_blocked_by_response',
  'err_unsafe_port',
  'err_failed'
]
// A refusal by the site itself, rather than a challenge with a way through. The last ones are what
// idealo.de and x.com answered on 2026-11-22.
const BLOCK_WORDS = [
  '403 forbidden',
  'http error 403',
  'you don’t have authorization',
  "you don't have authorization",
  'you have been blocked',
  'request blocked',
  'cf-error',
  'you are unable to access',
  'make sure your browser is updated to the latest version',
  'please verify you are a human'
]
const BLOCK_OPENERS = ['access denied', '429 too many', 'too many requests', 'service unavailable', 'whoa there']
// Anchored: "403(b) retirement plans" and "The Forbidden Kingdom" are titles too.
const BLOCK_TITLE = /^(?:error\s*)?(?:403|429)(?:\s*[-:|]?\s*(?:forbidden|too many requests|error))?\s*$|^forbidden\s*$|^access denied\b|^too many requests\b|^attention required/
// The sign-in wall's own words, when the page has no password field to show it.
const LOGIN_WORDS = ['sign in to continue', 'log in to continue', 'you must be logged in', 'you must be signed in', 'sign in to see', 'log in to see', 'anmelden, um fortzufahren', 'inicia sessão para continuar', 'faça login para continuar']
// A consent wall: the notice holds the page, instead of sitting on top of it.
const CONSENT_WORDS = ['we value your privacy', 'your privacy choices', 'manage your consent', 'consent to the use of cookies', 'alle akzeptieren', 'datenschutz-einstellungen']
// What a cookie footer on a small page says as well: a wall only when the page opens with it.
const CONSENT_OPENERS = ['before you continue', 'we use cookies', 'this site uses cookies', 'wir verwenden cookies', 'diese website verwendet cookies', 'utilizamos cookies', 'usamos cookies']

const found = (words: string, list: readonly string[]): string | undefined => list.find((w) => words.includes(w))
const opens = (words: string, list: readonly string[]): string | undefined =>
  list.find((w) => {
    const at = words.indexOf(w)
    return at >= 0 && at <= OPENS_WITHIN
  })

// How the page reads, from its own signs and its title. Nothing to say is undefined: the usual case.
// Every `why` it returns is one of the constants above, never the page's text: the note sits outside
// the fence around what a page says, so a page must not be able to put words in it.
export function readWall(signs: PageSigns | undefined, page: { url?: string; title?: string } = {}): Wall | undefined {
  if (!signs) return undefined
  const url = page.url || ''
  if (url === 'about:blank') return undefined // the browser before its first page
  const words = (signs.words || '').toLowerCase()
  const title = (page.title || '').toLowerCase()
  const short = !signs.more // the wall is the whole page: nothing longer can be held by one
  const controls = signs.links + signs.fields + signs.buttons
  const sized = short && signs.chars <= WALL_CHARS && controls <= WALL_CONTROLS
  const says = (strong: readonly string[], weak: readonly string[]): string | undefined =>
    sized ? (found(words, strong) ?? opens(words, weak) ?? found(title, weak)) : undefined

  const botWords = says(BOT_WORDS, BOT_OPENERS)
  if (botWords) return { kind: 'challenge', why: botWords }
  // A mark or a captcha iframe says the page is a test only when the page is nothing: a real page
  // carries them too. Measured 2026-11-22 — linkedin.com/login has 20 clickable things, a password
  // field and an invisible reCAPTCHA, and it is a sign-in form; reddit's "Prove your humanity" has 6
  // links, no field and no password, and it is a test. A form to fill in (a contact page with
  // Turnstile on it) is a page with something to do.
  const bot = signs.marks[0] ?? signs.frames.flatMap((f) => BOT_FRAMES.filter((b) => f.includes(b)))[0]
  if (short && bot && controls <= 10 && signs.fields === 0 && signs.password === 0) return { kind: 'challenge', why: bot }

  const errorPage = url.startsWith('chrome-error:')
  const load = sized ? opens(words, LOAD_WORDS) : undefined
  if (errorPage || load) return { kind: 'failed', why: found(words, NET_ERRORS) ?? load ?? 'chrome-error' }

  const deniedAccess = sized && /^.{0,40}\baccess to \S{1,80} (?:was|has been) denied/.test(words) ? 'access was denied' : undefined
  const refused =
    says(BLOCK_WORDS, BLOCK_OPENERS) ?? deniedAccess ?? (sized ? BLOCK_TITLE.exec(title)?.[0] : undefined) ?? (sized && /^https?:\/\/[^/]*\/cdn-cgi\//.test(url) ? 'cloudflare' : undefined)
  if (refused) return { kind: 'blocked', why: refused }

  // One password field is a sign-in; two or three are a sign-up or a change of password, on a page the
  // agent is already past the door of.
  if (short && signs.chars <= WALL_CHARS && signs.password === 1) return { kind: 'login', why: L('campo de senha', 'a password field') }
  const asks = sized ? (opens(words, LOGIN_WORDS) ?? found(title, LOGIN_WORDS)) : undefined
  if (asks) return { kind: 'login', why: asks }
  const consent = controls > 0 ? says(CONSENT_WORDS, CONSENT_OPENERS) : undefined
  if (consent) return { kind: 'consent', why: consent }
  // A picture, a video, a canvas or a document opened by itself has no words and is all there.
  if (signs.chars < 20 && controls < 3 && !signs.frames.length && !signs.media)
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
