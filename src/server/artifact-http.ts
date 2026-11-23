// What the agents showed in the chat, at /artifact/<id>/<name>: sandboxed as on the desktop, or,
// with ?download, sent to be saved under its own name (a .docx a browser can't show is otherwise
// out of reach on a server). Only a file inside that artifact's own folder, and only for someone
// the core says sees the conversation it was shown in: anyone else gets a plain 404, as for a
// file that isn't there. The caller has already signed the request in (src/server/index.ts).
import { createReadStream, statSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { basename, join, normalize, sep } from 'node:path'
import { ARTIFACT_CSP, attachment, BASE_HEADERS, decodedPath } from './guard'

const ARTIFACT = /^\/artifact\/([0-9a-f-]{36})\/([^/]+)$/

export interface ArtifactRoute {
  dataDir: string
  // Whether the person asking may see this artifact (the core's answer, src/server/people.ts Grants).
  may(id: string): Promise<boolean>
  // The content type a file is shown with, by its extension.
  type(path: string): string
}

// False when the address isn't an artifact's, for the caller to go on; otherwise it's answered.
export function serveArtifact(res: ServerResponse, url: URL, o: ArtifactRoute): boolean {
  const m = ARTIFACT.exec(url.pathname)
  if (!m) return false
  const notFound = (): void => void (!res.headersSent && res.writeHead(404, BASE_HEADERS).end())
  const dir = join(o.dataDir, 'artifacts', m[1]!)
  const name = decodedPath(m[2]!)
  const path = name === undefined ? '' : normalize(join(dir, name))
  if (!path.startsWith(dir + sep)) {
    notFound()
    return true
  }
  void o.may(m[1]!).then(
    (ok) => {
      if (!ok) return notFound()
      let size = -1
      try {
        const st = statSync(path)
        size = st.isFile() ? st.size : -1
      } catch {}
      if (size < 0) return notFound()
      const saving = url.searchParams.has('download')
      res.writeHead(200, {
        ...BASE_HEADERS,
        'content-length': String(size),
        ...(saving
          ? { 'content-type': 'application/octet-stream', 'content-disposition': attachment(basename(path)), 'content-security-policy': 'sandbox' }
          : { 'content-type': o.type(path), 'content-security-policy': ARTIFACT_CSP })
      })
      createReadStream(path).on('error', () => res.destroy()).pipe(res)
    },
    notFound
  )
  return true
}
