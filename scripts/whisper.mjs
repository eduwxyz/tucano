#!/usr/bin/env node
// The whisper-cli that dictation runs, packed inside the app so nobody has to install it:
// build/whisper/<os>-<arch>/, which electron-builder copies to Resources/whisper.
//
//   node scripts/whisper.mjs mac arm64     builds it from whisper.cpp's source (Metal, static)
//   node scripts/whisper.mjs win x64       takes whisper.cpp's own build of the same version
//   node scripts/whisper.mjs linux x64|arm64
//
// Same version everywhere. A download is checked against its SHA-256 before it's opened.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const TAG = 'v1.9.5' // the source, for the Mac
const BUILD = 'b5454' // whisper.cpp's own binaries of that version, for Windows and Linux
const PREBUILT = {
  'win-x64': { file: 'whisper-bin-x64.zip', sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb' },
  'linux-x64': { file: 'whisper-bin-ubuntu-x64.tar.gz', sha256: 'a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c' },
  'linux-arm64': { file: 'whisper-bin-ubuntu-arm64.tar.gz', sha256: '6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149' }
}

const [os, arch] = process.argv.slice(2)
const target = `${os}-${arch}`
const root = join(import.meta.dirname, '..')
const out = join(root, 'build', 'whisper', target)
const stamp = join(out, 'VERSION')
const want = os === 'mac' ? TAG : BUILD
if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === want) {
  console.log(`whisper-cli ${want} for ${target}: already there`)
  process.exit(0)
}
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts })
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

if (os === 'mac') {
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`no Mac build for ${arch}`)
  const cache = join(homedir(), 'Library', 'Caches', 'tucano')
  // cmake: the one on the PATH, or one kept in a venv of our own (nothing installed system-wide)
  let cmake = 'cmake'
  try {
    execFileSync(cmake, ['--version'], { stdio: 'ignore' })
  } catch {
    const venv = join(cache, 'cmake-venv')
    cmake = join(venv, 'bin', 'cmake')
    if (!existsSync(cmake)) {
      run('python3', ['-m', 'venv', venv])
      run(join(venv, 'bin', 'pip'), ['install', '-q', 'cmake'])
    }
  }
  const src = join(cache, `whisper.cpp-${TAG}`)
  if (!existsSync(join(src, 'CMakeLists.txt'))) run('git', ['clone', '-q', '--depth', '1', '--branch', TAG, 'https://github.com/ggml-org/whisper.cpp.git', src])
  const dir = join(src, `build-${arch}`)
  const flags = [
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_OSX_ARCHITECTURES=${arch === 'x64' ? 'x86_64' : 'arm64'}`,
    '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0',
    '-DBUILD_SHARED_LIBS=OFF', // one file, nothing to load beside it
    '-DGGML_METAL=ON',
    '-DGGML_METAL_EMBED_LIBRARY=ON',
    '-DGGML_NATIVE=OFF', // for every Mac of that kind, not just this one
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_SERVER=OFF',
    '-DWHISPER_SDL2=OFF',
    ...(arch === 'x64' ? ['-DGGML_AVX=ON', '-DGGML_AVX2=ON', '-DGGML_FMA=ON', '-DGGML_F16C=ON'] : [])
  ]
  run(cmake, ['-S', src, '-B', dir, ...flags], { stdio: 'ignore' })
  run(cmake, ['--build', dir, '--config', 'Release', '-j', '8', '--target', 'whisper-cli'], { stdio: 'ignore' })
  copyFileSync(join(dir, 'bin', 'whisper-cli'), join(out, 'whisper-cli'))
} else {
  const pre = PREBUILT[target]
  if (!pre) throw new Error(`no whisper-cli for ${target}`)
  const tmp = mkdtempSync(join(tmpdir(), 'whisper-'))
  try {
    const file = join(tmp, pre.file)
    run('curl', ['-fsSL', '-o', file, `https://github.com/ggml-org/whisper.cpp/releases/download/${BUILD}/${pre.file}`])
    const got = createHash('sha256').update(readFileSync(file)).digest('hex')
    if (got !== pre.sha256) throw new Error(`${pre.file}: SHA-256 ${got}, expected ${pre.sha256}`)
    // Windows' own unzip: the tar first on a runner's PATH is Git's, which reads "C:" as a host and opens no .zip
    if (os === 'win') run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${file}' -DestinationPath '${tmp}' -Force`])
    else run('tar', ['-xf', file, '-C', tmp])
    // the program and the libraries it loads from its own folder; not the tests, benchmarks or server
    const from = readdirSync(tmp, { withFileTypes: true }).find((e) => e.isDirectory())
    if (!from) throw new Error(`${pre.file} has no folder`)
    const dir = join(tmp, from.name)
    // on Linux, the names whisper-cli asks for (each library is there three times, by its links)
    // and the CPU variants ggml picks from at start
    const keep = (n) => (os === 'win' ? n === 'whisper-cli.exe' || n.endsWith('.dll') : n === 'whisper-cli' || /^lib(whisper|ggml|ggml-base)\.so\.\d+$/.test(n) || /^libggml-cpu-[\w-]+\.so$/.test(n))
    for (const n of readdirSync(dir).filter(keep)) copyFileSync(join(dir, n), join(out, n))
    if (!existsSync(join(out, os === 'win' ? 'whisper-cli.exe' : 'whisper-cli'))) throw new Error(`${pre.file} has no whisper-cli`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
writeFileSync(stamp, `${want}\n`)
console.log(`whisper-cli ${want} for ${target}: ${out}`)
