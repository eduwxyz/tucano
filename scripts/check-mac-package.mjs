// Inspect an unsigned app bundle without launching it or accessing a keychain.
// Usage: node scripts/check-mac-package.mjs dist-ci
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { extractFile, listPackage } = createRequire(import.meta.url)('@electron/asar')
const nativePlist = (file) => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }))

// Injectable plist reader lets Linux tests validate the archive/resource assertions.
// The CLI always uses macOS plutil on the actual packaged Info.plist.
export function checkMacPackage(output, readPlist = nativePlist) {
  const bundles = readdirSync(output, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .flatMap((entry) => readdirSync(join(output, entry.name), { withFileTypes: true })
      .filter((app) => app.isDirectory() && app.name === 'Tucano.app')
      .map((app) => join(output, entry.name, app.name)))
  assert.equal(bundles.length, 1, 'Expected exactly one packaged Tucano.app')
  const contents = join(bundles[0], 'Contents')
  const plist = readPlist(join(contents, 'Info.plist'))
  assert.equal(plist.CFBundleIdentifier, 'dev.tucano.app', 'Wrong bundle identifier')
  assert.equal(plist.CFBundleExecutable, 'Tucano', 'Wrong bundle executable')
  assert.ok(plist.CFBundleURLTypes?.some((type) => type.CFBundleURLSchemes?.includes('tucano')), 'Missing tucano:// protocol registration')
  accessSync(join(contents, 'MacOS', 'Tucano'), constants.X_OK)
  const resources = join(contents, 'Resources')
  for (const file of ['app.asar', 'icon.png', 'tray.png', 'sounds/tucano-chama.wav', 'sounds/tucano-pronto.wav']) {
    const stat = statSync(join(resources, file))
    assert.ok(stat.isFile() && stat.size > 0, `Missing or empty resource: ${file}`)
  }
  const archive = join(resources, 'app.asar')
  for (const file of ['package.json', 'out/main/index.js', 'out/main/core.js', 'out/main/server.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
    assert.ok(extractFile(archive, file).length > 0, `Empty packaged file: ${file}`)
  }
  assert.equal(JSON.parse(extractFile(archive, 'package.json').toString()).main, 'out/main/index.js', 'Wrong Electron entry point')
  const files = listPackage(archive).map((file) => file.replace(/^\//, ''))
  for (const pattern of [/^out\/main\/chunks\/.+\.js$/, /^out\/renderer\/assets\/.+\.js$/, /^out\/renderer\/assets\/.+\.css$/]) {
    const matching = files.filter((file) => pattern.test(file))
    assert.ok(matching.length > 0, `Missing packaged assets: ${pattern}`)
    for (const file of matching) assert.ok(extractFile(archive, file).length > 0, `Empty packaged asset: ${file}`)
  }
  return bundles[0]
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const bundle = checkMacPackage(resolve(process.argv[2] ?? 'dist-ci'))
  console.log(`Unsigned macOS package contents and tucano:// registration verified: ${bundle}`)
}
