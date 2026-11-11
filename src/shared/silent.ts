// A routine that goes off, looks, and finds nothing worth telling the person answers with this
// marker, alone. The reply is then empty (one quiet line in the conversation), and it reaches
// nobody as a notification or as an unread badge: a routine with nothing to say says nothing.
export const SILENT = '[SILENT]'

// Emphasis, quotes and a trailing full stop around it are the model being tidy, not a different answer.
const ONLY_MARK = /^\s*[*_`"'“”‘’]*\s*\[silent\]\s*[.*_`"'“”‘’]*,?\s*$/i
// The same at the end of a sentence ("Nothing new. [SILENT]"), which is not a line of its own.
const AT_END = /[*_`"'“”‘’]*\s*\[silent\]\s*[.*_`"'“”‘’]*\s*$/i

// What the marker means, and what is left to read when it's there.
// silent: the marker was all of it. When it sits under text of its own, the text stays and the
// marker goes (the person reads what the agent had to say, never the marker itself).
export function silentOf(text: string): { silent: boolean; text: string } {
  if (!/\[silent\]/i.test(text)) return { silent: false, text }
  const lines = text.split('\n')
  const kept = lines.filter((line) => !ONLY_MARK.test(line))
  const rest = (kept.length === lines.length ? text.replace(AT_END, '') : kept.join('\n')).trim()
  return { silent: rest.length === 0, text: rest }
}
