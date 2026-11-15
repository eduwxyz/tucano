// Which files go with a message from a browser (Tucano as a server), and which go up to the server's
// disk instead. With the message is the better way: the file shows as an attachment and what it says
// reaches the agents as text, with a computer or not (src/core/runs.ts keepFile). A browser's request
// has a cap, though, and base64 grows a file by a third, so only so much fits in one message.
import { IMAGE_MIMES, MAX_FILE_BYTES } from './types'

// What the files of one message may add up to from a browser: the server takes 64 MB per request.
export const MAX_BROWSER_FILES = 40_000_000

// For each file, in order: true goes with the message; false goes up to ~/Enviados, and the message
// says where (one over MAX_FILE_BYTES, or one that no longer fits beside those already attached).
// `held`: the bytes of the files already attached to the message being written.
export function withMessage(files: { size: number; type: string }[], held = 0): boolean[] {
  let total = held
  return files.map((f) => {
    if (IMAGE_MIMES.includes(f.type) || f.type.startsWith('image/')) return true // made small before it goes
    if (f.size > MAX_FILE_BYTES || total + f.size > MAX_BROWSER_FILES) return false
    total += f.size
    return true
  })
}
