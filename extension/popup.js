import {
  browserId,
  deepLink,
  fileNameFromUrl,
  formatBytes,
  formatDuration,
  groupKey,
  hostOf,
  isKnownSite,
  mediaKind,
  qualityLabel,
  qualityOf,
} from './shared.js'

const list = document.getElementById('list')
const count = document.getElementById('count')
const tpl = document.getElementById('card-tpl')

const ICONS = {
  size: '<svg viewBox="0 0 24 24" width="13" height="13"><path d="M12 3v12m-4-4 4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  time: '<svg viewBox="0 0 24 24" width="13" height="13"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="13" height="13"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  res: '<svg viewBox="0 0 24 24" width="13" height="13"><rect x="3" y="5" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 21h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
}

// `popup.html?tabId=N` lets the popup be opened as a page for debugging.
const forcedTab = Number(new URLSearchParams(location.search).get('tabId'))
const [tab] = forcedTab
  ? [await chrome.tabs.get(forcedTab)]
  : await chrome.tabs.query({ active: true, currentWindow: true })
const state = tab?.id != null ? await chrome.runtime.sendMessage({ type: 'get-tab', tabId: tab.id }) : null
render(buildEntries(tab, state))

/** Turns what the service worker collected into the cards to show. */
function buildEntries(tab, state) {
  const page = state?.page ?? {}
  const pageUrl = page.url || tab?.url || ''
  // The web page title names the video in the app: "<Título>-1080p".
  const pageTitle = (page.title || tab?.title || '').trim()
  const entries = []
  const items = Object.values(state?.items ?? {})
  const pageIsFile = items.some((i) => i.main)

  // One card per video: items belong together when they share the player
  // (<video> + its <source>s) or the file name without the resolution token.
  const parent = new Map()
  const find = (k) => {
    while (parent.get(k) !== k) k = parent.get(k)
    return k
  }
  const union = (a, b) => {
    for (const k of [a, b]) if (!parent.has(k)) parent.set(k, k)
    parent.set(find(a), find(b))
  }
  const enriched = items.map((i) => {
    const kind = i.kind ?? mediaKind(i.url, i.mime) ?? 'Video'
    const quality = i.quality || i.height || qualityOf(fileNameFromUrl(i.url)) || null
    const single = kind === 'EMBED' || kind === 'HLS' || kind === 'DASH'
    const keys = single ? [`one|${i.url}`] : [`name|${groupKey(i)}`, ...(i.group ? [`dom|${i.group}`] : [])]
    keys.forEach((k) => union(keys[0], k))
    return { ...i, kind, quality, key: keys[0] }
  })

  const groups = new Map()
  for (const i of enriched) {
    const k = find(i.key)
    const g = groups.get(k) ?? { kind: i.kind, sources: [] }
    // Same quality seen twice (player + download link): keep the richer one.
    const dup = i.quality ? g.sources.findIndex((x) => x.quality === i.quality) : -1
    if (dup === -1) g.sources.push(i)
    else if ((i.size ?? 0) > (g.sources[dup].size ?? 0)) g.sources[dup] = { ...g.sources[dup], ...i }
    groups.set(k, g)
  }

  for (const g of groups.values()) {
    // Highest quality first (then biggest file).
    const sources = g.sources.sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || (b.size ?? 0) - (a.size ?? 0))
    const best = sources[0]
    const smallest = [...sources].sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity))[0]
    const qualities = sources.map((s) => s.quality).filter(Boolean)
    entries.push({
      url: best.url,
      referer: pageUrl,
      title: pageTitle || best.title || fileNameFromUrl(best.url) || hostOf(best.url),
      sendTitle: pageTitle || best.title,
      sources,
      // Sites often block hot-linked video previews: prefer posters/page image.
      image: sources.find((s) => s.poster)?.poster || page.image,
      previewVideo: /^(MP4|WEBM|MOV|M4V|OGV)$/.test(g.kind) ? smallest.url : null,
      chips: [g.kind === 'EMBED' ? 'Reproductor' : g.kind, hostOf(best.url)],
      size: best.size,
      duration: sources.find((s) => s.duration)?.duration,
      qualities: qualities.length > 1 ? `${qualities.length} calidades · hasta ${qualityLabel(qualities[0])}` : '',
      resolution: best.width && best.height ? `${best.width}×${best.height}` : best.quality ? qualityLabel(best.quality) : '',
      sortKey: best.size ?? 0,
    })
  }
  entries.sort((a, b) => b.sortKey - a.sortKey)

  // The page itself (YouTube, embedded players…) only when no direct file was found.
  if (pageUrl && !pageIsFile && !entries.length && (page.hasVideo || isKnownSite(pageUrl))) {
    entries.push({
      url: pageUrl,
      referer: undefined,
      title: pageTitle || hostOf(pageUrl),
      sendTitle: pageTitle,
      image: page.image,
      chips: ['Página', hostOf(pageUrl)],
      hint: isKnownSite(pageUrl) ? 'Todas las calidades disponibles' : page.streamOnly ? 'Video en streaming' : '',
    })
  }
  return entries
}

function render(entries) {
  list.textContent = ''
  count.textContent = entries.length ? `${entries.length} ${entries.length === 1 ? 'video' : 'videos'}` : ''

  if (!entries.length) {
    list.innerHTML = `
      <div class="empty">
        <strong>No se detectaron videos</strong>
        <span>Reproduce el video en la página y vuelve a abrir Streamline.</span>
      </div>`
    return
  }
  for (const e of entries) list.append(card(e))
}

function card(e) {
  const node = tpl.content.firstElementChild.cloneNode(true)
  const thumb = node.querySelector('.thumb')
  const empty = node.querySelector('.thumb-empty')
  const dur = node.querySelector('.badge-duration')

  const setDuration = (s) => {
    const text = formatDuration(s)
    if (!text) return
    dur.textContent = text
    dur.hidden = false
  }

  const showVideoFrame = () => {
    if (!e.previewVideo) return
    // A muted <video> paused on an early frame works as a thumbnail and also
    // reveals duration and resolution.
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'metadata'
    v.playsInline = true
    v.src = `${e.previewVideo}#t=8`
    v.addEventListener('loadeddata', () => (empty.hidden = true))
    v.addEventListener('loadedmetadata', () => {
      setDuration(v.duration)
      if (!e.resolution && !e.qualities && v.videoHeight) addMeta(node, 'res', `${v.videoWidth}×${v.videoHeight}`)
    })
    v.addEventListener('error', () => v.remove())
    thumb.prepend(v)
  }

  if (e.image) {
    const img = new Image()
    img.referrerPolicy = 'no-referrer'
    img.alt = ''
    img.onload = () => (empty.hidden = true)
    img.onerror = () => {
      img.remove()
      showVideoFrame()
    }
    img.src = e.image
    thumb.prepend(img)
  } else {
    showVideoFrame()
  }
  setDuration(e.duration)

  const chips = node.querySelector('.chips')
  e.chips.filter(Boolean).forEach((c, i) => {
    const s = document.createElement('span')
    s.className = i === 0 ? 'chip' : 'chip neutral'
    s.textContent = c
    chips.append(s)
  })

  const title = node.querySelector('.title')
  title.textContent = e.title
  title.title = e.title

  if (e.qualities) addMeta(node, 'res', e.qualities)
  else if (e.resolution) addMeta(node, 'res', e.resolution)
  if (e.size) addMeta(node, 'size', formatBytes(e.size))
  if (e.duration) addMeta(node, 'time', formatDuration(e.duration))
  if (e.hint) addMeta(node, null, e.hint)

  const open = node.querySelector('.open')
  open.href = e.url

  const btn = node.querySelector('.download')
  btn.addEventListener('click', async () => {
    // Opening a custom-scheme URL in the current tab hands it to the app
    // without leaving the page (the browser may ask for confirmation once).
    await chrome.tabs.update(tab.id, { url: deepLink(e.url, e.referer, e.sendTitle, await browserId(), e.sources) })
    chrome.storage.local.set({ connected: true })
    btn.classList.add('sent')
    btn.querySelector('span').textContent = 'Abriendo Streamline…'
    setTimeout(() => window.close(), 1400)
  })
  return node
}

function addMeta(node, icon, text) {
  const meta = node.querySelector('.meta')
  const s = document.createElement('span')
  s.innerHTML = icon ? ICONS[icon] : ''
  s.append(text)
  meta.append(s)
}
