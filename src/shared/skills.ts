import { L, locale } from './lang'

export const RECOMMENDED_SKILL_BODY_LENGTH = 10_000

export function skillLengthNote(length: number): string {
  const excess = length - RECOMMENDED_SKILL_BODY_LENGTH
  return excess > 0
    ? L(
        `Receita longa: ${length.toLocaleString(locale())} caracteres, ${excess.toLocaleString(locale())} acima do recomendado de ${RECOMMENDED_SKILL_BODY_LENGTH.toLocaleString(locale())}. Recomendamos encurtar; a receita inteira será mantida.`,
        `Long recipe: ${length.toLocaleString(locale())} characters, ${excess.toLocaleString(locale())} over the ${RECOMMENDED_SKILL_BODY_LENGTH.toLocaleString(locale())}-character recommendation. Consider shortening it; the full recipe will be kept.`
      )
    : ''
}

export const overlongSkillNote = (name: string, length: number): string => {
  const note = skillLengthNote(length)
  return note ? `${name} · ${note}` : ''
}
