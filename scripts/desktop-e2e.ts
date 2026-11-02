// The apps feature end to end on a real desktop, the way an agent uses it (no model): the
// system's own app list, then a text editor opened, read, written into and read back.
// Runs in CI on Windows and Linux (see .github/workflows/desktop-apps.yml); by hand too:
//   npx -y tsx scripts/desktop-e2e.ts
import { agentDesktop, DesktopApps } from '../src/core/apps'
import { linuxApps, windowsApps } from '../src/core/apps-os'
import type { Agent } from '../src/shared/types'

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}
const ok = (msg: string): void => console.log(`✓ ${msg}`)
const text = (r: { result: { content?: unknown[] } }): string => (r.result.content ?? []).map((c) => (c as { text?: string }).text ?? '').join('\n')

const platform = process.platform
const t0 = Date.now()
const installed = platform === 'win32' ? await windowsApps() : platform === 'linux' ? linuxApps() : fail('Windows or Linux only (the Mac is tested by hand)')
ok(`${installed.length} apps in the system's menu, in ${Date.now() - t0} ms: ${installed.slice(0, 12).map((a) => a.name).join(', ')}…`)
const withIcon = installed.filter((a) => a.icon || a.path).length
ok(`${withIcon} of them with an icon (or a program to draw it from)`)

const wanted = platform === 'win32' ? /^(notepad|bloco de notas)$/i : /^(text editor|editor de texto|gedit|mousepad)$/i
const editor = installed.find((a) => wanted.test(a.name)) ?? fail(`no text editor among: ${installed.map((a) => a.name).join(', ')}`)
ok(`the editor: ${JSON.stringify({ ...editor, icon: editor.icon ? `${editor.icon.slice(0, 30)}…` : undefined })}`)

const apps = new DesktopApps(agentDesktop(), { installed: async () => installed })
const status = await apps.status()
ok(`agent-desktop ${status.version}, accessibility ${status.accessibility}${status.suggestion ? ` (${status.suggestion})` : ''}`)
if (!status.installed) fail('agent-desktop not installed')

const nina = { id: 'e2e', name: 'Nina', apps: [{ name: editor.name, level: 'read_write' }] } as unknown as Agent
const call = async (tool: string, args: Record<string, unknown>): Promise<string> => {
  const r = await apps.call(nina, tool, { app: editor.name, ...args })
  const out = text(r)
  console.log(`\n── ${tool} ${JSON.stringify(args)}${r.result.isError ? ' (error)' : ''}${r.approval ? ' (asks approval)' : ''}\n${out.split('\n').slice(0, 40).join('\n')}`)
  if (r.result.isError) fail(`${tool} failed`)
  return out
}

await call('app_abrir', {})
ok(`opened; agent-desktop knows it as "${await apps.target(editor.name, true)}"`)
const open = await apps.foreground()
if (!open.some((a) => a.name === editor.name)) fail(`not among the open apps: ${open.map((a) => a.name).join(', ')}`)
ok(`among the open apps, by its menu name: ${open.map((a) => a.name).join(', ')}`)

const seen = await call('app_ver', {})
const field = /#(\d+) (campo|field|campo de texto|text area|documento|document)\b/.exec(seen) ?? fail('no text field in the window')
const marker = `Tucano e2e ${Date.now()}`
await call('app_escrever', { alvo: `#${field[1]}`, texto: marker })
const after = await call('app_ver', {})
if (!after.includes(marker)) fail('the text written is not in the window')
ok('wrote into the editor and read it back')

await call('app_menu', {})
ok('read the menus')

// Return after writing asks first (it could send), here as everywhere.
const r = await apps.call(nina, 'app_tecla', { app: editor.name, tecla: 'return' })
if (!r.approval) fail('Return after writing should ask for approval')
ok('Return after writing asks for approval')

console.log(`\nall good in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
process.exit(0)
