import type { Agent } from '../shared/types'

const MAX_AVATAR = 200_000

// Shown in every window as they are: only a color and only a small picture stay.
export function cleanLook<T extends Pick<Agent, 'customColor' | 'avatar'>>(agent: T): T {
  const customColor = agent.customColor && /^#[0-9a-f]{6}$/i.test(agent.customColor) ? agent.customColor : undefined
  const avatar = agent.avatar && agent.avatar.length <= MAX_AVATAR && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(agent.avatar) ? agent.avatar : undefined
  return { ...agent, customColor, avatar }
}
