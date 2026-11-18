// A sweep may delete only eligible messages. Keep the ancestors of any retained descendant,
// so neither active work nor a longer retention period is bypassed by deleting its thread root.
export function retentionSelection(selected: Set<string>, parents: Map<string, string | undefined>): Set<string> {
  const retained = new Set([...parents.keys()].filter((id) => !selected.has(id)))
  for (const id of retained) {
    const parent = parents.get(id)
    if (parent && parents.has(parent)) retained.add(parent)
  }
  return new Set([...selected].filter((id) => !retained.has(id)))
}
