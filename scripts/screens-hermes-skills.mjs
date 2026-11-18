// The frames for #102: a Hermes library, with its categories, versions and facets, found and shown
// in the real app. It writes a library of its own in a temp folder and points HERMES_HOME at it, so
// nothing here depends on what this computer happens to have, and the app's real data is untouched.
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv.find((a, i) => i >= 2 && !a.startsWith('--')) ?? 'frames'
mkdirSync(out, { recursive: true })
const data = mkdtempSync(join(tmpdir(), 'tucano-'))
// A home of its own: HOME and USERPROFILE point here too, so the frame shows this library and
// nothing of the machine it runs on (a real one has 330 skills of its own).
const home = mkdtempSync(join(tmpdir(), 'hermes-home-'))

const put = (path, text) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
// "<category>/<name>/SKILL.md": the layout a Hermes library has, with the category repeated inside.
put(
  join(home, '.hermes/skills/hermes/agent-model-evaluation/SKILL.md'),
  `---
name: agent-model-evaluation
category: hermes
description: Refresh benchmarks, discover subscribed releases, qualify trials and maintain the shared pools.
version: 4.0.0
metadata:
  hermes:
    tags: [agent, evaluation, benchmarks, routing, subscriptions, "family:model-routing", "tool:api", "risk:cost"]
---
# Agent model evaluation

Read references/tables.md before proposing a pool.
`
)
put(join(home, '.hermes/skills/hermes/agent-model-evaluation/references/tables.md'), '| model | score |\n|---|---|\n| sol | 61 |\n')
put(
  join(home, '.hermes/skills/campaign/abomination-vaults/SKILL.md'),
  `---
name: abomination-vaults
category: campaign
description: The cast, the places and the light of one campaign, for character sheets and scene art.
version: 1.2.0
metadata:
  hermes:
    tags: [campaign, pathfinder, art, "family:pf2e", "artifact:image"]
---
# Abomination Vaults
`
)
// A skill with no category at all: the flat layout every other harness uses, in the same folder.
put(join(home, '.hermes/skills/imediato/SKILL.md'), '---\nname: imediato\ndescription: Responde já, sem perguntar.\n---\nCorpo.')

const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, TUCANO_DATA: data, TUCANO_SEED: '1', TUCANO_FAKE_ENGINES: '1', TUCANO_LOCALE: 'en-US', HERMES_HOME: join(home, '.hermes'), HOME: home, USERPROFILE: home }
})
const win = await app.firstWindow()
await win.setViewportSize({ width: 1280, height: 820 })
await win.waitForSelector('.sidebar')
const errors = []
win.on('pageerror', (e) => errors.push(String(e)))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
const shot = async (name) => win.screenshot({ path: `${out}/${name}.png` })

await win.click('.sidebar >> text=Skills')
await win.waitForSelector('text=Find existing skills')
await win.click('text=Find existing skills')
await win.waitForSelector('.skill-add__item')
const rows = await win.locator('.skill-add__item').count()
const heads = await win.locator('.skill-add__head').allInnerTexts()
const tags = await win.locator('.skill-add__tags').first().innerText()
await shot('01-hermes-library')

// The facets are searchable: "family:model-routing" narrows the library to the skill that carries it.
await win.fill('.skill-add .search__input input', 'family:model-routing')
await win.waitForTimeout(250)
const filtered = await win.locator('.skill-add__item').count()
await shot('02-search-by-facet')

// The same list on a narrow window: the facets wrap instead of running off the row.
await win.setViewportSize({ width: 420, height: 820 })
await win.fill('.skill-add .search__input input', '')
await win.waitForTimeout(250)
const overflow = await win.locator('.skill-add__item').last().evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
await shot('03-narrow')

// A skill with a category is picked like any other, and the step says what it is.
await win.setViewportSize({ width: 1280, height: 820 })
await win.locator('.skill-add__item').first().click()
await win.waitForTimeout(200)
const step = await win.locator('.skill-add__step h3').innerText()
const stepBody = await win.locator('.skill-add__step').innerText()
await shot('04-picked')

console.log(JSON.stringify({ rows, heads, tags, filtered, step, stepBody: stepBody.slice(0, 300), overflow, errors }, null, 2))
await app.close()
