import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { inspectSettingsPlacement } from './lib/settings-placement.mjs'

// The mechanical half of the placement review: every declared section has its card, every card
// belongs to a declared section, and no key is claimed twice. The product judgement — which section
// a control belongs to, and its scope — is the one the docs record.
const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: 'boolean' } } })
const report = inspectSettingsPlacement(resolve(positionals[0] || '.'))
if (values.json) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`${report.sections} sections, ${report.ownedKeys} owned keys, ${report.renderedSections} rendered, ${report.tabs} tabs`)
  for (const failure of report.failures) console.log(`  ${failure}`)
  console.log(report.passed ? 'placement ok' : 'placement broken')
}
if (!report.passed) process.exitCode = 1
