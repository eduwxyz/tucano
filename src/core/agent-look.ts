import { validateAvatar } from 'open-bot-avatar'
import type { Agent } from '../shared/types'

const MAX_PICTURE = 200_000

// Shown in every window as they are: only a color, a small picture and a drawn avatar that passes its own check stay.
export function cleanLook<T extends Partial<Pick<Agent, 'customColor' | 'picture' | 'avatar'>>>(agent: T): T {
  const customColor = agent.customColor && /^#[0-9a-f]{6}$/i.test(agent.customColor) ? agent.customColor : undefined
  const picture = agent.picture && agent.picture.length <= MAX_PICTURE && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(agent.picture) ? agent.picture : undefined
  const drawn = agent.avatar ? validateAvatar(agent.avatar) : undefined
  const avatar = drawn?.ok ? drawn.value : undefined
  return { ...agent, customColor, picture, avatar }
}
