import { colorSchemeOf, themeById, themeVariables } from '../../shared/themes'
import type { Settings } from '../../shared/types'

export function paintTheme(themeId: string | undefined, mode: Settings['theme']): void {
  const scheme = colorSchemeOf(mode, matchMedia('(prefers-color-scheme: dark)').matches)
  for (const [name, value] of Object.entries(themeVariables(themeById(themeId), scheme))) document.documentElement.style.setProperty(name, value)
}
