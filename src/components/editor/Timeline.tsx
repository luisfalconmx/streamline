import { useRef, useState, type PointerEvent } from 'react'
import { formatTime, type Cut } from './cuts'

interface Props {
  duration: number
  current: number
  cuts: Cut[]
  markIn: number | null
  keyframes: number[]
  showKeyframes: boolean
  onSeek: (t: number) => void
  /** Drag across the track to mark a part to remove. */
  onSelect: (start: number, end: number) => void
}

export function Timeline({ duration, current, cuts, markIn, keyframes, showKeyframes, onSeek, onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  // Ref copy: pointerup can arrive before React re-renders after pointerdown.
  const dragRef = useRef<{ from: number; to: number } | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const pct = (t: number) => `${(Math.min(Math.max(t, 0), duration) / duration) * 100}%`

  const timeAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.min(Math.max((clientX - r.left) / r.width, 0), 1) * duration
  }

  const down = (e: PointerEvent) => {
    if (!duration) return
    try {
      ref.current?.setPointerCapture(e.pointerId)
    } catch {
      /* synthetic events have no capturable pointer */
    }
    const t = timeAt(e.clientX)
    dragRef.current = { from: t, to: t }
    setDrag(dragRef.current)
  }
  const move = (e: PointerEvent) => {
    if (!duration) return
    const t = timeAt(e.clientX)
    setHover(t)
    if (dragRef.current) {
      dragRef.current = { ...dragRef.current, to: t }
      setDrag(dragRef.current)
    }
  }
  const up = (e: PointerEvent) => {
    const start = dragRef.current
    if (!start) return
    const t = timeAt(e.clientX)
    const a = Math.min(start.from, t)
    const b = Math.max(start.from, t)
    dragRef.current = null
    setDrag(null)
    // A short drag is a click: seek. A real drag marks a part to remove.
    if (b - a < Math.max(0.25, duration * 0.004)) onSeek(t)
    else onSelect(a, b)
  }

  const ticks = Array.from({ length: 11 }, (_, i) => (i * duration) / 10)

  return (
    <div className="flex flex-col gap-1.5 select-none">
      <div
        ref={ref}
        role="slider"
        aria-label="Línea de tiempo"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={current}
        tabIndex={0}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={() => setHover(null)}
        className="relative h-16 cursor-crosshair overflow-hidden rounded-xl border border-border bg-surface"
      >
        {/* Kept video */}
        <div className="absolute inset-y-3 inset-x-0 bg-accent/25" />

        {/* Keyframes (where lossless cuts can resume) */}
        {showKeyframes &&
          keyframes.map((k) => (
            <div key={k} className="absolute inset-y-3 w-px bg-foreground/15" style={{ left: pct(k) }} />
          ))}

        {/* Parts to remove */}
        {cuts.map((c) => (
          <div
            key={c.id}
            className="absolute inset-y-0 border-x-2 border-danger bg-danger/30"
            style={{
              left: pct(c.start),
              width: `calc(${pct(c.end)} - ${pct(c.start)})`,
              backgroundImage:
                'repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in oklab, var(--color-danger) 35%, transparent) 6px 12px)',
            }}
          />
        ))}

        {/* Selection being dragged */}
        {drag && Math.abs(drag.to - drag.from) > 0 && (
          <div
            className="absolute inset-y-0 border-x-2 border-warning bg-warning/25"
            style={{ left: pct(Math.min(drag.from, drag.to)), width: `calc(${pct(Math.max(drag.from, drag.to))} - ${pct(Math.min(drag.from, drag.to))})` }}
          />
        )}

        {/* Mark-in marker */}
        {markIn != null && (
          <div className="absolute inset-y-0 w-0.5 bg-warning" style={{ left: pct(markIn) }}>
            <span className="absolute -top-0 left-1 rounded bg-warning px-1 text-[10px] font-bold text-black">IN</span>
          </div>
        )}

        {/* Hover time */}
        {hover != null && !drag && (
          <div className="pointer-events-none absolute inset-y-0 w-px bg-foreground/40" style={{ left: pct(hover) }}>
            <span className="absolute bottom-0.5 left-1 rounded bg-black/70 px-1 text-[10px] text-white tabular-nums">
              {formatTime(hover, true)}
            </span>
          </div>
        )}

        {/* Playhead */}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-foreground shadow" style={{ left: pct(current) }}>
          <div className="absolute -top-1 -left-[5px] size-3 rotate-45 rounded-sm bg-foreground" />
        </div>
      </div>

      <div className="relative h-4 text-[10px] text-muted tabular-nums">
        {ticks.map((t, i) => (
          <span key={i} className="absolute -translate-x-1/2" style={{ left: pct(t) }}>
            {formatTime(t)}
          </span>
        ))}
      </div>
    </div>
  )
}
