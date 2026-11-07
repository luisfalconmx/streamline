/**
 * Browser-only mock backend, used by `pnpm dev` outside of Tauri (for example
 * the Docker web preview) so the UI can be developed without the native shell.
 * It is tree-shaken out of production builds.
 */
import type { DownloadEvent, DownloadRequest, YtFormat, YtInfo } from './types'

const listeners = new Set<(e: DownloadEvent) => void>()
const timers = new Map<string, ReturnType<typeof setInterval>>()

export function mockListen(handler: (e: DownloadEvent) => void) {
  listeners.add(handler)
  return () => listeners.delete(handler)
}
const emit = (e: DownloadEvent) => listeners.forEach((l) => l(e))

function formats(duration: number): YtFormat[] {
  const out: YtFormat[] = [
    { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 129, tbr: 129, filesize: Math.round(129_000 / 8 * duration), format_note: 'medium' },
    { format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 135, tbr: 135, filesize: Math.round(135_000 / 8 * duration), format_note: 'medium' },
  ]
  const ladder: [number, number, number][] = [
    [2160, 60, 17_000],
    [1440, 60, 9_000],
    [1080, 60, 4_200],
    [1080, 30, 2_600],
    [720, 30, 1_400],
    [480, 30, 750],
    [360, 30, 420],
    [240, 30, 230],
  ]
  ladder.forEach(([h, fps, kbps], i) => {
    out.push({
      format_id: `${300 + i}`,
      ext: 'webm',
      vcodec: 'vp09.00.51.08',
      acodec: 'none',
      height: h,
      width: Math.round((h * 16) / 9),
      fps,
      tbr: kbps,
      filesize: Math.round((kbps * 1000) / 8 * duration),
      dynamic_range: 'SDR',
    })
    if (h <= 1080) {
      out.push({
        format_id: `${400 + i}`,
        ext: 'mp4',
        vcodec: 'avc1.640028',
        acodec: 'none',
        height: h,
        fps,
        tbr: kbps * 1.3,
        filesize: Math.round((kbps * 1300) / 8 * duration),
      })
    }
  })
  return out
}

export async function mockFetchInfo(url: string): Promise<YtInfo> {
  await new Promise((r) => setTimeout(r, 900))
  if (url.includes('botcheck')) {
    throw "[youtube] fo-DhrgQxl8: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication."
  }
  if (url.includes('list=')) {
    return {
      _type: 'playlist',
      id: 'PLmock',
      title: 'Lo-fi para programar — Mix 2026',
      webpage_url: url,
      uploader: 'Streamline Demo',
      extractor_key: 'YoutubeTab',
      entries: Array.from({ length: 12 }, (_, i) => ({
        id: `vid${i}`,
        url: `https://www.youtube.com/watch?v=vid${i}`,
        title: `Track ${i + 1} · Sesión nocturna de código`,
        duration: 180 + i * 37,
        thumbnails: [{ url: `https://picsum.photos/seed/sl${i}/320/180`, width: 320 }],
      })),
    }
  }
  const duration = 754
  return {
    _type: 'video',
    id: 'mock123',
    title: 'Explorando los Alpes en 4K — Un viaje cinematográfico sin cortes',
    webpage_url: url,
    extractor_key: 'Youtube',
    uploader: 'Nature Films',
    duration,
    view_count: 1_834_221,
    like_count: 52_310,
    upload_date: '20260914',
    thumbnail: 'https://picsum.photos/seed/streamline/1280/720',
    description: 'Un recorrido aéreo por los paisajes más impresionantes de los Alpes suizos, grabado en 4K a 60 fps.',
    formats: formats(duration),
    subtitle_langs: ['es', 'en'],
  }
}

export async function mockStartDownload(req: DownloadRequest) {
  const total = 48 * 1024 * 1024
  let downloaded = 0
  const streams: ('video' | 'audio')[] = req.audioFormat ? ['audio'] : ['video', 'audio']
  let s = 0
  const timer = setInterval(() => {
    const speed = (6 + Math.random() * 18) * 1024 * 1024
    downloaded = Math.min(total, downloaded + speed / 4)
    const done = downloaded >= total
    emit({ kind: 'progress', id: req.id, status: done ? 'finished' : 'downloading', downloaded, total, speed, eta: (total - downloaded) / speed, stream: streams[s] })
    if (done) {
      s++
      downloaded = 0
      if (s >= streams.length) {
        clearInterval(timer)
        timers.delete(req.id)
        emit({ kind: 'stage', id: req.id, stage: req.audioFormat ? 'ExtractAudio' : 'Merger' })
        setTimeout(() => {
          emit({ kind: 'file', id: req.id, path: `${req.outputDir}/demo.${req.audioFormat ?? req.mergeFormat}` })
          emit({ kind: 'done', id: req.id })
        }, 1200)
      }
    }
  }, 250)
  timers.set(req.id, timer)
}

export async function mockCancel(id: string) {
  clearInterval(timers.get(id))
  timers.delete(id)
  setTimeout(() => emit({ kind: 'cancelled', id }), 100)
}

/** Editor preview in the browser: plays `public/dev-sample.mp4` (git-ignored). */
export async function mockEditorOpen(path: string) {
  await new Promise((r) => setTimeout(r, 300))
  return {
    path,
    previewPath: '/dev-sample.mp4',
    fileName: 'Samus And Helena Vs Orcs-2160p [24cc9176].mp4',
    container: 'mp4',
    duration: 20,
    size: 206_879_129,
    width: 3840,
    height: 2160,
    fps: 60,
    vcodec: 'h264',
    acodec: 'aac',
    title: 'Samus And Helena Vs Orcs [4K]',
    coverPath: null,
    coverSupported: true,
  }
}
