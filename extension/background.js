// Streamline extension — service worker.
// Collects the videos found on each tab (network responses + DOM scan from
// content.js) and keeps them in session storage so the popup can list them.
import { isSegmentHost, mediaKind, SEGMENT_EXT, stripHash } from './shared.js'

const MIN_BYTES = 150 * 1024 // ignore tiny clips, previews and ads
const MAX_ITEMS = 60

const key = (tabId) => `tab:${tabId}`

async function getTab(tabId) {
  const data = await chrome.storage.session.get(key(tabId))
  return data[key(tabId)] ?? { items: {}, redirects: {}, page: null }
}

// Serialise writes per tab so concurrent events don't clobber each other.
const queues = new Map()
function updateTab(tabId, fn) {
  const prev = queues.get(tabId) ?? Promise.resolve()
  const next = prev
    .then(async () => {
      const state = await getTab(tabId)
      const changed = fn(state)
      if (changed === false) return
      await chrome.storage.session.set({ [key(tabId)]: state })
      await updateBadge(tabId, state)
    })
    .catch((e) => console.warn('[streamline]', e))
  queues.set(tabId, next)
  return next
}

async function updateBadge(tabId, state) {
  const n = Object.keys(state.items).length + (state.page?.hasVideo ? 1 : 0)
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c3aed' })
    await chrome.action.setBadgeText({ tabId, text: n ? String(Math.min(n, 99)) : '' })
  } catch {
    /* tab closed */
  }
}

function mergeItem(state, item) {
  const id = stripHash(item.url)
  const prev = state.items[id]
  state.items[id] = { ...prev, ...Object.fromEntries(Object.entries(item).filter(([, v]) => v != null && v !== '')) }
  state.items[id].firstSeen = prev?.firstSeen ?? Date.now()
  const ids = Object.keys(state.items)
  if (ids.length > MAX_ITEMS) {
    ids.sort((a, b) => state.items[a].firstSeen - state.items[b].firstSeen)
    for (const old of ids.slice(0, ids.length - MAX_ITEMS)) delete state.items[old]
  }
}

// --- Network detection -----------------------------------------------------

/** Follow redirects back to the URL the page actually requested (stable link). */
function originalUrl(state, url) {
  let u = url
  for (let i = 0; i < 6 && state.redirects[u]; i++) u = state.redirects[u]
  return u
}

chrome.webRequest.onBeforeRedirect.addListener(
  (d) => {
    if (d.tabId < 0) return
    updateTab(d.tabId, (state) => {
      state.redirects[d.redirectUrl] = d.url
      const ks = Object.keys(state.redirects)
      if (ks.length > 200) delete state.redirects[ks[0]]
    })
  },
  { urls: ['http://*/*', 'https://*/*'] },
)

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return
    if (SEGMENT_EXT.test(d.url) || isSegmentHost(d.url)) return
    const header = (name) => d.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? ''
    const mime = header('content-type')
    const kind = mediaKind(d.url, mime)
    if (!kind || /html|json|javascript|text\/plain/i.test(mime)) return
    if (!mime.toLowerCase().startsWith('video/') && !['HLS', 'DASH'].includes(kind) && !/^(MP4|WEBM|MOV|MKV|M4V)$/.test(kind)) return

    // Total size: Content-Range "bytes 0-1/12345" for ranged requests, else Content-Length.
    const range = header('content-range').match(/\/(\d+)$/)
    const size = range ? Number(range[1]) : Number(header('content-length')) || undefined
    if (size && size < MIN_BYTES && !['HLS', 'DASH'].includes(kind)) return

    updateTab(d.tabId, (state) => {
      const url = originalUrl(state, d.url)
      // HLS variant playlists of the same stream: keep the first (master) one.
      if (kind === 'HLS' && Object.values(state.items).some((i) => i.kind === 'HLS' && i.source === 'network')) return false
      mergeItem(state, { url, kind, size, mime: mime.split(';')[0], source: 'network', main: d.type === 'main_frame' })
    })
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'main_frame', 'sub_frame', 'other', 'object'] },
  ['responseHeaders'],
)

// --- Messages from content scripts and the popup ---------------------------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'dom-videos' && sender.tab?.id != null) {
    const tabId = sender.tab.id
    updateTab(tabId, (state) => {
      if (sender.frameId === 0) {
        state.page = { ...state.page, ...msg.page }
      } else if (msg.page?.hasVideo && msg.page.url) {
        // Embedded player (iframe): its own page is usually what yt-dlp understands.
        mergeItem(state, { url: msg.page.url, kind: 'EMBED', title: msg.page.title, source: 'frame' })
      }
      for (const it of msg.items) mergeItem(state, { ...it, source: 'dom' })
    })
    return false
  }
  if (msg?.type === 'get-tab') {
    getTab(msg.tabId).then(reply)
    return true
  }
  return false
})

// --- Reset when the tab navigates to another page --------------------------

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    queues.delete(tabId)
    chrome.storage.session.remove(key(tabId))
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {})
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  queues.delete(tabId)
  chrome.storage.session.remove(key(tabId))
})
