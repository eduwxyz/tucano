// The picture a connector wears in the app. What the person picks is shrunk here, in the window, and
// inlined as a data URL: the picture is kept in the database, so a backup, an export and a restore of
// the computer carry it, and there is no folder of loose pictures to keep in step with the connectors.
import { L } from '../../shared/lang'

// The longest side of the picture kept: a tile is 36 px, a screen can be twice that, and nothing here
// is meant to be a logo in a document. Small on purpose: the connector list travels to the phone and
// goes out on every change, so a picture is a few kilobytes, never a photo.
export const ICON_PX = 96
// A picture over this, before shrinking, is not a logo anyone picked on purpose (a photo, a screenshot).
const MAX_FILE_BYTES = 4 * 1024 * 1024
// Must stay in step with ICON_MAX_CHARS in src/core/connectors.ts, which refuses anything longer.
const MAX_DATA_CHARS = 32_000

// Whether a connector's icon is a picture (and not the empty string that goes back to the default).
export const isIconData = (value?: string): boolean => !!value && value.startsWith('data:image/')

// The image a person picked, ready to be stored: a 96 px PNG for a bitmap, the SVG itself for an SVG.
export async function iconFromFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error(L('Escolha um arquivo de imagem.', 'Pick an image file.'))
  if (file.size > MAX_FILE_BYTES) throw new Error(L('Essa imagem tem mais de 4 MB. Escolha uma menor.', 'That image is over 4 MB. Pick a smaller one.'))
  const data = file.type === 'image/svg+xml' ? await svgIcon(file) : await shrunkIcon(file)
  if (data.length > MAX_DATA_CHARS) throw new Error(L('A imagem ficou grande demais para um ícone. Escolha uma menor.', 'That image is too big for an icon. Pick a smaller one.'))
  return data
}

// An SVG is already as small as it gets and keeps its edges at any size: kept as it came, minus the
// parts that have no business in a picture. (An <img> never runs a script inside an SVG; this refuses
// them anyway, so what the database keeps is a picture and nothing else.)
async function svgIcon(file: File): Promise<string> {
  const text = await file.text()
  if (!/<svg[\s>]/i.test(text)) throw new Error(L('Esse arquivo não parece um SVG.', "That file doesn't look like an SVG."))
  if (/<script|javascript:|<foreignObject|on\w+\s*=/i.test(text)) throw new Error(L('Esse SVG tem script ou HTML dentro, e um ícone não pode ter.', 'That SVG carries a script or HTML inside, and an icon cannot.'))
  return `data:image/svg+xml;base64,${utf8Base64(text)}`
}

// A bitmap: drawn at 128 px on its longest side, on a transparent canvas (so a mark with soft edges
// keeps them), and given back as a PNG.
async function shrunkIcon(file: File): Promise<string> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error(L('Não consegui ler essa imagem. Tente um PNG ou um JPEG.', "I couldn't read that image. Try a PNG or a JPEG."))
  }
  const scale = Math.min(1, ICON_PX / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(L('Não consegui preparar a imagem.', "I couldn't prepare the image."))
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  return canvas.toDataURL('image/png')
}

// btoa takes one byte per character: the SVG's text goes through UTF-8 first, accents and all.
function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}
