// Helpers shared by the service worker and the popup.

export const MEDIA_EXT = /\.(mp4|m4v|mov|webm|mkv|flv|avi|ogv|3gp|m3u8|mpd)(?:$|[?#/])/i
export const SEGMENT_EXT = /\.(ts|m4s|aac|vtt|webvtt|key|jpg|jpeg|png|gif|webp)(?:$|[?#])/i

/** Sites whose pages yt-dlp understands directly (page URL is the best link). */
export const KNOWN_SITES = [
  'youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com', 'x.com', 'twitter.com',
  'facebook.com', 'fb.watch', 'vimeo.com', 'twitch.tv', 'reddit.com', 'dailymotion.com',
  'soundcloud.com', 'bilibili.com', 'kick.com', 'rumble.com', 'pinterest.com', 'threads.net',
]

/** CDNs that only serve chunks of a stream: useless on their own. */
const SEGMENT_HOSTS = ['googlevideo.com', 'fbcdn.net', 'cdninstagram.com', 'ttwstatic.com', 'twimg.com']

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function isKnownSite(url) {
  const h = hostOf(url)
  return KNOWN_SITES.some((s) => h === s || h.endsWith('.' + s))
}

export function isSegmentHost(url) {
  const h = hostOf(url)
  return SEGMENT_HOSTS.some((s) => h === s || h.endsWith('.' + s))
}

/** Media kind from MIME type and/or URL. */
export function mediaKind(url, mime = '') {
  const m = mime.toLowerCase().split(';')[0].trim()
  if (m.includes('mpegurl') || /\.m3u8(?:$|[?#])/i.test(url)) return 'HLS'
  if (m === 'application/dash+xml' || /\.mpd(?:$|[?#])/i.test(url)) return 'DASH'
  if (m.startsWith('video/')) {
    const sub = m.slice(6)
    if (sub === 'mp2t' || sub === 'iso.segment') return null
    return { mp4: 'MP4', webm: 'WEBM', quicktime: 'MOV', 'x-matroska': 'MKV', 'x-flv': 'FLV', ogg: 'OGV', 'x-m4v': 'M4V' }[sub] ?? sub.toUpperCase()
  }
  const ext = url.match(MEDIA_EXT)?.[1]
  return ext ? ext.toUpperCase() : null
}

export function stripHash(url) {
  return url.split('#')[0]
}

export function fileNameFromUrl(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const file = [...segs].reverse().find((s) => MEDIA_EXT.test(s + '?')) ?? segs.at(-1) ?? ''
    return file.replace(/\.[a-z0-9]{2,4}$/i, '')
  } catch {
    return ''
  }
}

/** Vertical resolution from a label/filename: "1080p", "_720p.mp4", "4K", "HD". */
export function qualityOf(text) {
  if (!text) return null
  const t = String(text)
  const m = t.match(/(?:^|[^0-9])(4320|2160|1440|1080|720|576|540|480|360|240|144)p?(?![0-9])/i)
  if (m) return Number(m[1])
  if (/\b8k\b/i.test(t)) return 4320
  if (/\b(4k|uhd)\b/i.test(t)) return 2160
  if (/\b(2k|qhd)\b/i.test(t)) return 1440
  if (/\b(fhd|full ?hd)\b/i.test(t)) return 1080
  if (/\bhd\b/i.test(t)) return 720
  return null
}

const QUALITY_TOKEN = /[_\-. ]?(?:\d{3,4}p|4k|8k|2k|uhd|qhd|fhd|hd|sd|high|low|medium)(?=$|[_\-. ])/gi

/**
 * Key shared by every quality of the same video: the player it came from, or
 * the file name without its resolution token (`3166239_1080p` → `3166239`).
 */
export function groupKey(item) {
  const name = fileNameFromUrl(item.url).toLowerCase()
  const base = name.replace(QUALITY_TOKEN, '').replace(/[_\-. ]+$/, '')
  return `${hostOf(item.url)}|${base || name || item.url}`
}

export function qualityLabel(h) {
  if (!h) return ''
  if (h >= 4320) return '8K'
  if (h >= 2160) return '4K'
  return `${h}p`
}

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i < 2 ? 0 : 1)} ${u[i]}`
}

export function formatDuration(s) {
  if (!s || !Number.isFinite(s)) return ''
  s = Math.round(s)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** Which browser runs the extension: lets the app show "installed in Brave". */
export async function browserId() {
  try {
    if (navigator.brave && (await navigator.brave.isBrave())) return 'brave'
  } catch {
    /* not Brave */
  }
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) ?? []
  if (brands.some((b) => /Edge/i.test(b))) return 'edge'
  if (brands.some((b) => /Opera/i.test(b))) return 'opera'
  return 'chrome'
}

/** Deep link that opens the Streamline app with the URL pasted and analysed. */
export function deepLink(url, referer, title, browser, sources) {
  const p = new URLSearchParams({ url })
  if (referer && referer !== url) p.set('referer', referer)
  if (title) p.set('title', title.slice(0, 180))
  if (browser) p.set('browser', browser)
  // Every quality of the same video: [{u: url, q: height, s: bytes}]
  if (sources?.length > 1) {
    p.set('sources', JSON.stringify(sources.slice(0, 12).map((x) => ({ u: x.url, q: x.quality || 0, s: x.size || 0 }))))
  }
  return `streamline://download?${p}`
}

/** Tells the app the extension is installed in `browser`. */
export function handshakeLink(browser, version) {
  return `streamline://extension-installed?${new URLSearchParams({ browser, version })}`
}
