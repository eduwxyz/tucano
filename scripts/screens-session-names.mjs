// Session names on screen: the head chip of a reply at work, the bold label in the work drawer before
// the shortened prompt, the thread head using the name, the Models card after Memory, and the off and
// fallback states. Every size opens the built app with a temporary database, the seed workspace and
// the fake engines; the DM with one agent skips routing so the naming call can be seen at once.
//
//   npm run build
//   node scripts/screens.mjs session-names --out C:/tmp/frames/session-names
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { close, measure, openApp, runErrors, settle, shot, until, writeFrames } from './screens/lib.mjs'

export const title = 'Session names in the reply head, work drawer and Models'
export const size = '1280x820'

const SIZES = (process.env.TUCANO_SIZES ?? '1280x820,1360x880,420x820,360x700').split(',')
const ASK = 'Demore 8 s.\nName the session in the reply header and the work drawer, before the shortened prompt line.'
const DM = 'session-names-dm'

// A direct conversation with Lia, seeded into the temporary database after a first boot creates it.
function seedDm(data) {
  const db = new DatabaseSync(join(data, 'tucano.db'))
  const me = db.prepare("SELECT id FROM people WHERE role = 'owner' LIMIT 1").get().id
  const lia = db.prepare("SELECT id FROM agents WHERE handle = 'lia' LIMIT 1").get().id
  // Upstream's tables have fewer columns than the driver's: insert only what this checkout has.
  const put = (table, values) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    const keys = Object.keys(values).filter((k) => cols.includes(k))
    db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => values[k]))
  }
  put('conversations', { id: DM, kind: 'dm', name: lia, topic: null, threads: null, owner: me, created_by: null, created_at: Date.now(), team_up: null })
  put('members', { conversation_id: DM, agent_id: lia, mode: 'answer' })
  db.close()
  return lia
}

const open = async (viewport, data) => {
  const t = await openApp({ size: viewport, data, locale: 'en-US', seed: 1, fake: true })
  await until(t.win, '.sidebar')
  await settle(t.win, 500)
  return t
}

const dm = async (t) => {
  await t.win.evaluate((id) => { location.hash = `#/c/${id}` }, DM)
  // A desktop window keeps its screen in memory: from Settings the address alone does not leave the
  // page, so the first sidebar item takes it back to a conversation before the hash selects this DM.
  if (!(await t.win.locator('.composer textarea').count())) await t.win.locator('.sidebar .nav-item').first().click()
  await until(t.win, '.composer textarea')
  await t.win.evaluate((id) => { location.hash = `#/c/${id}` }, DM)
  await settle(t.win, 200)
}

const models = async (t) => {
  await t.win.locator('.sidebar__gear, button[aria-label="Settings"], button[aria-label="Configurações"]').first().click()
  await until(t.win, '.settings-groups')
  await t.win.locator('.settings-groups__bar button', { hasText: /^Models$/ }).first().click()
  await until(t.win, '#settings-models-session-names')
  await t.win.locator('#settings-models-session-names').scrollIntoViewIfNeeded()
  await settle(t.win, 300)
}

export default async function story() {
  const rows = []
  let windowProof = null

  for (const viewport of SIZES) {
    const boot = await open(viewport)
    seedDm(boot.data)
    await close(boot)

    const t = await open(viewport, boot.data)
    if (!windowProof) {
      windowProof = await t.win.evaluate(() => ({ href: location.href, innerWidth: window.innerWidth, innerHeight: window.innerHeight, title: document.title }))
      windowProof.launched = true
    }
    await dm(t)
    await t.win.fill('.composer textarea', ASK)
    await t.win.keyboard.press('Enter')
    await until(t.win, '.session-tag', { timeout: 60_000 })
    const chipText = (await t.win.locator('.session-tag__name').first().textContent())?.trim() ?? ''
    const chip = (await measure(t.win, '.session-tag', ['display', 'whiteSpace', 'textOverflow', 'maxWidth', 'fontWeight', 'borderRadius', 'backgroundColor']))[0]
    const head = (await measure(t.win, '.msg--agent .msg__head', ['display', 'flexWrap', 'alignItems', 'height']))[0]
    chip.data = { viewport, state: 'reply at work', chipText, chipNameChars: chipText.length, headHeightPx: head.box.h, units: 'px and computed CSS' }
    chip.frame = await shot(t, `01-head-chip-${viewport}`, '.msg--agent:has(.session-tag) .msg__head')
    head.data = { viewport, state: 'reply at work', oneLine: head.props.flexWrap === 'nowrap', headHeightPx: head.box.h, units: 'px and computed CSS' }
    rows.push(chip, head)

    // The drawer opens on click with one reply at work; its label is the first element of the row.
    if (!(await t.win.locator('.work-drawer__list').count())) await t.win.locator('.work-drawer__head').click()
    await until(t.win, '.work-row__name')
    const nameRow = (await measure(t.win, '.work-row__name', ['display', 'fontWeight', 'whiteSpace', 'textOverflow', 'maxWidth']))[0]
    const promptRow = (await measure(t.win, '.work-row__text', ['display', 'whiteSpace', 'textOverflow']))[0]
    const prompt = (await t.win.locator('.work-row__text').first().textContent()) ?? ''
    nameRow.data = { viewport, state: 'work drawer', labelText: chipText, prompt, promptChars: prompt.length, ellipsis: prompt.endsWith('…'), nameWeight: nameRow.props.fontWeight, units: 'px, characters and computed CSS' }
    nameRow.frame = await shot(t, `02-work-drawer-${viewport}`, '.work-drawer')
    promptRow.data = { viewport, state: 'work drawer', promptChars: prompt.length, units: 'characters and computed CSS' }
    rows.push(nameRow, promptRow)

    // The thread opened from that same working row takes the reply's session name as its title.
    await t.win.locator('.work-row__thread-btn').first().click()
    await until(t.win, '.side-panel--thread .side-panel__title')
    const thread = (await measure(t.win, '.side-panel__title', ['display', 'fontWeight', 'whiteSpace']))[0]
    thread.data = { viewport, state: 'thread', titleText: (await t.win.locator('.side-panel__title').textContent())?.trim(), units: 'px and computed CSS' }
    thread.frame = await shot(t, `03-thread-title-${viewport}`, '.side-panel__head')
    rows.push(thread)

    await models(t)
    const anchors = await measure(t.win, '[data-settings-section]', ['display', 'visibility', 'opacity'])
    const allIds = await t.win.locator('[data-settings-section]').evaluateAll((els) => els.map((el) => el.getAttribute('data-settings-section')))
    const selected = (await t.win.locator('#settings-models-session-names .select__trigger__value').first().textContent())?.trim() ?? ''
    const card = (await measure(t.win, '#settings-models-session-names', ['display', 'visibility', 'opacity']))[0]
    card.data = {
      viewport,
      state: 'fallback: no model picked',
      selected,
      sectionOrder: allIds,
      memoryYpx: anchors[allIds.indexOf('knowledge-memory')]?.box.y ?? null,
      sessionNamesYpx: anchors[allIds.indexOf('models-session-names')]?.box.y ?? null,
      connectionsYpx: anchors[allIds.indexOf('connections-phone')]?.box.y ?? null,
      units: 'px, DOM order and computed CSS'
    }
    card.frame = await shot(t, `04-models-fallback-${viewport}`, '#settings-models-session-names')
    rows.push(card, ...anchors.filter((row) => ['knowledge-memory', 'models-session-names', 'connections-phone'].some((id) => row.selector.includes(id))))
    await close(t)

    // Off: seed that same temporary database, then reopen it. Old messages go too, so this is a
    // fresh reply with no name rather than one named before the setting changed.
    const db = new DatabaseSync(join(boot.data, 'tucano.db'))
    db.prepare('DELETE FROM messages').run()
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run('sessionNameModel', '"off"')
    db.close()
    const off = await open(viewport, boot.data)
    await models(off)
    const offCard = (await measure(off.win, '#settings-models-session-names', ['display', 'visibility', 'opacity']))[0]
    const offSelected = (await off.win.locator('#settings-models-session-names .select__trigger__value').first().textContent())?.trim() ?? ''
    offCard.data = { viewport, state: 'off', selected: offSelected, units: 'px and computed CSS' }
    offCard.frame = await shot(off, `05-models-off-${viewport}`, '#settings-models-session-names')
    rows.push(offCard)

    await dm(off)
    await off.win.fill('.composer textarea', 'Name this reply with the model off.')
    await off.win.keyboard.press('Enter')
    await until(off.win, '.msg--agent')
    await settle(off.win, 1500)
    const headOff = (await measure(off.win, '.msg--agent .msg__head', ['display', 'flexWrap', 'height']))[0]
    headOff.data = { viewport, state: 'off: a reply starts with no name', chipCount: await off.win.locator('.session-tag').count(), headHeightPx: headOff.box.h, units: 'px, count and computed CSS' }
    headOff.frame = await shot(off, `06-off-head-${viewport}`, '.msg--agent:last-of-type .msg__head')
    rows.push(headOff)
    await close(off)

    // The chosen model is a trio: harness, model and thinking level all visible in the card.
    const trioDb = new DatabaseSync(join(boot.data, 'tucano.db'))
    trioDb.prepare('DELETE FROM messages').run()
    for (const [key, value] of [['sessionNameModel', '"sonnet"'], ['sessionNameEffort', '"high"']]) {
      trioDb.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
    }
    trioDb.close()
    const trio = await open(viewport, boot.data)
    await models(trio)
    const trioCard = (await measure(trio.win, '#settings-models-session-names', ['display', 'visibility', 'opacity']))[0]
    const trioScope = trio.win.locator('#settings-models-session-names')
    const selects = (await trioScope.locator('.select__trigger__value').allTextContents()).map((s) => s.trim())
    trioCard.data = {
      viewport,
      state: 'chosen trio: harness, model, thinking level',
      selectValues: selects,
      effort: (await trioScope.locator('[aria-label="Reasoning effort"] .select__trigger__value').first().textContent())?.trim() ?? '',
      units: 'px and computed CSS'
    }
    trioCard.frame = await shot(trio, `07-models-trio-${viewport}`, '#settings-models-session-names')
    rows.push(trioCard)
    await close(trio)
  }

  writeFrames(undefined, rows, {
    size: SIZES.join(', '),
    data: {
      sizes: SIZES,
      viewportProof: windowProof,
      pageAndConsoleErrors: runErrors(),
      states: ['reply at work', 'work drawer', 'thread', 'fallback', 'off', 'chosen trio'],
      units: 'px, characters, count and computed CSS'
    }
  })
  console.log(`session-names: ${rows.length} measured rows across ${SIZES.length} viewports; errors=${runErrors().length}`)
}
