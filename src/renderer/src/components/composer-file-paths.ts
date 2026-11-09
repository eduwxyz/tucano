export function localFileReferences(files: File[], pathOf?: (file: File) => string): { references: string[]; unresolved: File[] } {
  const references: string[] = []
  const unresolved: File[] = []
  for (const file of files) {
    let path = ''
    try {
      path = pathOf?.(file) ?? ''
    } catch {}
    if (path) references.push(JSON.stringify(path))
    else unresolved.push(file)
  }
  return { references, unresolved }
}
