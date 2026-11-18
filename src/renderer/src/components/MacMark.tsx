import type { ReactNode } from 'react'
import { Icon } from './ui'

export function MacMark({ label }: { label: string }): ReactNode {
  return (
    <span className="mac-mark" title={label} role="img" aria-label={label}>
      <Icon name="laptop" size={13} />
    </span>
  )
}
