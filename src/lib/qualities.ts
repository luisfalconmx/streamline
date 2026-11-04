import type { QualityOption, Settings, YtFormat, YtInfo } from './types'

const AUDIO_EXTS = new Set(['m4a', 'mp3', 'opus', 'ogg', 'oga', 'wav', 'flac', 'aac', 'weba', 'mka', 'alac', 'aiff'])

/**
 * yt-dlp marks streams it knows lack video with `vcodec: "none"`. A missing codec
 * (e.g. direct links handled by the generic extractor) means "unknown", so it is
 * treated as video unless the container is an audio-only one.
 */
const hasVideo = (f: YtFormat) => {
  if (f.vcodec === 'none') return false
  if (f.vcodec) return true
  return !AUDIO_EXTS.has((f.ext ?? '').toLowerCase())
}
/** Unknown audio codec counts as "probably has audio" (single muxed file). */
const hasAudio = (f: YtFormat) => f.acodec !== 'none'

function estimate(f: YtFormat | undefined, duration?: number | null) {
  if (!f) return { size: undefined as number | undefined, approx: false }
  if (f.filesize) return { size: f.filesize, approx: false }
  if (f.filesize_approx) return { size: f.filesize_approx, approx: true }
  if (f.tbr && duration) return { size: (f.tbr * 1000 * duration) / 8, approx: true }
  return { size: undefined, approx: true }
}

export function codecName(codec?: string): string {
  if (!codec || codec === 'none') return ''
  const c = codec.toLowerCase()
  if (c.startsWith('avc') || c.startsWith('h264')) return 'H.264'
  if (c.startsWith('hev') || c.startsWith('hvc') || c.startsWith('h265')) return 'H.265'
  if (c.startsWith('vp09') || c.startsWith('vp9')) return 'VP9'
  if (c.startsWith('vp8')) return 'VP8'
  if (c.startsWith('av01')) return 'AV1'
  if (c.startsWith('mp4a') || c === 'aac') return 'AAC'
  if (c.startsWith('opus')) return 'Opus'
  if (c.startsWith('vorbis')) return 'Vorbis'
  if (c.startsWith('mp3')) return 'MP3'
  if (c.startsWith('flac')) return 'FLAC'
  if (c.startsWith('ac-3') || c.startsWith('ec-3')) return 'Dolby'
  return codec.split('.')[0].toUpperCase()
}

export function resolutionBadge(height?: number | null): string | undefined {
  if (!height) return undefined
  if (height >= 4320) return '8K'
  if (height >= 2160) return '4K'
  if (height >= 1440) return '2K'
  if (height >= 1080) return 'Full HD'
  if (height >= 720) return 'HD'
  return undefined
}

function usable(info: YtInfo): YtFormat[] {
  return (info.formats ?? []).filter(
    (f) => !f.has_drm && f.ext !== 'mhtml' && f.protocol !== 'mhtml' && !f.format_id.startsWith('sb'),
  )
}

function pickAudio(audios: YtFormat[], container: Settings['mergeFormat']): YtFormat | undefined {
  if (!audios.length) return undefined
  const score = (f: YtFormat) => {
    let s = f.abr ?? f.tbr ?? 0
    if (f.format_note?.toLowerCase().includes('original')) s += 10_000
    if (f.format_note?.toLowerCase().includes('drc')) s -= 5
    if (container === 'mp4' && (f.ext === 'm4a' || f.acodec?.startsWith('mp4a'))) s += 1_000
    if (container === 'webm' && f.ext === 'webm') s += 1_000
    return s
  }
  return [...audios].sort((a, b) => score(b) - score(a))[0]
}

/** Video quality options, one per resolution / frame-rate / HDR combination. */
export function buildVideoOptions(info: YtInfo, settings: Settings): QualityOption[] {
  const formats = usable(info)
  const duration = info.duration
  const videos = formats.filter((f) => hasVideo(f) && f.height)
  const audiosOnly = formats.filter((f) => hasAudio(f) && !hasVideo(f))

  if (!videos.length) {
    // No resolution info (direct links, generic sites): offer each video-capable
    // format as-is, best last in yt-dlp order → first here.
    const candidates = formats.filter(hasVideo).reverse()
    if (!candidates.length && formats.length) return []
    if (!candidates.length) {
      const est = estimate(info as unknown as YtFormat, duration)
      return [{ key: 'best', label: 'Mejor calidad', sublabel: 'Automático', format: 'bv*+ba/b', size: est.size, approx: est.approx }]
    }
    return candidates.map((f, i) => {
      const est = estimate(f, duration)
      const separateAudio = !hasAudio(f) && audiosOnly.length > 0
      return {
        key: `fmt-${f.format_id}`,
        label: f.height ? `${f.height}p` : i === 0 ? 'Calidad original' : (f.format_note ?? f.format_id),
        badge: resolutionBadge(f.height),
        sublabel: [(f.ext ?? '').toUpperCase(), codecName(f.vcodec), f.width && f.height ? `${f.width}×${f.height}` : '']
          .filter(Boolean)
          .join(' · ') || 'Archivo de video',
        format: separateAudio ? `${f.format_id}+ba/${f.format_id}/b` : `${f.format_id}/b`,
        size: est.size,
        approx: est.approx,
        height: f.height ?? undefined,
      }
    })
  }

  const audio = pickAudio(audiosOnly, settings.mergeFormat)
  const groups = new Map<string, YtFormat[]>()
  for (const v of videos) {
    const fps = v.fps && v.fps > 30 ? Math.round(v.fps) : 0
    const hdr = v.dynamic_range && v.dynamic_range !== 'SDR' ? 'hdr' : ''
    const key = `${v.height}-${fps}-${hdr}`
    groups.set(key, [...(groups.get(key) ?? []), v])
  }

  const preferAvc = settings.preferH264 && settings.mergeFormat === 'mp4'
  const scoreVideo = (f: YtFormat) => {
    let s = f.tbr ?? f.vbr ?? 0
    if (preferAvc && f.vcodec?.startsWith('avc')) s += 100_000
    if (settings.mergeFormat === 'webm' && f.ext === 'webm') s += 100_000
    if (hasAudio(f) && audio) s -= 50 // prefer separate best audio when available
    if (f.filesize) s += 10_000 // known size beats HLS/DASH manifests of similar quality
    return s
  }

  const options: QualityOption[] = []
  for (const [key, list] of groups) {
    const v = [...list].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
    const h = v.height!
    const fps = v.fps ? Math.round(v.fps) : undefined
    const hdr = key.endsWith('hdr')
    const combined = hasAudio(v) || !audio
    const vEst = estimate(v, duration)
    const aEst = combined ? { size: 0, approx: false } : estimate(audio, duration)
    const size = vEst.size != null ? vEst.size + (aEst.size ?? 0) : undefined
    const selector = combined ? v.format_id : `${v.format_id}+${audio!.format_id}`

    options.push({
      key,
      height: h,
      label: `${h}p${fps && fps > 30 ? fps : ''}`,
      badge: [resolutionBadge(h), hdr ? 'HDR' : ''].filter(Boolean).join(' · ') || undefined,
      sublabel: [codecName(v.vcodec), fps ? `${fps} fps` : '', !combined && audio ? codecName(audio.acodec) : '']
        .filter(Boolean)
        .join(' · '),
      format: `${selector}/bv*[height<=${h}]+ba/b[height<=${h}]/b`,
      size,
      approx: vEst.approx || aEst.approx,
    })
  }

  return options.sort((a, b) => {
    const [ha, fa] = a.key.split('-').map(Number)
    const [hb, fb] = b.key.split('-').map(Number)
    return hb - ha || fb - fa || (a.key.endsWith('hdr') ? -1 : 1)
  })
}

const LOSSY_BITRATES = [320, 256, 192, 128]

/** Audio-only options for the configured output codec. */
export function buildAudioOptions(info: YtInfo, settings: Settings): QualityOption[] {
  const formats = usable(info)
  const duration = info.duration ?? 0
  const audios = formats.filter((f) => hasAudio(f) && !hasVideo(f))
  const best = [...audios].sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0]
  const bestEst = estimate(best, duration)
  const fmt = settings.audioFormat
  const label = fmt.toUpperCase()

  const options: QualityOption[] = [
    {
      key: 'original',
      label: 'Original',
      badge: 'Sin pérdida extra',
      sublabel: best
        ? `${codecName(best.acodec)} · ${Math.round(best.abr ?? best.tbr ?? 0)} kbps · .${best.ext}`
        : 'Mejor pista de audio, sin recodificar',
      format: 'ba/b',
      size: bestEst.size,
      approx: bestEst.approx,
      audioFormat: 'best',
      audioQuality: '0',
    },
  ]

  if (fmt === 'flac' || fmt === 'wav') {
    const kbps = fmt === 'wav' ? 1411 : 850
    options.push({
      key: fmt,
      label,
      badge: 'Sin pérdida',
      sublabel: fmt === 'wav' ? 'PCM 16-bit · 44.1 kHz' : 'Compresión sin pérdida',
      format: 'ba/b',
      size: duration ? (kbps * 1000 * duration) / 8 : undefined,
      approx: true,
      audioFormat: fmt,
      audioQuality: '0',
    })
  } else {
    for (const kbps of LOSSY_BITRATES) {
      options.push({
        key: `${fmt}-${kbps}`,
        label: `${label} ${kbps} kbps`,
        badge: kbps === 320 ? 'Máxima' : kbps === 192 ? 'Equilibrado' : undefined,
        sublabel: `${label} · ${kbps} kbps`,
        format: 'ba/b',
        size: duration ? (kbps * 1000 * duration) / 8 : undefined,
        approx: true,
        audioFormat: fmt,
        audioQuality: `${kbps}K`,
      })
    }
  }
  return options
}

export interface PlaylistPreset {
  key: string
  label: string
  mode: 'video' | 'audio'
  height?: number
}

export const PLAYLIST_PRESETS: PlaylistPreset[] = [
  { key: 'best', label: 'Mejor calidad', mode: 'video' },
  { key: '2160', label: '4K (2160p)', mode: 'video', height: 2160 },
  { key: '1080', label: 'Full HD (1080p)', mode: 'video', height: 1080 },
  { key: '720', label: 'HD (720p)', mode: 'video', height: 720 },
  { key: '480', label: '480p', mode: 'video', height: 480 },
  { key: 'audio', label: 'Solo audio', mode: 'audio' },
]

export function presetSelector(preset: PlaylistPreset, settings: Settings): string {
  if (preset.mode === 'audio') return 'ba/b'
  const h = preset.height ? `[height<=${preset.height}]` : ''
  const generic = `bv*${h}+ba/b${h}/b`
  if (settings.preferH264 && settings.mergeFormat === 'mp4') {
    return `bv*${h}[vcodec^=avc]+ba[ext=m4a]/${generic}`
  }
  return generic
}

export function bestThumbnail(info: { thumbnail?: string | null; thumbnails?: { url: string; width?: number }[] }) {
  if (info.thumbnail) return info.thumbnail
  const thumbs = info.thumbnails ?? []
  return thumbs.length ? [...thumbs].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0].url : undefined
}
