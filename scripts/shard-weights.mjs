// Writes test/shard-weights.json: how long each test file took on each system in one CI run, which is
// what test/helpers/shards.ts splits the tests by. Run it again when one machine of a pull request
// takes much longer than the others (a new heavy test file, or tests that moved).
//
//   node scripts/shard-weights.mjs            the last CI run that passed on main
//   node scripts/shard-weights.mjs 45520079143   that run
//
// Needs the GitHub CLI (gh), signed in.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
const SYSTEMS = { ubuntu: 'linux', macos: 'darwin', windows: 'win32' }
// Files quicker than this are left out, and count as quick ones (UNKNOWN in shards.ts).
const LEAST_SECONDS = 1

const run = process.argv[2] ?? JSON.parse(gh('run', 'list', '--workflow=ci.yml', '--branch=main', '--status=success', '--limit=1', '--json=databaseId'))[0]?.databaseId
if (!run) throw new Error('no CI run to read')

const { jobs } = JSON.parse(gh('api', `repos/{owner}/{repo}/actions/runs/${run}/jobs?per_page=100`))
const weights = {}
for (const job of jobs) {
  const system = SYSTEMS[job.name.split('-')[0]]
  if (!system) continue
  const log = gh('api', `repos/{owner}/{repo}/actions/jobs/${job.id}/logs`).replace(/\x1b\[[0-9;]*m/g, '')
  // " ✓ test/threads.test.ts (24 tests | 2 skipped) 76927ms"
  for (const [, file, ms] of log.matchAll(/^\S+\s+\S\s+(test\/\S+)\s+\(\d+ tests?[^)]*\)\s+(\d+)\s*ms/gm)) {
    const seconds = Math.round(Number(ms) / 1000)
    if (seconds >= LEAST_SECONDS) (weights[system] ??= {})[file] = seconds
  }
}

const sorted = Object.fromEntries(
  Object.keys(weights).sort().map((system) => [system, Object.fromEntries(Object.entries(weights[system]).sort(([a], [b]) => (a < b ? -1 : 1)))])
)
writeFileSync(new URL('../test/shard-weights.json', import.meta.url), JSON.stringify(sorted, null, 2) + '\n')
for (const [system, files] of Object.entries(sorted)) {
  const total = Object.values(files).reduce((a, b) => a + b, 0)
  console.log(`${system}: ${Object.keys(files).length} files of ${LEAST_SECONDS} s or more, ${total} s in all (run ${run})`)
}
