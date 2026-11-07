/** A part of the video the user wants to remove, in seconds. */
export interface Cut {
  id: string
  start: number
  end: number
}

/** Sorted, merged, clamped cuts. */
export function normalizeCuts(cuts: Cut[], duration: number): Cut[] {
  const sorted = cuts
    .map((c) => ({ ...c, start: Math.max(0, Math.min(c.start, c.end)), end: Math.min(duration, Math.max(c.start, c.end)) }))
    .filter((c) => c.end - c.start > 0.05)
    .sort((a, b) => a.start - b.start)
  const out: Cut[] = []
  for (const c of sorted) {
    const last = out.at(-1)
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end)
    else out.push({ ...c })
  }
  return out
}

/** Parts to keep: the complement of the cuts inside [0, duration]. */
export function keepRanges(cuts: Cut[], duration: number): [number, number][] {
  const keep: [number, number][] = []
  let pos = 0
  for (const c of normalizeCuts(cuts, duration)) {
    if (c.start - pos > 0.05) keep.push([pos, c.start])
    pos = Math.max(pos, c.end)
  }
  if (duration - pos > 0.05) keep.push([pos, duration])
  return keep
}

/**
 * Lossless (stream copy) cuts can only resume on a keyframe: move each cut's
 * end — where the kept video starts again — to the nearest keyframe.
 */
export function snapCut(cut: Cut, keyframes: number[], duration: number): Cut {
  if (!keyframes.length || cut.end >= duration - 0.05) return cut
  let best = keyframes[0]
  for (const k of keyframes) if (Math.abs(k - cut.end) < Math.abs(best - cut.end)) best = k
  if (best > cut.start + 0.05) return { ...cut, end: best }
  // The nearest keyframe is before the cut: resume at the next one instead.
  const next = keyframes.find((k) => k >= cut.end)
  return { ...cut, end: next ?? duration }
}

export function formatTime(s: number, withMs = false): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const ms = Math.floor((s % 1) * 10)
  const pad = (n: number) => String(n).padStart(2, '0')
  const base = h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
  return withMs ? `${base}.${ms}` : base
}
