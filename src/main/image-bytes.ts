// The picture under a right-click, on its way out of the app: the bytes are read here, in the main
// process, and never by the page. A page can ask for a file name and a URL; what it gets back is a
// path inside the workspace's own artifacts, or nothing.
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'

// A picture bigger than this is not a picture anyone right-clicked by accident.
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024

const EXT_OK = /\.(png|jpe?g|gif|webp|avif|svg)$/i

// `tucano://artifact/<id>/<name>` → the file the workspace keeps, or null for anything else.
// The name is decoded and normalised, and the result has to stay inside that artifact's folder: a
// name like `../../settings.json` gets nothing.
export function artifactImagePath(dataDir: string, url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'tucano:' || u.host !== 'artifact') return null
  // An artifact is one file in its own folder: anything with a folder in the name is not ours, and
  // neither is a name that only becomes one after decoding (%2F).
  const slash = u.pathname.indexOf('/', 1)
  if (slash < 0) return null
  const id = u.pathname.slice(1, slash)
  let decoded: string
  try {
    decoded = decodeURIComponent(u.pathname.slice(slash + 1))
  } catch {
    return null
  }
  if (!/^[0-9a-f-]{36}$/.test(id) || !decoded || /[\/]/.test(decoded)) return null
  const dir = join(dataDir, 'artifacts', id)
  const file = normalize(join(dir, decoded))
  return file.startsWith(dir + sep) && file !== dir ? file : null
}

// The name to offer in the save dialog: the picture's title, made into something a filesystem takes,
// with the extension it already has (or .png, which is what a screenshot is).
export function fileNameFor(title: string, url: string): string {
  const maybe = /\.([a-z0-9]{2,5})$/i.exec(decodeURIComponent(safeDecode(url.split('?')[0] ?? '')))
  const ext = maybe && EXT_OK.test(`.${maybe[1]}`) ? `.${maybe[1]!.toLowerCase()}` : '.png'
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '') // a title that starts with dots stays a name, not a hidden file
    .slice(0, 80)
  // A title that already ends in the picture's own extension keeps one, not two: a picture called
  // "pic.png" is saved as "pic.png".
  const named = base || 'image'
  const stem = named.toLowerCase().endsWith(ext) ? named.slice(0, -ext.length) : named
  return `${stem || 'image'}${ext}`
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// A data: URL's bytes (a picture the page already has in hand), or null if it isn't one.
function dataUrlBytes(url: string): Buffer | null {
  const comma = url.indexOf(',')
  if (!url.startsWith('data:') || comma < 0) return null
  const head = url.slice(5, comma)
  if (!head.includes('base64')) return null
  const buf = Buffer.from(url.slice(comma + 1), 'base64')
  return buf.length && buf.length <= MAX_IMAGE_BYTES ? buf : null
}

// What the clipboard is told it is holding: the four kinds a conversation shows, read from the bytes
// themselves, because a file name can lie and the clipboard needs the real one.
export function mimeOfImage(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  const head = (at: number, text: string): boolean => buf.length >= at + text.length && buf.subarray(at, at + text.length).toString('latin1') === text
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (head(0, 'GIF8')) return 'image/gif'
  if (head(0, 'RIFF') && head(8, 'WEBP')) return 'image/webp'
  return null
}

// What a right-clicked picture is, as bytes: a data URL the page handed over, or a file the workspace
// keeps. Anything else (another host, another scheme, a file that grew too big) is null.
export async function imageBytesOf(
  url: string,
  resolve: (url: string) => string | null = (u) => artifactImagePath('', u)
): Promise<Buffer | null> {
  const data = dataUrlBytes(url)
  if (data) return data
  const path = resolve(url)
  if (!path) return null
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return null
    return await readFile(path)
  } catch {
    return null
  }
}

// A name already taken in the folder gets " (2)" before its extension, then " (3)": saving without a
// dialog never replaces a file that is already there. `taken` is the folder's own answer, so this
// stays a pure question about names.
export function freeName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken(candidate)) return candidate
  }
  return `${stem} (${Date.now()})${ext}`
}
