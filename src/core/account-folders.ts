// An account's folder, with its own login in it, and what becomes of it when the account goes.
// Taking the account out of the settings is instant; deleting the folder is not, because the CLI
// that signed in there can still be open (on Windows one open file holds the whole directory), so
// the deletion is best effort and whatever survives it goes at the next launch.
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// The folder, now if nothing is using it. `false` says it stayed, and the caller keeps the removal
// anyway: an account already out of the settings must not come back because a CLI held its folder.
export function dropAccountDir(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    return true
  } catch {
    return false
  }
}

// Folders in accounts/ that the settings no longer know: left by a removal that could not finish,
// so nobody's login. Returns the ones that went.
export function sweepAccountDirs(root: string, keep: Iterable<string>): string[] {
  const known = new Set(keep)
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return [] // no accounts yet
  }
  return names.filter((name) => !known.has(name) && dropAccountDir(join(root, name)))
}
