// A big file the app downloads once (a model): to a .part file, hashed on the way, and moved into
// place only if it's the file it should be. The .part carries the process id: two workspaces share
// the models' folder, and each one's core may be fetching the same file.
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { L } from '../shared/lang'

export interface PinnedFile {
  url: string
  bytes: number
  sha256: string
}

export async function fetchPinned(fetcher: typeof fetch, file: PinnedFile, dest: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.${process.pid}.part`
  try {
    const res = await fetcher(file.url, { signal, redirect: 'follow' })
    if (!res.ok || !res.body) throw new Error(L(`O download respondeu ${res.status}.`, `The download answered ${res.status}.`))
    const hash = createHash('sha256')
    const out = createWriteStream(part)
    const reader = res.body.getReader()
    let received = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        if (!out.write(value)) await new Promise((r) => out.once('drain', r))
        received += value.length
        onBytes(value.length)
      }
    } finally {
      await new Promise<void>((r) => out.end(r))
    }
    if (received !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(L('O arquivo baixado não é o esperado. Tente de novo.', "The downloaded file isn't the expected one. Try again."))
    renameSync(part, dest)
  } finally {
    rmSync(part, { force: true })
  }
}
