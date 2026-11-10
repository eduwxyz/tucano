// Frames for the follow up (#337 / this PR): under a reply that has ended, the same pill a steer is —
// Steer at the bottom of the chain while it works, Follow Up on the reply's own footer line once it's
// done (the line that fades in on hover), before its receipt, never above the answer. What the person writes stays in that reply: it goes on in the same row, its text and
// steps kept, instead of becoming another message. Fake engines, a workspace made from nothing.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? 'C:/tmp/frames/335'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
const env = { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US' }
const errors = []

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const launch = async () => {
  const app = await electron.launch({ args: ['.'], env })
  const win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 880 })
  await win.waitForSelector('.sidebar')
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  return { app, win }
}

const ask = async (win, text) => {
  await win.locator('.composer textarea').fill(text)
  await win.keyboard.press('Enter')
}
const waitWorking = async (win, want = true) => {
  for (let i = 0; i < 240; i++) {
    const working = await win.evaluate(() => !!document.querySelector('.steps__stop'))
    if (working === want) return true
    await win.waitForTimeout(250)
  }
  return false
}

// The last reply: where its pill sits now — under the answer it goes on from, not in the chain above.
const pillLook = (win) =>
  win.evaluate(() => {
    const msg = [...document.querySelectorAll('.msg--agent')].at(-1)
    const body = msg?.querySelector('.msg__body')
    const pill = body?.querySelector('.steps__ask-pill')
    const steps = body?.querySelector('.steps')
    const md = body?.querySelector('.md')
    const meta = body?.querySelector('.msg__meta')
    if (!body || !pill) return { pill: false, working: !!body?.querySelector('.steps__stop') }
    const p = pill.getBoundingClientRect()
    const t = md?.getBoundingClientRect()
    const m = meta?.getBoundingClientRect()
    const block = pill.closest('.steps__ask')
    const b = block.getBoundingClientRect()
    const st = getComputedStyle(pill)
    const kids = [...body.children]
    return {
      pill: true,
      tag: pill.tagName,
      text: pill.textContent?.replace(/\s+/g, ' ').trim(),
      title: pill.getAttribute('title'),
      height: Math.round(p.height),
      width: Math.round(p.width),
      radius: st.borderRadius,
      fontSize: st.fontSize,
      color: st.color,
      inChain: !!steps?.contains(pill),
      // The reply's own footer line: the one that fades in on hover, where the pill now rides.
      inFooter: !!meta?.contains(pill),
      firstInFooter: meta ? meta.firstElementChild === block : null,
      footerKids: meta ? [...meta.children].map((c) => c.className.split(' ')[0]) : null,
      footerOpacity: block ? getComputedStyle(block).opacity : null,
      sameRowAsReceipt: (() => {
        const r = meta?.querySelector('.receipt__line')?.getBoundingClientRect()
        const b = block?.getBoundingClientRect()
        return r && b ? Math.round(Math.abs(r.top + r.height / 2 - (b.top + b.height / 2)) * 10) / 10 : null
      })(),
      beforeReceipt: (() => {
        const r = meta?.querySelector('.receipt')?.getBoundingClientRect()
        const b = block?.getBoundingClientRect()
        return r && b ? Math.round(b.left) < Math.round(r.left) : null
      })(),
      afterAnswer: t ? p.top >= t.bottom - 1 : null,
      gapUnderAnswer: t ? Math.round(p.top - t.bottom) : null,
      gapUnderText: (() => {
        const para = md?.querySelector('p:last-of-type')
        return para ? Math.round(p.top - para.getBoundingClientRect().bottom) : null
      })(),
      gapUnderReceipt: m ? Math.round(p.top - m.bottom) : null,
      afterAnswerInReply: md ? kids.indexOf(block) > kids.indexOf(md) : null,
      // The reply's own hover icon is out of the flow, pinned to the row's top: it doesn't count.
      lastInFlow: [...body.children].filter((c) => !c.classList.contains('msg__reply')).at(-1) === block,
      alignedWithAnswer: t ? Math.round(b.left - t.left) : null,
      rows: body.querySelectorAll('.step').length,
      summary: steps?.querySelector('.steps__summary')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      working: !!body.querySelector('.steps__stop'),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }
  })

const fieldLook = (win) =>
  win.evaluate(() => {
    const note = document.querySelector('.steps__ask-note')
    if (!note) return { open: false }
    const ta = note.querySelector('textarea')
    const send = [...note.querySelectorAll('button')].find((b) => b.className.includes('btn--primary'))
    const t = ta.getBoundingClientRect()
    return {
      open: true,
      placeholder: ta.getAttribute('placeholder'),
      labelled: ta.getAttribute('aria-label'),
      width: Math.round(t.width),
      height: Math.round(t.height),
      belowPill: (() => {
        const p = document.querySelector('.msg__meta .steps__ask-pill')?.getBoundingClientRect()
        return p ? Math.round(t.top - p.bottom) : null
      })(),
      sendDisabled: !!send?.disabled,
      sendText: send?.textContent?.trim(),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }
  })

const chainLook = (win) =>
  win.evaluate(() => {
    const steps = [...document.querySelectorAll('.steps')].filter((s) => s.querySelector('.steps__toggle')).pop()
    const rows = [...(steps?.querySelectorAll('.step') ?? [])]
    const at = rows.findIndex((r) => r.classList.contains('step--followup'))
    const row = rows[at]
    return {
      rows: rows.length,
      followupAt: at,
      labels: rows.map((r) => r.querySelector('.step__label')?.textContent ?? ''),
      said: row?.querySelector('.step__said')?.textContent ?? null,
      iconBg: row ? getComputedStyle(row.querySelector('.step__icon')).backgroundColor : null,
      rowsAfter: at >= 0 ? rows.length - at - 1 : 0,
      summary: steps?.querySelector('.steps__summary')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      working: !!steps?.querySelector('.steps__stop')
    }
  })

// The reply as it reads: the kept text first, the new turn under it.
const replyText = (win) =>
  win.evaluate(() => {
    const bodies = [...document.querySelectorAll('.msg--agent .md')]
    const last = bodies.at(-1)
    if (!last) return null
    return {
      paragraphs: [...last.querySelectorAll('p')].map((p) => p.textContent?.trim()).filter(Boolean),
      text: last.textContent?.replace(/\s+/g, ' ').trim().slice(0, 200)
    }
  })
const replies = (win) => win.evaluate(() => document.querySelectorAll('.msg--agent').length)

let { app, win } = await launch()
await win.waitForSelector('.sidebar')

// A bot's direct messages chat: the conversation the follow up is for.
const dmNames = await win.evaluate(() => [...document.querySelectorAll('.section .nav-item')].map((n) => n.textContent?.trim()).slice(0, 30))
console.log('sidebar:', JSON.stringify(dmNames))
const agents = win.locator('.section', { has: win.locator('.section__head', { hasText: 'Agents' }) })
await agents.locator('.nav-item', { hasText: 'Lia' }).first().click({ button: 'right' })
await win.getByText('Send a message').click()
await win.waitForSelector('.composer textarea')

await ask(win, 'Update the changelog for the 0.2.27 release, and stop there')
await waitWorking(win, true)
await waitWorking(win, false)
await sleep(600)
console.log('finished reply, the pill:', JSON.stringify(await pillLook(win)))
console.log('its text:', JSON.stringify(await replyText(win)))
// The footer line is the one that fades in: pointer away, the reply ends in its answer, nothing else.
await win.mouse.move(4, 4)
await win.waitForTimeout(300)
console.log('pointer away, under the answer:', JSON.stringify(await pillLook(win)))
await win.screenshot({ path: `${out}/01-not-hovered-nothing-under-the-answer.png` })
await win.locator('.msg--agent').last().hover()
await win.waitForTimeout(300)
console.log('hovered, the footer line:', JSON.stringify(await pillLook(win)))
await win.screenshot({ path: `${out}/02-hovered-the-pill-on-the-footer-line.png` })

// Opening it: a field, nothing sent, the send asleep while it's empty.
await win.locator('.steps__ask-pill').last().click()
await win.waitForTimeout(250)
console.log('the field it opens:', JSON.stringify({ ...(await fieldLook(win)), replies: await replies(win) }))
await win.screenshot({ path: `${out}/03-the-field-it-opens.png` })

// What the person wants next.
const INSTRUCTION = 'Add the two fixes from today as their own entries'
await win.locator('.steps__ask-note textarea').fill(INSTRUCTION)
await win.waitForTimeout(150)
console.log('typed:', JSON.stringify(await fieldLook(win)))
await win.screenshot({ path: `${out}/04-what-they-write.png` })

// Sending it: the field closes and the same reply goes on working — the pill becomes a steer again.
const before = await replies(win)
await win.locator('.steps__ask-note button.btn--primary').click()
await win.waitForTimeout(500)
console.log('after sending:', JSON.stringify({ field: await fieldLook(win), pill: await pillLook(win), replies: await replies(win), before }))

await waitWorking(win, false)
await sleep(700)
// Done, the steps are folded: opened again to read the chain it went through.
await win.locator('.steps__toggle').last().click()
await win.waitForTimeout(300)
console.log('the instruction in the chain:', JSON.stringify(await chainLook(win)))
await win.screenshot({ path: `${out}/05-the-instruction-in-the-chain.png` })
await win.locator('.steps__toggle').last().click()
await win.waitForTimeout(300)
console.log('when it is done:', JSON.stringify({ chain: await chainLook(win), pill: await pillLook(win), replies: await replies(win), before }))
console.log('the reply now:', JSON.stringify(await replyText(win)))
await win.screenshot({ path: `${out}/06-the-same-reply-carried-on.png` })

// 420 px: the pill and the field inside the column, nothing sideways.
await win.setViewportSize({ width: 420, height: 880 })
await win.waitForTimeout(500)
console.log('420, the pill:', JSON.stringify(await pillLook(win)))
await win.locator('.steps__ask-pill').last().click()
await win.waitForTimeout(300)
console.log('420, the field:', JSON.stringify(await fieldLook(win)))
await win.screenshot({ path: `${out}/07-at-420.png` })

console.log('page errors:', JSON.stringify(errors.slice(0, 6)))
await app.close()
