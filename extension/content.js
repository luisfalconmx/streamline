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
  const meta = (prop) =>
    document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute('content') || null

  function scan() {
    const items = new Map()
    let hasVideo = false
    let streamOnly = false

    for (const v of document.querySelectorAll('video')) {
      hasVideo = true
      const candidates = [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((s) => s.src)]
      const src = candidates.map((c) => httpUrl(abs(c))).find(Boolean)
      if (!src) {
        // blob:/MediaSource players: only the page URL can be downloaded.
        streamOnly = true
        continue
      }
      items.set(src.split('#')[0], {
        url: src,
        title: v.getAttribute('title') || v.getAttribute('aria-label') || null,
        poster: httpUrl(abs(v.getAttribute('poster'))) || null,
        duration: Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null,
        width: v.videoWidth || null,
        height: v.videoHeight || null,
      })
    }

    for (const a of document.querySelectorAll('a[href]')) {
      const href = httpUrl(abs(a.getAttribute('href')))
      if (!href || !MEDIA_LINK.test(href) || items.has(href.split('#')[0])) continue
      const text = (a.textContent || '').trim().replace(/\s+/g, ' ')
      items.set(href.split('#')[0], { url: href, title: text.length > 2 && text.length < 140 ? text : null })
    }

    const ogVideo = httpUrl(abs(meta('og:video:secure_url') || meta('og:video:url') || meta('og:video')))
    if (ogVideo && MEDIA_LINK.test(ogVideo) && !items.has(ogVideo.split('#')[0])) {
      items.set(ogVideo.split('#')[0], { url: ogVideo, title: null })
    }

    return {
      items: [...items.values()].slice(0, 40),
      page: {
        url: location.href,
        title: meta('og:title') || document.title || location.hostname,
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
