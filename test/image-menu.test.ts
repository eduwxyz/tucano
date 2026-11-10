// A right-click on a picture: what the menu offers where, the name it's saved under, and the way a
// picture leaves the app (saved, copied) or comes back in as an attachment to the next message.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeImageMenu,
  folderLabel,
  imageActions,
  imageFileName,
  imageMenuState,
  openImageMenu,
  subscribeImageMenu
} from '../src/renderer/src/image-menu'
import { attachToComposer, composerListenerCount, onComposerImages } from '../src/renderer/src/composer-attach'
import { artifactImagePath, fileNameFor, freeName, imageBytesOf, mimeOfImage, MAX_IMAGE_BYTES } from '../src/main/image-bytes'
import { settingsPatchError } from '../src/core/settings-patch'
import { isPersonalSetting } from '../src/core/policy-people'

const DATA = 'C:/Users/someone/Tucano Dev'

describe('what a right-clicked picture offers', () => {
  it('in a reply: save, clipboard, and back into the prompt below', () => {
    expect(imageActions('reply')).toEqual(['save', 'clipboard', 'prompt'])
  })

  it('in the album: the two ways out of the app, and not the prompt', () => {
    // Full window, there is no prompt under it to copy into.
    expect(imageActions('gallery')).toEqual(['save', 'clipboard'])
    expect(imageActions('gallery')).not.toContain('prompt')
  })

  it('before anything was saved: only the dialog, never a folder it was not told', () => {
    expect(imageActions('reply', false)).toEqual(['save', 'clipboard', 'prompt'])
    expect(imageActions('reply', false)).not.toContain('save-here')
  })

  it('once a folder is remembered: one click into it, then the dialog, then the rest', () => {
    expect(imageActions('reply', true)).toEqual(['save-here', 'save', 'clipboard', 'prompt'])
    expect(imageActions('gallery', true)).toEqual(['save-here', 'save', 'clipboard'])
  })
})

describe('the folder a picture is saved to', () => {
  it('is named by its own name, capitalised', () => {
    expect(folderLabel('C:\\Users\\theap\\Downloads')).toBe('Downloads')
    expect(folderLabel('C:/Users/theap/Pictures/Screenshots')).toBe('Screenshots')
    expect(folderLabel('C:\\Users\\theap\\shots')).toBe('Shots')
    expect(folderLabel('/home/someone/pictures/')).toBe('Pictures')
  })

  it('says what Windows calls a drive that has no name of its own', () => {
    expect(folderLabel('C:\\')).toBe('Local Disk (C:)')
    expect(folderLabel('d:')).toBe('Local Disk (D:)')
    expect(folderLabel('')).toBe('')
  })

  it('can be remembered at all: the core takes the setting, and it belongs to the person', () => {
    expect(settingsPatchError({ lastImageFolder: 'C:/Users/theap/Pictures' })).toBeUndefined()
    expect(isPersonalSetting('lastImageFolder')).toBe(true)
  })

  it('never takes a name already in the folder', () => {
    const taken = new Set(['shot.png', 'shot (2).png'])
    const ask = (n: string): boolean => taken.has(n)
    expect(freeName('other.png', ask)).toBe('other.png')
    expect(freeName('shot.png', ask)).toBe('shot (3).png')
    // The extension stays where it was, and a name with no extension still gets a number.
    expect(freeName('shot.png', (n) => n === 'shot.png')).toBe('shot (2).png')
    expect(freeName('notes', (n) => n === 'notes')).toBe('notes (2)')
    // A folder that answers yes to everything still gets a name rather than an overwrite.
    expect(freeName('shot.png', () => true)).not.toBe('shot.png')
  })
})

describe('the name it is saved under', () => {
  it("keeps the picture's own extension, and takes one when the URL has none", () => {
    expect(imageFileName('Screenshot 2026-11-10', 'tucano://artifact/abc/shot.PNG')).toBe('Screenshot 2026-11-10.png')
    expect(imageFileName('Diagram', 'tucano://artifact/abc/diagram.jpg')).toBe('Diagram.jpg')
    expect(imageFileName('No extension here', 'tucano://artifact/abc/file')).toBe('No extension here.png')
  })

  it('never turns a title into a path', () => {
    expect(imageFileName('../../settings', 'tucano://artifact/abc/a.png')).toBe('settings.png')
    expect(imageFileName('C:\\Windows\\system32', 'tucano://artifact/abc/a.png')).toBe('C Windows system32.png')
    expect(imageFileName('a:b*c?d"e<f>g|h', 'tucano://artifact/abc/a.png')).toBe('a b c d e f g h.png')
    expect(imageFileName('', 'tucano://artifact/abc/a.png')).toBe('image.png')
  })

  it('keeps one extension when the title already has it', () => {
    expect(imageFileName('pic.png', 'tucano://artifact/abc/pic.png')).toBe('pic.png')
    expect(imageFileName('pic.PNG', 'tucano://artifact/abc/pic.png')).toBe('pic.png')
    // A title that ends in another extension keeps both, because that one is part of its name.
    expect(imageFileName('report.pdf', 'tucano://artifact/abc/shot.png')).toBe('report.pdf.png')
  })

  it('offers the same kind of name from the main process', () => {
    expect(fileNameFor('Screenshot 2026-11-10', 'tucano://artifact/abc/shot.png')).toBe('Screenshot 2026-11-10.png')
    expect(fileNameFor('../../etc/passwd', 'tucano://artifact/abc/a.png')).not.toContain('/')
    expect(fileNameFor('', 'tucano://artifact/abc/a.webp')).toBe('image.webp')
    expect(fileNameFor('pic.png', 'tucano://artifact/abc/pic.png')).toBe('pic.png')
  })
})

describe('which file a picture URL may reach', () => {
  const id = '11111111-2222-3333-4444-555555555555'

  it('an artifact of this workspace, and nothing else', () => {
    expect(artifactImagePath(DATA, `tucano://artifact/${id}/shot.png`)).toBe(join(DATA, 'artifacts', id, 'shot.png'))
    // An artifact is one file in its own folder: a name with a folder in it is not one of ours.
    expect(artifactImagePath(DATA, `tucano://artifact/${id}/sub/shot.png`)).toBeNull()
  })

  it('refuses to walk out of it, whatever the name says', () => {
    expect(artifactImagePath(DATA, `tucano://artifact/${id}/../../settings.json`)).toBeNull()
    expect(artifactImagePath(DATA, `tucano://artifact/${id}/%2e%2e%2f%2e%2e%2fsettings.json`)).toBeNull()
    expect(artifactImagePath(DATA, `tucano://artifact/${id}/..%2F..%2Fsettings.json`)).toBeNull()
    expect(artifactImagePath(DATA, `tucano://artifact/${id}/`)).toBeNull()
  })

  it('refuses another host, another scheme, or something that is not an artifact id', () => {
    expect(artifactImagePath(DATA, `tucano://local/${id}/shot.png`)).toBeNull()
    expect(artifactImagePath(DATA, 'https://example.com/shot.png')).toBeNull()
    expect(artifactImagePath(DATA, `tucano://artifact/not-an-id/shot.png`)).toBeNull()
    expect(artifactImagePath(DATA, 'not a url at all')).toBeNull()
  })
})

describe('the bytes, read in the main process', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tucano-image-'))
  })

  it('reads a picture the workspace keeps', async () => {
    const id = '11111111-2222-3333-4444-555555555555'
    const folder = join(dir, 'artifacts', id)
    mkdirSync(folder, { recursive: true })
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('the rest')])
    writeFileSync(join(folder, 'shot.png'), png)
    const got = await imageBytesOf(`tucano://artifact/${id}/shot.png`, (u) => artifactImagePath(dir, u))
    expect(got?.equals(png)).toBe(true)
  })

  it('reads a picture the page already has (a data URL)', async () => {
    const png = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    const got = await imageBytesOf(`data:image/jpeg;base64,${png.toString('base64')}`)
    expect(got?.equals(png)).toBe(true)
    expect(await imageBytesOf('data:image/jpeg,notbase64')).toBeNull()
  })

  it('gives nothing for a file that is not there, or for a folder', async () => {
    expect(await imageBytesOf(`tucano://artifact/${'1'.repeat(8)}-2222-3333-4444-555555555555/gone.png`, (u) => artifactImagePath(dir, u))).toBeNull()
    mkdirSync(join(dir, 'artifacts', '22222222-2222-3333-4444-555555555555'), { recursive: true })
    expect(await imageBytesOf('tucano://artifact/22222222-2222-3333-4444-555555555555/folder', (u) => artifactImagePath(dir, u))).toBeNull()
    expect(await imageBytesOf('https://example.com/shot.png')).toBeNull()
  })

  it('has a ceiling, so a strange URL cannot fill the memory', () => {
    expect(MAX_IMAGE_BYTES).toBe(64 * 1024 * 1024)
  })
})

describe('what the clipboard is told it is holding', () => {
  it('reads the kind from the bytes, not from the name', () => {
    expect(mimeOfImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(mimeOfImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(mimeOfImage(Buffer.from('GIF89a....', 'latin1'))).toBe('image/gif')
    expect(mimeOfImage(Buffer.from('RIFF....WEBPVP8 ', 'latin1'))).toBe('image/webp')
    expect(mimeOfImage(Buffer.from('<!doctype html>', 'latin1'))).toBeNull()
  })
})

describe('a picture copied into the prompt', () => {
  it('reaches the field of that conversation, and only while one is open', () => {
    expect(attachToComposer('ch1', [{ name: 'a.png', mime: 'image/png', data: 'AA', url: 'tucano://artifact/x/a.png' }])).toBe(0)
    const got: string[] = []
    const stop = onComposerImages('ch1', (imgs) => got.push(...imgs.map((i) => i.name)))
    expect(composerListenerCount('ch1')).toBe(1)
    expect(attachToComposer('ch1', [{ name: 'shot.png', mime: 'image/png', data: 'AA', url: 'tucano://artifact/x/shot.png' }])).toBe(1)
    expect(got).toEqual(['shot.png'])
    // Another conversation's field never sees it.
    expect(attachToComposer('ch2', [{ name: 'other.png', mime: 'image/png', data: 'AA', url: 'u' }])).toBe(0)
    stop()
    expect(composerListenerCount('ch1')).toBe(0)
    expect(attachToComposer('ch1', [{ name: 'late.png', mime: 'image/png', data: 'AA', url: 'u' }])).toBe(0)
  })

  it('never sends an empty one', () => {
    const seen = vi.fn()
    const stop = onComposerImages('ch1', seen)
    expect(attachToComposer('ch1', [])).toBe(0)
    expect(seen).not.toHaveBeenCalled()
    stop()
  })
})

describe('the menu itself', () => {
  it('is open where it was asked for, and closed again', () => {
    expect(imageMenuState()).toBeNull()
    const told = vi.fn()
    const stop = subscribeImageMenu(told)
    openImageMenu({ url: 'tucano://artifact/x/a.png', title: 'A', surface: 'reply', conversationId: 'ch1' }, { x: 40, y: 60 })
    expect(imageMenuState()).toMatchObject({ x: 40, y: 60, target: { title: 'A', surface: 'reply' } })
    expect(told).toHaveBeenCalledTimes(1)
    closeImageMenu()
    expect(imageMenuState()).toBeNull()
    expect(told).toHaveBeenCalledTimes(2)
    closeImageMenu() // already closed: nothing to say twice
    expect(told).toHaveBeenCalledTimes(2)
    stop()
  })
})
