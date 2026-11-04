// Streamline extension — content script.
// Finds videos in the DOM (<video>, <source>, links to media files, Open Graph
// tags) and reports them to the service worker. Runs in every frame.
;(() => {
  if (window.__streamlineContent) return
  window.__streamlineContent = true

  const MEDIA_LINK = /\.(mp4|m4v|mov|webm|mkv|flv|avi|ogv|m3u8|mpd)(?:$|[?#/])/i

  const abs = (u) => {
    if (!u || !u.trim()) return null
    try {
      return new URL(u, location.href).href
    } catch {
      return null
    }
  }
  const httpUrl = (u) => (u && /^https?:\/\//i.test(u) ? u : null)
  const fileName = (u) => {
    try {
      return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || '')
    } catch {
      return ''
    }
  }

  /** Vertical resolution from labels like "1080p", "4K", "HD" or "video_720p.mp4". */
  function qualityOf(text) {
    if (!text) return null
    const t = String(text)
    const m = t.match(/(?:^|[^0-9])(4320|2160|1440|1080|720|576|540|480|360|240|144)p?(?![0-9])/i)
    if (m) return Number(m[1])
    if (/\b(8k)\b/i.test(t)) return 4320
    if (/\b(4k|uhd)\b/i.test(t)) return 2160
    if (/\b(2k|qhd)\b/i.test(t)) return 1440
    if (/\b(fhd|full ?hd)\b/i.test(t)) return 1080
    if (/\bhd\b/i.test(t)) return 720
    return null
  }

  const meta = (prop) =>
    document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute('content') || null

  function scan() {
    const items = new Map()
    let hasVideo = false
    let streamOnly = false

    let videoIndex = 0
    for (const v of document.querySelectorAll('video')) {
      hasVideo = true
      // All sources of one player are the same video in different qualities.
      const group = `video-${videoIndex++}`
      const sources = [
        { src: v.currentSrc, el: v, current: true },
        { src: v.getAttribute('src'), el: v },
        ...[...v.querySelectorAll('source')].map((el) => ({ src: el.getAttribute('src'), el })),
      ]
      let any = false
      for (const s of sources) {
        const src = httpUrl(abs(s.src))
        if (!src) continue
        any = true
        const key = src.split('#')[0]
        const label = [s.el.getAttribute('label'), s.el.getAttribute('res'), s.el.getAttribute('size'),
          s.el.getAttribute('data-quality'), s.el.getAttribute('data-res'), s.el.getAttribute('title')]
          .filter(Boolean).join(' ')
        const prev = items.get(key) ?? {}
        items.set(key, {
          ...prev,
          url: src,
          group,
          quality: prev.quality ?? qualityOf(label) ?? qualityOf(fileName(src)) ?? ((s.current && v.videoHeight) || null),
          title: v.getAttribute('title') || v.getAttribute('aria-label') || prev.title || null,
          poster: httpUrl(abs(v.getAttribute('poster'))) || null,
          duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null,
          width: s.current ? v.videoWidth || null : prev.width ?? null,
          height: s.current ? v.videoHeight || null : prev.height ?? null,
        })
      }
      // blob:/MediaSource players: only the page URL can be downloaded.
      if (!any) streamOnly = true
    }

    for (const a of document.querySelectorAll('a[href]')) {
      const href = httpUrl(abs(a.getAttribute('href')))
      if (!href || !MEDIA_LINK.test(href) || items.has(href.split('#')[0])) continue
      const text = (a.textContent || '').trim().replace(/\s+/g, ' ')
      items.set(href.split('#')[0], {
        url: href,
        title: text.length > 2 && text.length < 140 ? text : null,
        quality: qualityOf(text) ?? qualityOf(fileName(href)),
      })
    }

    const ogVideo = httpUrl(abs(meta('og:video:secure_url') || meta('og:video:url') || meta('og:video')))
    if (ogVideo && MEDIA_LINK.test(ogVideo) && !items.has(ogVideo.split('#')[0])) {
      items.set(ogVideo.split('#')[0], { url: ogVideo, title: null })
    }

    return {
      items: [...items.values()].slice(0, 40),
      page: {
        url: location.href,
        // The tab title is what the user sees; og:title only as a fallback.
        title: (document.title || meta('og:title') || location.hostname).replace(/\s+/g, ' ').trim(),
        image: httpUrl(abs(meta('og:image') || meta('twitter:image'))),
        hasVideo: hasVideo || !!ogVideo,
        streamOnly,
      },
    }
  }

  let timer = null
  let last = ''
  function report() {
    clearTimeout(timer)
    timer = setTimeout(() => {
      const data = scan()
      const sig = JSON.stringify(data)
      if (sig === last) return
      last = sig
      if (!data.items.length && !data.page.hasVideo && window !== top) return
      try {
        chrome.runtime.sendMessage({ type: 'dom-videos', ...data })
      } catch {
        /* extension reloaded: ignore */
      }
    }, 400)
  }

  report()
  new MutationObserver(report).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'poster'],
  })
  // Players set src/duration late: re-scan when media loads.
  for (const ev of ['loadedmetadata', 'play', 'durationchange']) {
    document.addEventListener(ev, report, true)
  }
})()
