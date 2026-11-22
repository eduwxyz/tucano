import { describe, expect, it } from 'vitest'
import { describePage } from '../src/core/browser'
import type { BrowserReply } from '../src/shared/types'
import { readWall, wallNote, windowGetsPast, type PageSigns } from '../src/shared/wall'

// A page's own signs, as shared/page.ts brings them back: what the wall reader gets to work with.
const signs = (extra: Partial<PageSigns> = {}): PageSigns => ({
  chars: 900,
  more: false,
  words: '',
  links: 4,
  fields: 0,
  buttons: 2,
  password: 0,
  frames: [],
  marks: [],
  ...extra
})

// The pages below are quoted from the run of 2026-11-22 (headless Chrome, fresh profile), not
// invented: a detector only as good as the words it has seen is a detector nobody can trust.
const CLOUDFLARE =
  'www.backerkit.com performing security verification this website uses a security service to protect against malicious bots. this page is displayed while the website verifies you are not a bot. ray id: a5e78d4e4f6f21e2 performance and security by cloudflare privacy'
const IDEALO =
  'sorry! something has gone wrong. if the issue persists, please make sure your browser is updated to the latest version. still having the issue, please reach out to our customer care with reference id 0.4c4427d4.'
const XCOM =
  "access to x.com was denied you don't have authorization to view this page. http error 403 reload"

describe('what a page is, when it is not the page', () => {
  it('names a Cloudflare interstitial by the words it serves today', () => {
    const page = signs({ chars: CLOUDFLARE.length, words: CLOUDFLARE, links: 0, buttons: 2 })
    expect(readWall(page, { title: 'Just a moment...', url: 'https://www.backerkit.com/' })).toEqual({ kind: 'challenge', why: 'performing security verification' })
    expect(readWall(page, { title: 'Just a moment...', url: 'https://www.linkedin.com/' })?.kind).toBe('challenge')
  })

  it('names one by its mark or its iframe when the words arrive later', () => {
    expect(readWall(signs({ chars: 265, marks: ['challenge-form'] }))?.why).toBe('challenge-form')
    expect(readWall(signs({ chars: 320, marks: ['g-recaptcha'], frames: ['https://www.google.com/recaptcha/enterprise/anchor?ar=1'] }))?.kind).toBe('challenge')
    expect(readWall(signs({ chars: 260, frames: ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b'] }))?.kind).toBe('challenge')
  })

  it('says nothing about a real page that merely carries a captcha', () => {
    // Measured 2026-11-22: linkedin.com/login is a sign-in form with an invisible reCAPTCHA on it —
    // 12 links, 2 fields, 6 buttons, 1 password field, 148 characters of its own words (the labels
    // are placeholders, so the page reads short). It is not a test, and an agent told it was one
    // would stop in front of a form that only wanted its Vault login.
    const frames = ['https://www.google.com/recaptcha/enterprise/anchor?ar=1&size=invisible', 'https://accounts.google.com/gsi/button?logo_alignment=center']
    // It reads as what it is, a sign-in wall, so the agent is told about the Vault login instead.
    expect(readWall(signs({ chars: 148, links: 12, fields: 2, buttons: 6, password: 1, frames }), { title: 'LinkedIn Login, Sign in | LinkedIn' })).toEqual({ kind: 'login', why: 'campo de senha' })
    // The signed-out home page: 96 links, 5 buttons, 699 characters and the same invisible reCAPTCHA.
    expect(readWall(signs({ chars: 699, links: 96, fields: 0, buttons: 5, frames }), { title: 'LinkedIn: Log In or Sign Up' })).toBeUndefined()
    // Reddit's "Prove your humanity" is a test and stays one: 6 links, nothing to fill in, 238 characters.
    const reddit = signs({ chars: 238, words: 'reddit - prove your humanity', links: 6, fields: 0, buttons: 0, marks: ['g-recaptcha'], frames: ['https://www.google.com/recaptcha/api2/anchor?a', 'https://www.google.com/recaptcha/api2/bframe?h'] })
    expect(readWall(reddit, { title: 'Reddit - Prove your humanity' })).toEqual({ kind: 'challenge', why: 'prove your humanity' })
  })

  it('says nothing about a long page that merely carries a captcha or quotes the words', () => {
    expect(readWall(signs({ chars: 1200, more: true, words: 'contact us. we use cookies only for analytics... just a moment please', marks: ['cf-turnstile'] }), { title: 'Contact' })).toBeUndefined()
    expect(readWall(signs({ more: true, words: 'an article about "just a moment": why cloudflare shows it' }))).toBeUndefined()
  })

  it('names a refusal, by the words on it', () => {
    expect(readWall(signs({ chars: IDEALO.length, words: IDEALO }), { title: 'idealo', url: 'https://www.idealo.de/' })).toEqual({ kind: 'blocked', why: 'make sure your browser is updated to the latest version' })
    expect(readWall(signs({ chars: XCOM.length, words: XCOM }), { title: 'x.com' })).toEqual({ kind: 'blocked', why: 'http error 403' })
  })

  it('names a navigation that never arrived, by Chrome’s own error page', () => {
    expect(readWall(signs({ chars: 96, words: 'this site can’t be reached. x.com refused to connect. err_connection_reset' }), { title: 'x.com' })).toEqual({ kind: 'failed', why: 'err_connection_reset' })
    expect(readWall(signs({ chars: 90, words: 'this site can’t be reached' }))?.kind).toBe('failed')
  })

  it('names a sign-in wall, by its password field or by its words', () => {
    expect(readWall(signs({ chars: 300, password: 1, fields: 2 }))?.kind).toBe('login')
    expect(readWall(signs({ chars: 400, words: 'you must be logged in to see this page' }))?.kind).toBe('login')
    expect(readWall(signs({ chars: 900, password: 1, fields: 3, links: 30, more: true }))).toBeUndefined() // a page with a login form on it
  })

  it('names a consent wall holding the page, and never a banner on a page with content', () => {
    expect(readWall(signs({ chars: 700, words: 'we value your privacy. we use cookies and our partners too', buttons: 2 }))?.kind).toBe('consent')
    expect(readWall(signs({ chars: 1200, more: true, words: 'we value your privacy. we use cookies' }))).toBeUndefined()
  })

  it('names a page that drew nothing, and leaves an embedded document alone', () => {
    expect(readWall(signs({ chars: 0, links: 0, buttons: 0, fields: 0 }))).toEqual({ kind: 'empty', why: '0 caracteres' })
    expect(readWall(signs({ chars: 0, links: 0, buttons: 0, fields: 0, frames: ['file:///C:/tmp/bill.pdf'] }))).toBeUndefined()
  })

  it('says nothing about an ordinary page, and nothing without signs', () => {
    expect(readWall(signs({ words: 'retenção média 42% · vídeos novos hoje' }), { title: 'Studio' })).toBeUndefined()
    expect(readWall(undefined)).toBeUndefined()
  })
})

describe('the line the agent reads', () => {
  it('tells the agent what it landed on, and the one move that helps', () => {
    const said = wallNote({ kind: 'challenge', why: 'performing security verification' }, 'Edu')
    expect(said).toContain('desafio de robô (performing security verification)')
    expect(said).toContain('Não clique de novo')
    expect(said).toContain('Edu')
    expect(wallNote({ kind: 'blocked', why: 'http error 403' })).toContain('não muda nada')
    expect(wallNote({ kind: 'failed', why: 'err_connection_reset' })).toContain('Confira o endereço')
    expect(wallNote({ kind: 'login', why: 'campo de senha' })).toContain('navegador_login')
    expect(wallNote({ kind: 'consent', why: 'we use cookies' })).toContain('botão da lista')
    expect(wallNote({ kind: 'empty', why: '0 caracteres' })).toContain('navegador_esperar')
  })

  it('sits under the address, above the elements, and only when there is a wall', () => {
    const page: BrowserReply = {
      url: 'https://www.linkedin.com/feed/',
      title: 'Just a moment...',
      elements: [{ ref: 1, role: 'link', label: 'Cloudflare', inView: true }],
      signs: signs({ chars: CLOUDFLARE.length, words: CLOUDFLARE, links: 1, buttons: 0 })
    }
    const lines = describePage(page, { me: 'Edu' }).split('\n')
    expect(lines[0]).toBe('Página: Just a moment...')
    expect(lines[1]).toBe('https://www.linkedin.com/feed/')
    expect(lines[2]).toContain('Barreira: desafio de robô (performing security verification)')
    expect(lines[3]).toBe('')
    expect(lines[4]).toBe('Na tela:')
    expect(lines.some((l) => l.startsWith('#1 link "Cloudflare"'))).toBe(true)
    // An ordinary page keeps the shape it had.
    const plain = describePage({ url: 'https://x.com/a', title: 'A', elements: [{ ref: 1, role: 'botão', label: 'Buscar', inView: true }], signs: signs() })
    expect(plain).not.toContain('Barreira:')
    expect(plain.split('\n').slice(0, 4)).toEqual(['Página: A', 'https://x.com/a', '', 'Na tela:'])
  })
})

describe('which wall a real window can get past', () => {
  // Measured 2026-11-22 on the same Chrome and profile over 11 sites: headless was hard-blocked on 4
  // (Cloudflare on backerkit and linkedin, a 403 on idealo and x.com) and a real window on 1 (reddit,
  // a login). So a bot check and a refusal are worth a window; nothing else reads differently in one.
  it('asks for a window on a bot check and a refusal, and on nothing else', () => {
    expect(windowGetsPast({ kind: 'challenge', why: 'performing security verification' })).toBe(true)
    expect(windowGetsPast({ kind: 'blocked', why: 'http error 403' })).toBe(true)
    expect(windowGetsPast({ kind: 'login', why: 'campo de senha' })).toBe(false)
    expect(windowGetsPast({ kind: 'consent', why: 'we use cookies' })).toBe(false)
    expect(windowGetsPast({ kind: 'failed', why: 'err_connection_reset' })).toBe(false)
    expect(windowGetsPast({ kind: 'empty', why: '0 caracteres' })).toBe(false)
    expect(windowGetsPast(undefined)).toBe(false)
  })

  it('stops advising a wait or a takeover once the lane is already a real window', () => {
    const challenge = wallNote({ kind: 'challenge', why: 'g-recaptcha' }, 'Edu', { headful: true })
    expect(challenge).toContain('já é uma janela de verdade')
    expect(challenge).toContain('esperar não muda nada')
    expect(challenge).toContain('Edu')
    expect(challenge).not.toContain('Não clique de novo')
    const refused = wallNote({ kind: 'blocked', why: 'http error 403' }, 'Edu', { headful: true })
    expect(refused).toContain('mesmo numa janela de verdade')
    expect(refused).toContain('Use outra fonte')
    // Without that, the advice is the one it always was.
    expect(wallNote({ kind: 'challenge', why: 'g-recaptcha' }, 'Edu')).toContain('Não clique de novo')
  })

  it('gives that line when the lane is in a window for a wall', () => {
    const walled: BrowserReply = {
      url: 'https://www.reddit.com/r/Pathfinder2e/',
      title: 'Reddit - Prove your humanity',
      headful: true,
      signs: signs({ chars: 240, words: 'reddit - prove your humanity', marks: [] })
    }
    const lines = describePage(walled, { me: 'Edu' }).split('\n')
    expect(lines[2]).toContain('já é uma janela de verdade')
    expect(describePage({ ...walled, headful: false }, { me: 'Edu' }).split('\n')[2]).toContain('Não clique de novo')
  })
})
