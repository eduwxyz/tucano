// Provider config may name environment variables explicitly (`env`) or use
// shell placeholders (`$TOKEN` / `${TOKEN}`). Forward only those names to WSL.
export function opencodeProviderEnvNames(value: unknown): string[] {
  const names = new Set<string>()
  const visit = (item: unknown, key?: string): void => {
    if (typeof item === 'string') {
      if (key === 'env' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(item)) names.add(item)
      for (const match of item.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) names.add(match[1]!)
    } else if (Array.isArray(item)) item.forEach((child) => visit(child, key))
    else if (item && typeof item === 'object') for (const [childKey, child] of Object.entries(item)) visit(child, childKey)
  }
  visit(value)
  return [...names]
}
