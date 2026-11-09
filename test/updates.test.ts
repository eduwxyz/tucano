import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { app, updater } = vi.hoisted(() => {
  const { EventEmitter: Emitter } = require('node:events') as { EventEmitter: typeof EventEmitter }
  return {
    app: Object.assign(new Emitter(), { isPackaged: true, getVersion: () => '1.0.0' }),
    updater: Object.assign(new Emitter(), {
      logger: undefined as unknown,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      checkForUpdates: undefined as unknown as ReturnType<typeof vi.fn>,
      quitAndInstall: undefined as unknown as ReturnType<typeof vi.fn>
    })
  }
})

vi.mock('electron', () => ({ app }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }))

import { Updates } from '../src/main/updates'

describe('installing an update from an AppImage', () => {
  let dir: string
  let file: string
  let updates: Updates
  const appImageBefore = process.env['APPIMAGE']

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tucano-updates-'))
    file = join(dir, 'tucano-linux-x86_64.AppImage')
    writeFileSync(file, 'new version')
    process.env['APPIMAGE'] = join(dir, 'Tucano.AppImage')
    app.removeAllListeners()
    updater.removeAllListeners()
    updater.checkForUpdates = vi.fn(() => Promise.resolve(null))
    updater.quitAndInstall = vi.fn()
    updates = new Updates(() => {})
    updater.emit('update-downloaded', { version: '2.0.0', downloadedFile: file })
  })

  afterEach(() => {
    if (appImageBefore === undefined) delete process.env['APPIMAGE']
    else process.env['APPIMAGE'] = appImageBefore
    rmSync(dir, { recursive: true, force: true })
  })

  it('still installs on quit while the download is there', () => {
    app.emit('will-quit')
    expect(updater.autoInstallOnAppQuit).toBe(true)
  })

  it('does not install on quit once the download is gone', () => {
    rmSync(file)
    app.emit('will-quit')
    expect(updater.autoInstallOnAppQuit).toBe(false)
  })

  it('still restarts into the update while the download is there', () => {
    updates.install()
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('downloads again, instead of restarting, once the download is gone', () => {
    rmSync(file)
    updates.install()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    expect(updates.get().status).toBe('idle')
  })

  it('leaves other package formats to their own installers', () => {
    delete process.env['APPIMAGE']
    rmSync(file)
    app.emit('will-quit')
    updates.install()
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
  })
})
