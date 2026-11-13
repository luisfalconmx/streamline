import { Chip } from '@heroui/react'
import { Check } from 'lucide-react'
import { formatBytes } from '../lib/format'
import type { QualityOption } from '../lib/types'

interface Props {
  options: QualityOption[]
  selected?: string
  onSelect: (key: string) => void
}

export function QualityPicker({ options, selected, onSelect }: Props) {
  if (!options.length) {
    return <p className="py-6 text-center text-sm text-muted">No hay formatos disponibles en este modo.</p>
  }
  return (
    <div role="radiogroup" aria-label="Calidad" className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
      {options.map((o, idx) => {
        const active = o.key === selected
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onSelect(o.key)}
            className={[
              'group relative flex flex-col gap-1 rounded-2xl border p-3.5 text-left transition-all outline-none',
              'focus-visible:ring-2 focus-visible:ring-focus',
              active
                ? 'border-accent bg-accent-soft shadow-sm'
                : 'border-border bg-surface hover:border-border-secondary hover:bg-surface-hover',
            ].join(' ')}
          >
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold">{o.label}</span>
              {o.badge && (
                <Chip size="sm" variant="soft" color="accent">
                  {o.badge}
                </Chip>
              )}
              {idx === 0 && !o.badge && (
                <Chip size="sm" variant="soft" color="success">
                  Mejor
                </Chip>
              )}
              <span
                className={[
                  'ml-auto flex size-5 items-center justify-center rounded-full border transition-colors',
                  active ? 'border-accent bg-accent text-accent-foreground' : 'border-border',
                ].join(' ')}
              >
                {active && <Check className="size-3.5" strokeWidth={3} />}
              </span>
            </div>
            <span className="truncate text-xs text-muted">{o.sublabel || '—'}</span>
            <span className="mt-1 text-sm font-medium tabular-nums">
              {o.size ? `${o.approx ? '≈ ' : ''}${formatBytes(o.size)}` : 'Tamaño desconocido'}
            </span>
          </button>
        )
      })}
    </div>
  )
}
