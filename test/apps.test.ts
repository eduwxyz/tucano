import { describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { launcherDirs } from '../src/core/apps-os'
import { appStep, appTools, DesktopApps, grantOf, isAgentBrowser, isTucano, itemize, keyFor, parseLsappinfo, parseMdls, pick, riskyClick, riskyKey, run, typeKeys, type Cli, type Envelope } from '../src/core/apps'
import type { Agent } from '../src/shared/types'

// A Notes window as agent-desktop describes it.
const tree = (snap: string, note = '') => ({
  role: 'window',
  name: 'Notas',
  children: [
    { role: 'button', name: 'Nova Nota', ref_id: `@${snap}:e1`, available_actions: ['Click'] },
    { role: 'button', name: 'Apagar', ref_id: `@${snap}:e2` },
    { role: 'group', children: [{ role: 'statictext', name: 'Hoje' }, { role: 'textarea', name: 'Corpo', value: note, ref_id: `@${snap}:e3` }] },
    { role: 'row', ref_id: `@${snap}:e4`, available_actions: ['Click'], children: [{ role: 'cell', name: 'Tarefas de hoje', ref_id: `@${snap}:e5`, available_actions: ['RightClick'] }] }
  ]
})

function fakeCli(): { cli: Cli; calls: string[][] } {
  const calls: string[][] = []
  let snap = 0
  let note = ''
  let menuOpen = false
  const cli: Cli = async (args) => {
    calls.push(args)
    const ok = (data: Record<string, unknown>): Envelope => ({ ok: true, data })
    switch (args[0]) {
      case 'snapshot':
        snap++
        if (args.includes('menu') && menuOpen)
          return ok({ snapshot_id: `s${snap}`, tree: { role: 'menu', children: [{ role: 'menuitem', name: 'Duplicar Nota', ref_id: `@s${snap}:e1` }, { role: 'menuitem', name: 'Apagar', ref_id: `@s${snap}:e2` }] } })
        if (args.includes('menubar'))
          return ok({ snapshot_id: `s${snap}`, tree: { role: 'menu', children: [{ role: 'menuitem', name: 'Editar', ref_id: `@s${snap}:e1`, children: [{ role: 'menu', name: 'Editar', children: [{ role: 'menuitem', name: 'Apagar', ref_id: `@s${snap}:e2` }] }] }] } })
        return ok({ snapshot_id: `s${snap}`, window: { title: 'Notas' }, tree: tree(`s${snap}`, note) })
      case 'click':
        return ok({})
      case 'right-click':
        menuOpen = true
        return ok({})
      case 'set-value':
        note = args[2] ?? ''
        return ok({})
      case 'press':
        return ok({})
      case 'list-apps':
        return ok({ apps: [{ name: 'Notas' }, { name: 'Mail' }] })
    }
    return { ok: false, error: { message: 'unknown' } }
  }
  return { cli, calls }
}

const agent = (apps: Agent['apps']): Agent => ({ id: 'a1', name: 'Nina', handle: 'nina', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1, used: 0, grants: {}, memory: 'read', computer: false, archived: false, apps })

describe('reading an app', () => {
  it('turns the tree into a numbered list, with values and texts', () => {
    const { items, lines } = itemize(tree('s1', 'Revisar PRs'))
    expect(items.map((i) => [i.n, i.name])).toEqual([[1, 'Nova Nota'], [2, 'Apagar'], [3, 'Corpo'], [4, 'Tarefas de hoje'], [5, 'Tarefas de hoje']])
    expect(items[3]!.role).toBe('row')
    expect(lines.join('\n')).toContain('#1 botão "Nova Nota"')
    expect(lines.join('\n')).toContain('texto "Hoje"')
    expect(lines.join('\n')).toContain('#3 campo de texto "Corpo" = "Revisar PRs"')
  })

  it('finds a target by number or by text, and says when it is ambiguous', () => {
    const { items } = itemize(tree('s1'))
    expect(pick('#2', items)).toMatchObject({ name: 'Apagar' })
    expect(pick('nova nota', items)).toMatchObject({ n: 1 })
    expect(pick('#9', items)).toHaveProperty('error')
    expect(pick('xyz', items)).toHaveProperty('error')
  })

  it('retries only what agent-desktop says is safe to retry', async () => {
    let n = 0
    const flaky: Cli = async () => (++n < 3 ? { ok: false, error: { code: 'TIMEOUT', disposition: { retry: 'safe' } } } : { ok: true, data: {} })
    expect((await run(flaky, ['list-apps'], { pause: async () => {} })).ok).toBe(true)
    expect(n).toBe(3)
    let m = 0
    const broken: Cli = async () => (m++, { ok: false, error: { code: 'POLICY_DENIED', disposition: { retry: 'never' } } })
    expect((await run(broken, ['click', 'x'], { pause: async () => {} })).ok).toBe(false)
    expect(m).toBe(1)
  })
})

describe('what an agent may do with an app', () => {
  it('sees only the apps it was given, by name, ignoring case and accents', () => {
    const a = agent([{ name: 'Notas', level: 'read_write' }])
    expect(grantOf(a, 'notas')).toMatchObject({ name: 'Notas' })
    expect(grantOf(a, 'Mail')).toBeUndefined()
  })

  it('gets the tools to change things only when it may change some app', () => {
    expect(appTools(agent([{ name: 'Notas', level: 'read' }])).map((t) => t.name)).toEqual(['apps_listar', 'app_abrir', 'app_ver', 'app_menu'])
    expect(appTools(agent([{ name: 'Notas', level: 'read_write' }])).map((t) => t.name)).toContain('app_clicar')
  })

  it('refuses an app it was not given, and changes on an app it may only read', async () => {
    const { cli, calls } = fakeCli()
    const apps = new DesktopApps(cli, { platform: 'darwin' })
    const reader = agent([{ name: 'Notas', level: 'read' }])
    expect((await apps.call(reader, 'app_ver', { app: 'Mail' })).result.isError).toBe(true)
    await apps.call(reader, 'app_ver', { app: 'Notas' })
    expect((await apps.call(reader, 'app_clicar', { app: 'Notas', alvo: '#1' })).result.isError).toBe(true)
    expect(calls.filter((c) => c[0] === 'click')).toHaveLength(0)
  })

  it('clicks and writes by number or text, then reads the window again', async () => {
    const { cli, calls } = fakeCli()
    const apps = new DesktopApps(cli, { platform: 'darwin' })
    const nina = agent([{ name: 'Notas', level: 'read_write' }])
    await apps.call(nina, 'app_ver', { app: 'Notas' })
    const click = await apps.call(nina, 'app_clicar', { app: 'Notas', alvo: 'Nova Nota' })
    expect(calls.find((c) => c[0] === 'click')).toEqual(['click', '@s1:e1'])
    expect(click.detail).toBe('Nova Nota · Notas')
    const write = await apps.call(nina, 'app_escrever', { app: 'Notas', alvo: '#3', texto: 'Revisar PRs' })
    expect(calls.find((c) => c[0] === 'set-value')).toEqual(['set-value', '@s2:e3', 'Revisar PRs'])
    expect(JSON.stringify(write.result)).toContain('Revisar PRs')
  })

  it('right-clicks to open an item\'s own menu, and says when only a right click works', async () => {
    const { cli, calls } = fakeCli()
    const apps = new DesktopApps(cli, { platform: 'darwin' })
    const nina = agent([{ name: 'Notas', level: 'read_write' }])
    await apps.call(nina, 'app_ver', { app: 'Notas' })
    expect((await apps.call(nina, 'app_clicar', { app: 'Notas', alvo: '#5' })).result.isError).toBe(true)
    const menu = await apps.call(nina, 'app_clicar', { app: 'Notas', alvo: '#5', botao_direito: true })
    expect(calls.find((c) => c[0] === 'right-click')).toEqual(['right-click', '@s1:e5'])
    expect(JSON.stringify(menu.result)).toContain('Duplicar Nota')
    // Apagar in that menu still asks.
    expect((await apps.call(nina, 'app_clicar', { app: 'Notas', alvo: 'Apagar' })).approval).toBeDefined()
  })

  it('asks before a click that deletes or a key that sends, and does it once approved', async () => {
    const { cli, calls } = fakeCli()
    const apps = new DesktopApps(cli, { platform: 'darwin' })
    const nina = agent([{ name: 'Notas', level: 'read_write' }])
    await apps.call(nina, 'app_ver', { app: 'Notas' })
    const del = await apps.call(nina, 'app_clicar', { app: 'Notas', alvo: '#2', motivo: 'limpar' })
    expect(del.approval).toMatchObject({ args: { app: 'Notas', alvo: 'Apagar' }, why: 'limpar' })
    expect(calls.filter((c) => c[0] === 'click')).toHaveLength(0)
    expect((await apps.call(nina, 'app_tecla', { app: 'Notas', tecla: 'return' })).approval).toBeDefined()
    expect(riskyKey('cmd+shift+d')).toBe(true)
    expect(riskyKey('shift+cmd+d')).toBe(true)
    expect(riskyKey('Shift + Command + D')).toBe(true)
    expect(riskyKey('return')).toBe(true)
    expect(riskyKey('shift+return')).toBe(false)
    expect(riskyKey('shift+ctrl+enter')).toBe(true)
    expect(riskyKey('option+delete')).toBe(true)
    expect(riskyKey('cmd+d')).toBe(false)
    expect(riskyClick('')).toBe(true)
    expect(riskyClick('  ')).toBe(true)
    expect(riskyKey('cmd+n')).toBe(false)
    expect(riskyKey('cmd+backspace')).toBe(true)
    expect(riskyKey('alt + delete')).toBe(true)
    expect(riskyKey('backspace')).toBe(false)
    expect(riskyClick('Novo Evento')).toBe(true)
    expect(riskyClick('New Event')).toBe(true)
    expect(riskyClick('Adicionar Evento')).toBe(false)
    expect(riskyClick('Nova Nota')).toBe(false)

    // Approved: a one-time permit; the agent comes back and does it, once, without asking.
    expect(apps.approved(nina, del.approval!.args).ok).toBe(true)
    expect(calls.filter((c) => c[0] === 'click')).toHaveLength(0)
    await apps.call(nina, 'app_ver', { app: 'Notas' })
    const again = await apps.call(nina, 'app_clicar', { app: 'Notas', alvo: 'Apagar' })
    expect(again.approval).toBeUndefined()
    expect(calls.filter((c) => c[0] === 'click').at(-1)?.[1]).toMatch(/^@s\d+:e2$/)
    // Once: the next one asks again.
    await apps.call(nina, 'app_ver', { app: 'Notas' })
    expect((await apps.call(nina, 'app_clicar', { app: 'Notas', alvo: 'Apagar' })).approval).toBeDefined()
    // Only the exact element: a longer or shorter name ("Apagar Nota", "Apagar Tudo") asks again.
    apps.approved(nina, { app: 'Notas', alvo: 'Apagar Nota' })
    await apps.call(nina, 'app_ver', { app: 'Notas' })
    expect((await apps.call(nina, 'app_clicar', { app: 'Notas', alvo: 'Apagar' })).approval).toBeDefined()
    expect(apps.approved(agent([{ name: 'Notas', level: 'read' }]), del.approval!.args).ok).toBe(false)
  })

})

describe('Tucano itself', () => {
  it('is never an app an agent drives, which could click its own approval', () => {
    expect(isTucano({ name: 'Tucano' })).toBe(true)
    expect(isTucano({ name: 'Tucano.exe' })).toBe(true)
    expect(isTucano({ name: 'Electron' })).toBe(true)
    expect(isTucano({ name: 'Algo', bundleId: 'dev.tucano.app' })).toBe(true)
    expect(isTucano({ name: 'Notas', bundleId: 'com.apple.Notes' })).toBe(false)
  })
})

describe('the open apps on a Mac', () => {
  it('reads lsappinfo: only the apps with windows, by their shown name', () => {
    const out = `2) "Finder" ASN:0x0-0x1001:
    bundleID="com.apple.finder"
    pid = 600 type="Foreground" flavor=3
3) "Discord Helper" ASN:0x0-0x2002:
    bundleID="com.hnc.Discord.helper"
    pid = 700 type="UIElement" flavor=3
78) "Notas" ASN:0x0-0xaf0af0:
    bundleID="com.apple.Notes"
    pid = 15816 type="Foreground" flavor=3`
    expect(parseLsappinfo(out)).toEqual([{ name: 'Finder', bundleId: 'com.apple.finder' }, { name: 'Notas', bundleId: 'com.apple.Notes' }])
  })
})

describe('confirming and typing', () => {
  it('a Return right after writing asks to confirm what was written, and the permit then lets it through', async () => {
    const { cli, calls } = fakeCli()
    const apps = new DesktopApps(cli, { platform: 'darwin' })
    const nina = agent([{ name: 'Notas', level: 'read_write' }])
    await apps.call(nina, 'app_ver', { app: 'Notas' })
    await apps.call(nina, 'app_escrever', { app: 'Notas', alvo: '#3', texto: 'Reunião com o cliente amanhã às 15h' })
    const ask = await apps.call(nina, 'app_tecla', { app: 'Notas', tecla: 'Return' })
    expect(ask.approval).toMatchObject({ args: { app: 'Notas', tecla: 'return', texto: 'Reunião com o cliente amanhã às 15h' }, detail: 'Confirmar "Reunião com o cliente amanhã às 15h" no Notas' })
    apps.approved(nina, ask.approval!.args)
    expect((await apps.call(nina, 'app_tecla', { app: 'Notas', tecla: 'return' })).approval).toBeUndefined()
    expect(calls.filter((c) => c[0] === 'press').at(-1)).toEqual(['press', 'return', '--app', 'Notas'])
  })

  it('types key by key: letters, capitals, digits, spaces and punctuation', async () => {
    const keys: string[] = []
    const cli: Cli = async (a) => (keys.push(a[1]!), { ok: true })
    expect((await typeKeys(cli, 'Spotify', 'Lofi 24, ok.')).ok).toBe(true)
    expect(keys).toEqual(['shift+l', 'o', 'f', 'i', 'space', '2', '4', 'comma', 'space', 'o', 'k', 'period'])
  })

  it('types nothing and says so when a character has no key', async () => {
    const keys: string[] = []
    const cli: Cli = async (a) => (keys.push(a[1]!), { ok: true })
    const refused = await typeKeys(cli, 'Spotify', 'Olá joão@x')
    expect(refused.ok).toBe(false)
    expect(refused.error?.message).toMatch(/á ã @/)
    expect(keys).toEqual([])
  })
})

describe('an app with several windows', () => {
  it('reads the biggest one when the app has more than one', async () => {
    const calls: string[][] = []
    const cli: Cli = async (a) => {
      calls.push(a)
      if (a[0] === 'list-windows') return { ok: true, data: [{ id: 'w-pop', bounds: { width: 224, height: 160 } }, { id: 'w-main', bounds: { width: 1512, height: 949 } }] as unknown as Record<string, unknown> }
      if (a[0] === 'snapshot' && !a.includes('--window-id')) return { ok: false, error: { code: 'AMBIGUOUS_TARGET', disposition: { retry: 'never' } } }
      return { ok: true, data: { tree: { role: 'window', children: [{ role: 'button', name: 'Adicionar Evento', ref_id: '@s1:e1' }] } } }
    }
    const apps = new DesktopApps(cli, { platform: 'darwin' })
    const out = await apps.call(agent([{ name: 'Calendário', level: 'read' }]), 'app_ver', { app: 'Calendário' })
    expect(JSON.stringify(out.result)).toContain('Adicionar Evento')
    expect(calls.at(-1)).toContain('w-main')
  })

  it('the first click after writing a new event confirms it, whatever the button is called', async () => {
    const calls: string[][] = []
    const cli: Cli = async (a) => {
      calls.push(a)
      return { ok: true, data: { snapshot_id: 's1', tree: { role: 'window', children: [{ role: 'textfield', name: 'Novo Evento', ref_id: '@s1:e1' }, { role: 'button', name: 'Adicionar Evento', ref_id: '@s1:e2' }] } } }
    }
    const apps = new DesktopApps(cli, { platform: 'darwin' })
    const nina = agent([{ name: 'Calendário', level: 'read_write' }])
    await apps.call(nina, 'app_ver', { app: 'Calendário' })
    await apps.call(nina, 'app_escrever', { app: 'Calendário', alvo: 'Novo Evento', texto: 'Reunião com o cliente amanhã às 15h' })
    const ask = await apps.call(nina, 'app_clicar', { app: 'Calendário', alvo: 'Adicionar Evento' })
    expect(ask.approval).toMatchObject({ args: { app: 'Calendário', alvo: 'Adicionar Evento', texto: 'Reunião com o cliente amanhã às 15h' }, detail: 'Confirmar "Reunião com o cliente amanhã às 15h" no Calendário' })
    expect(calls.some((c) => c[0] === 'click')).toBe(false)
    apps.approved(nina, ask.approval!.args)
    expect((await apps.call(nina, 'app_clicar', { app: 'Calendário', alvo: 'Adicionar Evento' })).approval).toBeUndefined()
    expect(calls.filter((c) => c[0] === 'click')).toHaveLength(1)
    // Only that click: the next one is an ordinary click again.
    expect((await apps.call(nina, 'app_clicar', { app: 'Calendário', alvo: 'Adicionar Evento' })).approval).toBeUndefined()
  })
})

describe('on Windows and Linux', () => {
  const tree = { snapshot_id: 's1', tree: { role: 'window', children: [{ role: 'textfield', name: 'Editor de texto', ref_id: '@s1:e1' }, { role: 'menuitem', name: 'Excluir', ref_id: '@s1:e2' }] } }
  const fake = (apps: Record<string, unknown>[] = []): { cli: Cli; calls: string[][] } => {
    const calls: string[][] = []
    const cli: Cli = async (a) => (calls.push(a), a[0] === 'list-apps' ? { ok: true, data: { apps } } : { ok: true, data: tree })
    return { cli, calls }
  }

  it('turns ⌘ into Ctrl and ⌥ into Alt off a Mac', () => {
    expect(keyFor('cmd+n', 'win32')).toBe('ctrl+n')
    expect(keyFor('Command + Shift + Z', 'linux')).toBe('ctrl+shift+z')
    expect(keyFor('option+f', 'linux')).toBe('alt+f')
    expect(keyFor('cmd+n', 'darwin')).toBe('cmd+n')
  })

  it("finds a Linux app's program through its menu entry, and reads it by that name", async () => {
    const { cli, calls } = fake([{ name: 'gnome-text-editor', bundle_id: 'org.gnome.TextEditor.desktop', presentation: 'foreground' }])
    const apps = new DesktopApps(cli, { platform: 'linux', installed: async () => [{ name: 'Editor de texto', id: 'org.gnome.TextEditor', exec: ['gnome-text-editor'] }] })
    expect(await apps.target('Editor de texto')).toBe('gnome-text-editor')
    expect(await apps.foreground()).toEqual([{ name: 'Editor de texto', bundleId: 'org.gnome.TextEditor' }])
    await apps.call(agent([{ name: 'Editor de texto', level: 'read' }]), 'app_menu', { app: 'Editor de texto' })
    // The menu bar is part of the window there: no menubar surface.
    expect(calls.at(-1)).toEqual(['snapshot', '--app', 'gnome-text-editor', '-i', '--compact', '--timeout-ms', '15000'])
  })

  it("on Linux, reads and presses keys in the person's Chrome, not the agents' headless one of the same name", async () => {
    const calls: string[][] = []
    const windows = [
      { id: 'w-agent', pid: 10, bounds: { width: 1280, height: 800 } },
      { id: 'w-person', pid: 20, bounds: { width: 900, height: 700 } }
    ]
    const cli: Cli = async (a) => {
      calls.push(a)
      if (a[0] === 'list-apps') return { ok: true, data: { apps: [{ name: 'chrome', pid: 10, presentation: 'foreground' }, { name: 'chrome', pid: 20, presentation: 'foreground' }] } }
      if (a[0] === 'list-windows') return { ok: true, data: { windows } }
      return { ok: true, data: tree }
    }
    const chrome = { name: 'Google Chrome', id: 'google-chrome', exec: ['/usr/bin/google-chrome-stable'], chromium: true }
    const apps = new DesktopApps(cli, { platform: 'linux', installed: async () => [chrome], agentBrowser: (pid) => pid === 10 })
    apps.target = async () => 'chrome'
    expect(await apps.foreground()).toEqual([{ name: 'chrome' }])
    const nina = agent([{ name: 'Google Chrome', level: 'read_write' }])
    await apps.call(nina, 'app_ver', { app: 'Google Chrome' })
    expect(calls.at(-1)).toEqual(['snapshot', '--app', 'chrome', '-i', '--compact', '--window-id', 'w-person', '--timeout-ms', '15000'])
    await apps.call(nina, 'app_tecla', { app: 'Google Chrome', tecla: 'cmd+l' })
    expect(calls.find((c) => c[0] === 'press')).toEqual(['press', 'ctrl+l', '--app', 'chrome', '--window-id', 'w-person'])
    // Only the agents' Chrome there: says so instead of reading the wrong one.
    windows.splice(1)
    expect((await apps.call(nina, 'app_ver', { app: 'Google Chrome' })).result.isError).toBe(true)
  })

  it('on Wayland, sends a key only with the window in front, and then to the window in front', async () => {
    const calls: string[][] = []
    let focused = false
    const cli: Cli = async (a) => (calls.push(a), a[0] === 'list-windows' ? { ok: true, data: { windows: [{ id: 'w1', pid: 20, is_focused: focused }] } } : { ok: true, data: tree })
    const apps = new DesktopApps(cli, { platform: 'linux', wayland: true, agentBrowser: () => false })
    apps.target = async () => 'chrome'
    const nina = agent([{ name: 'Google Chrome', level: 'read_write' }])
    const away = await apps.call(nina, 'app_tecla', { app: 'Google Chrome', tecla: 'cmd+l' })
    expect(away.result.isError).toBe(true)
    expect(calls.some((c) => c[0] === 'press')).toBe(false)
    focused = true
    await apps.call(nina, 'app_tecla', { app: 'Google Chrome', tecla: 'cmd+l' })
    expect(calls.find((c) => c[0] === 'press')).toEqual(['press', 'ctrl+l'])
  })

  it('reads an area that repeats in the window from the last whole read', async () => {
    const page = { snapshot_id: 's1', tree: { role: 'document', children: [{ role: 'row', name: 'Colônia', ref_id: '@s1:e1', children: [{ role: 'link', name: 'Mina de Metal', ref_id: '@s1:e2' }] }] } }
    const cli: Cli = async (a) => (a.includes('--root') ? { ok: false, error: { code: 'AMBIGUOUS_TARGET', message: 'not proven unique' } } : { ok: true, data: page })
    const apps = new DesktopApps(cli, { platform: 'linux', agentBrowser: () => false })
    apps.target = async () => 'chrome'
    const nina = agent([{ name: 'Google Chrome', level: 'read' }])
    await apps.call(nina, 'app_ver', { app: 'Google Chrome' })
    const area = await apps.call(nina, 'app_ver', { app: 'Google Chrome', area: '1' })
    expect(area.result.isError).toBeFalsy()
    expect(JSON.stringify(area.result.content)).toContain('Mina de Metal')
    // And a group inside it, the same way.
    expect((await apps.call(nina, 'app_ver', { app: 'Google Chrome', area: '1' })).result.isError).toBeFalsy()
  })

  it('pages a big window without changing its numbers, and numbers an area after the list it came from', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ role: 'link', name: `Planeta ${i + 1}`, ref_id: `@s1:e${i + 1}` }))
    const page = { snapshot_id: 's1', tree: { role: 'document', children: rows } }
    const cli: Cli = async (a) => (a.includes('--root') ? { ok: true, data: { snapshot_id: 's1', tree: { role: 'group', ref_id: '@s1:e200', children: [{ role: 'link', name: 'Defesa', ref_id: '@s1:e999' }] } } } : { ok: true, data: page })
    const apps = new DesktopApps(cli, { platform: 'linux', agentBrowser: () => false })
    apps.target = async () => 'chrome'
    const nina = agent([{ name: 'Google Chrome', level: 'read_write' }])
    const first = JSON.stringify((await apps.call(nina, 'app_ver', { app: 'Google Chrome' })).result.content)
    expect(first).toContain('pagina=2')
    expect(first).toContain('os próximos com app_ver pagina=2,')
    const second = JSON.stringify((await apps.call(nina, 'app_ver', { app: 'Google Chrome', pagina: 2 })).result.content)
    expect(second).toContain('#200 link \\"Planeta 200\\"')
    expect(second).not.toContain('#1 link')
    const area = JSON.stringify((await apps.call(nina, 'app_ver', { app: 'Google Chrome', area: '200' })).result.content)
    expect(area).toContain('#251')
    // The window's own numbers still work after the area.
    expect((await apps.call(nina, 'app_ver', { app: 'Google Chrome', area: '127' })).result.isError).toBeFalsy()
  })

  it('knows a Chromium app already open under its process name, so opening it brings it forward', async () => {
    const cli: Cli = async (a) => (a[0] === 'list-apps' ? { ok: true, data: { apps: [{ name: 'chrome', pid: 20, presentation: 'foreground' }] } } : { ok: true, data: {} })
    const apps = new DesktopApps(cli, {
      platform: 'linux',
      installed: async () => [{ name: 'Google Chrome', id: 'google-chrome', exec: ['/usr/bin/google-chrome-stable'], chromium: true }],
      agentBrowser: () => false,
      exe: () => '/opt/google/chrome/chrome',
      dirs: () => ['/opt/google/chrome']
    })
    expect(await apps.foreground()).toEqual([{ name: 'Google Chrome', bundleId: 'google-chrome' }])
  })

  it('finds the process a launcher script starts under another name (google-chrome-stable → chrome)', async () => {
    const cli: Cli = async (a) => (a[0] === 'list-apps' ? { ok: true, data: { apps: [{ name: 'gnome-shell', pid: 5, presentation: 'background' }, { name: 'nautilus', pid: 6, presentation: 'foreground' }, { name: 'chrome', pid: 10, presentation: 'foreground' }, { name: 'chrome', pid: 20, presentation: 'foreground' }] } } : { ok: true, data: {} })
    const exes: Record<number, string> = { 5: '/usr/bin/gnome-shell', 6: '/usr/bin/nautilus', 10: '/opt/google/chrome/chrome', 20: '/opt/google/chrome/chrome' }
    const apps = new DesktopApps(cli, {
      platform: 'linux',
      installed: async () => [{ name: 'Google Chrome', id: 'google-chrome', exec: ['/usr/bin/google-chrome-stable'] }],
      agentBrowser: (pid) => pid === 10,
      exe: (pid) => exes[pid],
      dirs: (p) => (p === '/usr/bin/google-chrome-stable' ? ['/opt/google/chrome'] : [])
    })
    expect(await apps.target('Google Chrome')).toBe('chrome')
  })

  it('knows the agents\' Chrome by its debugging pipe', () => {
    expect(isAgentBrowser(['/opt/google/chrome/chrome', '--user-data-dir=/x', '--remote-debugging-pipe', ''].join('\0'))).toBe(true)
    expect(isAgentBrowser(['/opt/google/chrome/chrome', '--force-renderer-accessibility', ''].join('\0'))).toBe(false)
  })

  it('sends shortcuts with Ctrl, and asks first for one that deletes', async () => {
    const { cli, calls } = fake([{ name: 'gnome-text-editor', bundle_id: 'org.gnome.TextEditor.desktop' }])
    const apps = new DesktopApps(cli, { platform: 'linux', installed: async () => [{ name: 'Editor de texto', id: 'org.gnome.TextEditor', exec: ['gnome-text-editor'] }] })
    const nina = agent([{ name: 'Editor de texto', level: 'read_write' }])
    await apps.call(nina, 'app_tecla', { app: 'Editor de texto', tecla: 'cmd+n' })
    expect(calls.find((c) => c[0] === 'press')).toEqual(['press', 'ctrl+n', '--app', 'gnome-text-editor'])
    expect((await apps.call(nina, 'app_tecla', { app: 'Editor de texto', tecla: 'cmd+backspace' })).approval).toBeDefined()
  })

  it("doesn't right-click on Windows (it would move the mouse) and says what to do instead", async () => {
    const { cli, calls } = fake()
    const apps = new DesktopApps(cli, { platform: 'win32', installed: async () => [] })
    const nina = agent([{ name: 'Notepad', level: 'read_write' }])
    apps.target = async () => 'notepad'
    await apps.call(nina, 'app_ver', { app: 'Notepad' })
    const out = await apps.call(nina, 'app_clicar', { app: 'Notepad', alvo: 'Editor de texto', botao_direito: true })
    expect(out.result.isError).toBe(true)
    expect(JSON.stringify(out.result)).toContain('app_menu')
    expect(calls.some((c) => c[0] === 'right-click')).toBe(false)
  })

  it('writes on Windows by setting the value, never by keystrokes that take the keyboard', async () => {
    const { cli, calls } = fake()
    const apps = new DesktopApps(cli, { platform: 'win32', installed: async () => [] })
    apps.target = async () => 'notepad'
    const nina = agent([{ name: 'Notepad', level: 'read_write' }])
    await apps.call(nina, 'app_ver', { app: 'Notepad' })
    await apps.call(nina, 'app_escrever', { app: 'Notepad', alvo: '#1', texto: 'oi', teclando: true })
    expect(calls.some((c) => c[0] === 'focus' || c[0] === 'type' || c[0] === 'press')).toBe(false)
    expect(calls.find((c) => c[0] === 'set-value')).toEqual(['set-value', '@s1:e1', 'oi'])
  })
})

describe('labels of what happens in an app', () => {
  it('follow the language chosen, not the one at startup', () => {
    setLang('en')
    expect(appStep('app_ver', {}).label).toBe('Read')
    setLang('pt')
    expect(appStep('app_ver', {}).label).toBe('Leu')
  })
})

describe('the Mac apps, many per mdls', () => {
  it('reads two values per app from one answer', () => {
    const out = 'com.apple.Safari\0Safari\0com.apple.Notes\0Notas.app\0(null)\0(null)'
    expect(parseMdls(out, ['/Applications/Safari.app', '/System/Applications/Notes.app', '/Applications/Velho.app'])).toEqual([
      { name: 'Safari', bundleId: 'com.apple.Safari', path: '/Applications/Safari.app' },
      { name: 'Notas', bundleId: 'com.apple.Notes', path: '/System/Applications/Notes.app' },
      { name: 'Velho', path: '/Applications/Velho.app' }
    ])
  })

  it('stops where mdls stopped, at an app Spotlight can’t read', () => {
    // Its complaint comes on stdout, glued to the last value it printed.
    expect(parseMdls('com.apple.Safari\0Safari/a/Safari.app: could not find /a/Quebrado.app.\n', ['/a/Safari.app', '/a/Quebrado.app', '/a/Notes.app'])).toEqual([{ name: 'Safari', bundleId: 'com.apple.Safari', path: '/a/Safari.app' }])
    expect(parseMdls('/a/Quebrado.app: could not find /a/Quebrado.app.\n', ['/a/Quebrado.app'])).toEqual([])
  })

  it('an answer whose values don’t pair up is refused, so each app is asked alone', () => {
    expect(parseMdls('com.apple.Safari\0Safari\0com.apple.Notes', ['/a/Safari.app', '/a/Notes.app'])).toBeUndefined()
  })
})

describe('launcher folders', () => {
  it("follows a symlink, and the programs a small script execs", () => {
    const script = '#!/bin/bash\nexec /opt/google/chrome/google-chrome $CHROME_USER_FLAGS "$@"\n'
    expect(launcherDirs('/usr/bin/google-chrome-stable', { real: (p) => p, script: () => script })).toEqual(['/opt/google/chrome'])
    // A program that is itself in /usr/bin: no folder to tell it by.
    expect(launcherDirs('/usr/bin/gnome-text-editor', { real: (p) => p, script: () => undefined })).toEqual([])
    expect(launcherDirs('/usr/bin/google-chrome', { real: () => '/opt/google/chrome/google-chrome', script: () => undefined })).toEqual(['/opt/google/chrome'])
    // Shared library folders a script names don't tell its program either.
    const wrapper = '#!/bin/sh\nexport LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu/nss\nLD_PRELOAD=/usr/lib/x86_64-linux-gnu/libfoo.so /usr/lib/libbar.so exec /usr/lib/chromium/chromium "$@"\n'
    expect(launcherDirs('/usr/bin/chromium', { real: (p) => p, script: () => wrapper })).toEqual(['/usr/lib/chromium'])
  })
})
