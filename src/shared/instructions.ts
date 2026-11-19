import { L, locale } from './lang'

export const RECOMMENDED_INSTRUCTION_LENGTH = 32_000

export function instructionLengthNote(length: number): string {
  const excess = length - RECOMMENDED_INSTRUCTION_LENGTH
  return excess > 0
    ? L(
        `Prompt longo: ${length.toLocaleString(locale())} caracteres, ${excess.toLocaleString(locale())} acima do recomendado de ${RECOMMENDED_INSTRUCTION_LENGTH.toLocaleString(locale())}. O texto será mantido inteiro; o contexto total também inclui a conversa e as ferramentas.`,
        `Long prompt: ${length.toLocaleString(locale())} characters, ${excess.toLocaleString(locale())} over the ${RECOMMENDED_INSTRUCTION_LENGTH.toLocaleString(locale())}-character recommendation. The full text will be kept; total context also includes the conversation and tools.`
      )
    : ''
}
