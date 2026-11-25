// A cited file the core checked and signed (core/local-paths.ts), as the window gets it from the
// tucano: protocol: read from the descriptor that was checked, never from its name again.
import { closeSync, createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { Readable } from 'node:stream'

// What the window shows from a cited file: images, videos and PDFs.
const LOCAL_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf'
}

export const localType = (path: string): string => LOCAL_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'

// A file served from its descriptor, with the byte ranges a video asks for when it seeks. The
// descriptor is this function's from here on: closed when the body ends, or now when there is none.
export function localResponse(req: Request, opened: { fd: number; size: number }, type: string): Response {
  const headers = new Headers({ 'Content-Type': type, 'Content-Security-Policy': 'sandbox', 'Accept-Ranges': 'bytes' })
  const asked = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '')
  let start = 0
  let end = opened.size - 1
  if (asked && (asked[1] || asked[2])) {
    if (asked[1]) {
      start = Number(asked[1])
      if (asked[2]) end = Math.min(Number(asked[2]), end)
    } else start = Math.max(0, opened.size - Number(asked[2]))
    if (start > end) {
      closeSync(opened.fd)
      headers.set('Content-Range', `bytes */${opened.size}`)
      return new Response(null, { status: 416, headers })
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${opened.size}`)
  }
  headers.set('Content-Length', String(end - start + 1))
  const status = headers.has('Content-Range') ? 206 : 200
  // Nothing to send (an empty file, or only the headers were asked for): no stream would ever close it.
  if (opened.size === 0 || req.method === 'HEAD') {
    closeSync(opened.fd)
    return new Response(null, { status, headers })
  }
  const body = Readable.toWeb(createReadStream('', { fd: opened.fd, start, end })) as ReadableStream<Uint8Array>
  return new Response(body, { status, headers })
}
