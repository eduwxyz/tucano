// Hermes tags carry a facet before the first colon ("family:ops", "tool:git"). The picker shows
// them grouped by facet; a tag with no known facet (or an empty value) stays whole, in a group
// without one, last.
export const TAG_FACETS = ['family', 'env', 'tool', 'artifact', 'risk', 'locale', 'role'] as const

export interface TagGroup {
  facet: string | undefined
  values: string[]
}

export function tagFacets(tags: string[]): TagGroup[] {
  const by = new Map<string, string[]>()
  const rest: string[] = []
  for (const tag of tags) {
    const i = tag.indexOf(':')
    const facet = i > 0 ? tag.slice(0, i) : ''
    const value = i > 0 ? tag.slice(i + 1) : ''
    if (value && (TAG_FACETS as readonly string[]).includes(facet)) by.set(facet, [...(by.get(facet) ?? []), value])
    else rest.push(tag)
  }
  return [...TAG_FACETS.filter((f) => by.has(f)).map((f) => ({ facet: f as string | undefined, values: by.get(f)! })), ...(rest.length ? [{ facet: undefined, values: rest }] : [])]
}
