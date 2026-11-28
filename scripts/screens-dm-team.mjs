// Frames for a person's @ in a DM opening a named team room, the channel card that stays, and the
// work-room expiry dropdown. Seeded fake data and engines, temporary profile. Run after npm run build:
// node scripts/screens.mjs dm-team [--out C:/tmp/frames/dm-team/<size>] [--size WxH]
import assert from 'node:assert/strict'
import { close, idle, measure, openApp, shot, until, writeFrames } from './screens/lib.mjs'

export const title = 'A DM mention opens a named team'
export const size = '1280x820'

export default async function story(t) {
  const app = await openApp({ size: t.size, seed: 1, locale: 'en-US', fake: true })
  const win = app.win
  const rows = []
  const target = t.size ?? size
  const [wantedW, wantedH] = target.split('x').map(Number)

  // At 760 px and below the sidebar is a drawer behind the menu button. Navigation closes it.
  const openNav = async () => {
    const toggle = win.locator('.mobile-nav')
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click()
      await until(win, '.app.is-nav-open')
    }
  }

  const add = async (selector, props, data, name, note = null) => {
    const frame = name ? await shot(app, name) : null
    const found = await measure(app, selector, props, { optional: true })
    const first = found[0]
    rows.push({ selector, props: first?.props ?? null, box: first?.box ?? null, frame, data, note })
    return found
  }

  try {
    await until(win, '.sidebar')
    await idle(app)
    const window = await win.evaluate(() => ({ url: location.href, title: document.title, width: window.innerWidth, height: window.innerHeight }))
    assert.equal(window.width, wantedW, 'the window opened at the requested width in px')
    assert.equal(window.height, wantedH, 'the window opened at the requested height in px')
    assert.match(window.url, /^(file|http)/, 'the app opened a real page')

    // 1. Lia's DM before the mention.
    await openNav()
    await win.locator('.agent-row').filter({ hasText: 'Lia' }).locator('button.nav-item').first().click()
    await until(win, '.composer textarea')
    await idle(app)
    await add('.composer textarea', ['width', 'height', 'font-size'], { state: 'dm-before', window }, '01-dm-before', 'composer in the DM, 1 person and 1 agent, 0 cards')

    // 2. Mention Theo in that DM. The card must not appear and the DM must keep just a pointer line.
    await win.fill('.composer textarea', '@theo revise o escopo comigo')
    await win.keyboard.press('Enter')
    await until(win, '.nav-item[title^="Team-up"]')
    await idle(app)
    const cardsInDm = await measure(app, '.ask', [], { optional: true })
    assert.equal(cardsInDm.length, 0, 'no inclusion card in the DM')
    const pointers = await win.locator('.system-line').filter({ hasText: 'team-up-lia-theo' }).allInnerTexts()
    assert.equal(pointers.length, 1, 'exactly one pointer line in the DM')
    await add('.system-line', ['display', 'visibility', 'opacity', 'width'], { state: 'dm-pointer', cardCount: cardsInDm.length, pointerLines: pointers.length, pointerText: pointers[0] ?? null }, '02-dm-pointer', '1 pointer line in the DM, 0 cards, room name from both handles')

    // 3. The named team room: both agents answered there, inside the 22-character name.
    await openNav()
    await win.locator('.nav-item[title^="Team-up"]').first().click()
    await until(win, '.composer textarea')
    await idle(app)
    const roomName = (await win.locator('.nav-item[title^="Team-up"] .nav-item__label').first().innerText()).trim()
    assert.equal(roomName, 'team-up-lia-theo', 'the room name comes from both handles')
    assert.ok(roomName.length <= 22, 'the room name fits the sidebar in 22 characters')
    const names = await win.locator('.msg--agent .msg__author').allInnerTexts().catch(() => [])
    assert.ok(await win.locator('.msg--agent').count() >= 2, 'both agents wrote in the new room')
    await add('.msg--agent', ['display', 'visibility', 'opacity', 'width'], { state: 'team-room', roomName, roomNameChars: roomName.length, agentMessages: await win.locator('.msg--agent').count(), authorLabels: names.slice(0, 4) }, '03-team-room', `2 agent replies in ${roomName}, name ${roomName.length} of 22 characters`)

    // 4. The same @ in a channel still raises the card with Include and Skip.
    await openNav()
    await win.locator('.nav-item').filter({ hasText: 'engineering' }).first().click()
    await until(win, '.composer textarea')
    await win.fill('.composer textarea', '@nina revise o build')
    await win.keyboard.press('Enter')
    await until(win, '.ask')
    await idle(app)
    const options = [
      ...await win.locator('.ask-option__label').allInnerTexts(),
      ...await win.locator('.ask-chip').allInnerTexts()
    ]
    assert.ok(options.some((o) => /Include/.test(o)), 'Include is on the card')
    assert.ok(options.some((o) => /Skip/.test(o)), 'Skip is on the card')
    await add('.ask', ['display', 'visibility', 'opacity', 'width'], { state: 'channel-card', options: options.map((o) => o.trim()) }, '04-channel-card', '1 Include/Skip card in a channel mention')

    // 5. The dropdown and its default, with computed style rather than a class boolean.
    await openNav()
    await win.locator('.sidebar__gear[aria-label="Settings"]').first().click()
    await until(win, '.page')
    await win.locator('[role="tab"], .tabs button').filter({ hasText: 'Agents' }).first().click()
    const field = win.locator('.field').filter({ hasText: 'Work rooms close after' }).first()
    await field.locator('button').first().waitFor({ state: 'visible' })
    await field.scrollIntoViewIfNeeded()
    await field.locator('button').first().click()
    await until(win, '[role="option"]')
    const labels = (await win.locator('[role="option"] .select__label').allInnerTexts()).map((s) => s.trim())
    assert.deepEqual(labels, ['No expiry', '5 days', '14 days', '30 days'], 'the four quiet-day choices')
    const selected = await win.locator('[role="option"][aria-selected="true"] .select__label').allInnerTexts()
    assert.deepEqual(selected.map((s) => s.trim()), ['No expiry'], 'no expiry is selected by default')
    await add('[role="option"]', ['display', 'visibility', 'opacity', 'height'], { state: 'settings-dropdown', options: labels, selected: selected.map((s) => s.trim()) }, '05-settings-dropdown', '5, 14, 30 days and no expiry, 0 days selected by default')

    assert.deepEqual(app.errors, [], 'no page or console errors')
  } finally {
    writeFrames(app.out, rows, { story: 'dm-team', size: target, data: { window: rows[0]?.data?.window ?? null, errors: app.errors } })
    await close(app)
  }
}
