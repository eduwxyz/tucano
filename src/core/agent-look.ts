import type { Agent } from '../shared/types'

const MAX_PICTURE = 200_000

// Shown in every window as they are: only a color and only a small picture stay.
export function cleanLook<T extends Pick<Agent, 'customColor' | 'picture'>>(agent: T): T {
  const customColor = agent.customColor && /^#[0-9a-f]{6}$/i.test(agent.customColor) ? agent.customColor : undefined
  const picture = agent.picture && agent.picture.length <= MAX_PICTURE && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(agent.picture) ? agent.picture : undefined
  return { ...agent, customColor, picture }
}
