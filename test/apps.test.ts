import { describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { appStep, appTools, DesktopApps, grantOf, itemize, keyFor, parseLsappinfo, pick, riskyClick, riskyKey, run, typeKeys, type Cli, type Envelope } from '../src/core/apps'
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
    // The same action under a longer name counts too, once.
    apps.approved(nina, { app: 'Notas', alvo: 'Apagar Nota' })
    await apps.call(nina, 'app_ver', { app: 'Notas' })
    expect((await apps.call(nina, 'app_clicar', { app: 'Notas', alvo: 'Apagar' })).approval).toBeUndefined()
    // Once: the next one asks again.
    await apps.call(nina, 'app_ver', { app: 'Notas' })
    expect((await apps.call(nina, 'app_clicar', { app: 'Notas', alvo: 'Apagar' })).approval).toBeDefined()
    expect(apps.approved(agent([{ name: 'Notas', level: 'read' }]), del.approval!.args).ok).toBe(false)
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
    expect(calls.at(-1)).toEqual(['snapshot', '--app', 'gnome-text-editor', '-i', '--compact'])
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
