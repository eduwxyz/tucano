#!/usr/bin/env node
// pre-go — what a testing checkout gets before anything runs.
//
//   node scripts/pre-go.mjs                  set this checkout up
//   node scripts/pre-go.mjs --check          only say whether it is ready (exit 1 if not)
//   node scripts/pre-go.mjs --from <dir>     borrow node_modules from another checkout
//   node scripts/pre-go.mjs --unset          take back what it put there
//   node scripts/pre-go.mjs --root <dir>     work on another checkout (used by the tests)
//   node scripts/pre-go.mjs --run <command>  set up, then run a command on the testing model
//
// It does two things, both local and both safe to run twice:
//
//   1. node_modules — a checkout without one is linked to a sibling checkout's install
//      (a junction on Windows), so a fresh worktree tests in seconds instead of an npm ci.
//   2. the testing contract — .pre-go.json records what this checkout runs on: the core model
//      from test/testing.json (DeepSeek 4.1 Flash through Pi), fake engines, a temp data folder.
//      Every checkout therefore runs on the same model, and none of them assumes Claude. What the
//      core reads is TUCANO_TEST_MODEL (src/core/testing-model.ts): it becomes routerModel,
//      memoryModel and the seeded team's model, so a run here has a model that answers.
//
// It never installs anything, never touches the network, and never writes outside the checkout.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const MARK = '.pre-go.json'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : (args[i + 1] ?? '')
}
const root = resolve(flag('--root') ?? process.cwd())
const check = args.includes('--check')
const unset = args.includes('--unset')
const from = flag('--from')

const say = (line = '') => console.log(line)
const stop = (line) => {
  console.error(line)
  process.exit(1)
}

if (!existsSync(join(root, 'package.json'))) stop(`pre-go: ${root} is not a checkout — no package.json in it.`)

// The checking model comes from the checkout itself, so the script and the suite can't drift.
const setupFile = join(root, 'test', 'testing.json')
if (!existsSync(setupFile)) stop(`pre-go: ${setupFile} is missing — it names the model a test runs on.`)
const model = JSON.parse(readFileSync(setupFile, 'utf8')).coreModel
if (typeof model !== 'string' || !model) stop('pre-go: test/testing.json has no coreModel.')

const modules = join(root, 'node_modules')
const markFile = join(root, MARK)

// Where a checkout without an install can borrow one.
function source() {
  const tried = []
  const look = (p) => {
    if (!p) return undefined
    tried.push(p)
    return existsSync(join(p, '.bin', 'vitest')) || existsSync(join(p, 'vitest')) ? p : undefined
  }
  const given = look(from ? resolve(from, 'node_modules') : from)
  if (given) return given
  if (from) stop(`pre-go: no node_modules in ${resolve(from)}.\n  Tried: ${tried.join(', ')}`)
  const known = look(process.env.TUCANO_TEST_NODE_MODULES)
  if (known) return known
  const beside = dirname(root)
  for (const name of ['tucano-wrench', 'tucano-fork', 'tucano-asks']) {
    const found = look(join(beside, name, 'node_modules'))
    if (found) return found
  }
  return undefined
}

function link(target, sourcePath) {
  if (process.platform === 'win32') execFileSync('cmd', ['/c', 'mklink', '/J', target, sourcePath], { stdio: 'pipe' })
  else symlinkSync(sourcePath, target, 'junction')
}

function readMark() {
  try {
    return JSON.parse(readFileSync(markFile, 'utf8'))
  } catch {
    return undefined
  }
}

if (unset) {
  const mark = readMark()
  if (mark?.nodeModules?.linkedFrom && existsSync(modules)) {
    // The link only: rmdir on a junction removes the link and leaves the install it points at.
    if (process.platform === 'win32') execFileSync('cmd', ['/c', 'rmdir', modules], { stdio: 'pipe' })
    else rmSync(modules, { force: true })
    say(`pre-go: unlinked node_modules (the install in ${mark.nodeModules.linkedFrom} is untouched).`)
  }
  rmSync(markFile, { force: true })
  say('pre-go: mark removed.')
  process.exit(0)
}

const install = existsSync(join(modules, 'vitest')) || existsSync(join(modules, '.bin', 'vitest'))

if (check) {
  const mark = readMark()
  const lines = []
  lines.push(`checkout     ${root}`)
  lines.push(`node_modules ${install ? 'ready' : 'MISSING'}`)
  lines.push(`core model   ${model}${mark?.model ? (mark.model === model ? ' (as marked)' : ` (marked ${mark.model} — rerun without --check)`) : ' (not marked yet)'}`)
  lines.push(`fake engines ${mark ? 'on' : 'unmarked'}`)
  say(lines.join('\n'))
  process.exit(install && mark?.model === model ? 0 : 1)
}

let linkedFrom
if (!install) {
  linkedFrom = source()
  if (!linkedFrom) {
    stop(
      `pre-go: this checkout has no node_modules and there is no install beside it to borrow.\n` +
        `  Run npm ci here, or: node scripts/pre-go.mjs --from <a checkout that has one>`
    )
  }
  link(modules, linkedFrom)
}

writeFileSync(
  markFile,
  JSON.stringify(
    {
      checkout: root,
      model,
      fakeEngines: true,
      data: 'temp', // every test makes its own TUCANO_DATA folder
      env: { TUCANO_TEST_MODEL: model, TUCANO_FAKE_ENGINES: '1' },
      nodeModules: linkedFrom ? { path: modules, linkedFrom } : { path: modules },
      node: process.version,
      at: new Date().toISOString()
    },
    null,
    2
  ) + '\n'
)

say(`pre-go: ${root}`)
say(`  node_modules  ${linkedFrom ? `linked to ${linkedFrom}` : 'already there'}`)
say(`  core model    ${model}`)
say(`  engines       fake (TUCANO_FAKE_ENGINES=1), data folder per test`)
say('  ready: npm test')

// Run something with the contract in its environment — the only way a shell gets these variables
// from here, short of asking the person to export two lines by hand.
const runAt = args.indexOf('--run')
if (runAt !== -1) {
  const command = args.slice(runAt + 1)
  if (!command.length) stop('pre-go: --run needs a command, e.g. --run npm run dev')
  const env = { ...process.env, TUCANO_TEST_MODEL: model, TUCANO_FAKE_ENGINES: process.env.TUCANO_FAKE_ENGINES ?? '1' }
  const dataAt = flag('--data')
  if (dataAt) env.TUCANO_DATA = resolve(dataAt)
  // On Windows the command has to go through the shell (npm and npx are .cmd there), and the shell
  // re-splits what it gets: an argument with a space in it stays whole only if it is quoted again.
  const win = process.platform === 'win32'
  const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)
  const file = win ? command.map(quote).join(' ') : command[0]
  const argv = win ? [] : command.slice(1)
  say(`pre-go: running ${command.join(' ')}${dataAt ? ` on ${env.TUCANO_DATA}` : ''}`)
  const child = spawnSync(file, argv, { stdio: 'inherit', env, shell: win })
  process.exit(child.status ?? 1)
}
