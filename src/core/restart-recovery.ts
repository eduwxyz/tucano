import { L } from '../shared/lang'
import type { Message } from '../shared/types'

export function restartTask(message: Message): string {
  const steps = message.run?.steps.filter((step) => step.status === 'done').slice(-40)
    .map((step) => `- ${step.label}${step.detail ? `: ${step.detail}` : ''}`).join('\n')
  return [
    message.run?.task,
    L('O Tucano fechou enquanto você trabalhava. Continue o pedido original de onde parou. Confira o estado das ferramentas antes de repetir ações; uma ação pode ter terminado antes da interrupção.', 'Tucano closed while you were working. Continue the original request from where you stopped. Check tool state before repeating actions; an action may have completed before the interruption.'),
    message.text && `${L('Sua resposta parcial', 'Your partial reply')}:\n${message.text}`,
    steps && `${L('Passos concluídos', 'Completed steps')}:\n${steps}`
  ].filter(Boolean).join('\n\n')
}
