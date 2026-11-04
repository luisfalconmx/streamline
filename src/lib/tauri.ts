import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { DownloadEvent, DownloadRequest, ExtensionStatus, MediaPreview, ToolVersions, YtInfo } from './types'

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
/** Browser preview during development (e.g. inside Docker) uses a mock backend. */
const mockMode = () => import.meta.env.DEV && !isTauri()

function notInTauri(): never {
  throw new Error('Streamline debe ejecutarse dentro de la app de escritorio (pnpm tauri dev).')
}

export async function fetchInfo(url: string, cookiesBrowser?: string, referer?: string): Promise<YtInfo> {
  if (mockMode()) return (await import('./mock')).mockFetchInfo(url)
  if (!isTauri()) notInTauri()
  return invoke<YtInfo>('fetch_info', { url, cookiesBrowser: cookiesBrowser || null, referer: referer || null })
}

/** Real sizes of several direct files (HEAD requests in Rust). */
export async function probeSizes(urls: string[], referer?: string): Promise<(number | null)[]> {
  if (!isTauri()) return urls.map(() => null)
  return invoke<(number | null)[]>('probe_sizes', { urls, referer: referer || null })
}

/** Thumbnail + duration/resolution for direct file links (ffmpeg, a few seconds). */
export async function probeMedia(url: string, referer?: string): Promise<MediaPreview> {
  if (!isTauri()) return {}
  return invoke<MediaPreview>('probe_media', { url, referer: referer || null })
}

/** One quality of the same video, as sent by the browser extension. */
export interface SourceLink {
  url: string
  /** Vertical resolution (1080 for 1080p) when known */
  quality?: number
  size?: number
}

export interface IncomingLink {
  /** Every quality of this video (highest first), when the extension found several */
  sources?: SourceLink[]
  url: string
  referer?: string
  /** Title of the web page the video was found on (browser extension) */
  title?: string
}

function parseSources(raw: string | null): SourceLink[] | undefined {
  if (!raw) return undefined
  try {
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) return undefined
    const out: SourceLink[] = []
    for (const x of list.slice(0, 12)) {
      const url = typeof x?.u === 'string' ? x.u : ''
      if (!/^https?:\/\//i.test(url)) continue
      const q = Number(x.q)
      const s = Number(x.s)
      out.push({
        url,
        quality: Number.isInteger(q) && q > 0 && q <= 8640 ? q : undefined,
        size: Number.isFinite(s) && s > 0 ? s : undefined,
      })
    }
    return out.length > 1 ? out : undefined
  } catch {
    return undefined
  }
}

export type DeepLink =
  | ({ kind: 'download'; browser?: string } & IncomingLink)
  | { kind: 'extension-installed'; browser: string; version?: string }

const BROWSER_ID = /^[a-z]{2,12}$/

/**
 * Parses the links the browser extension sends:
 * - `streamline://download?url=…&referer=…&title=…&browser=brave`
 * - `streamline://extension-installed?browser=brave&version=0.1.4`
 */
export function parseDeepLink(link: string): DeepLink | null {
  try {
    const u = new URL(link)
    if (u.protocol !== 'streamline:') return null
    // `streamline://download?…` → host "download" (WebKit may report it as pathname).
    const action = (u.hostname || u.pathname.replace(/^\/+/, '')).split('/')[0]
    const rawBrowser = u.searchParams.get('browser')?.toLowerCase()
    const browser = rawBrowser && BROWSER_ID.test(rawBrowser) ? rawBrowser : undefined

    if (action === 'extension-installed') {
      return browser ? { kind: 'extension-installed', browser, version: u.searchParams.get('version') ?? undefined } : null
    }
    const url = u.searchParams.get('url') ?? ''
    if (!/^https?:\/\//i.test(url)) return null
    const referer = u.searchParams.get('referer') ?? undefined
    const title = u.searchParams.get('title')?.replace(/\s+/g, ' ').trim().slice(0, 180) || undefined
    return {
      kind: 'download',
      url,
      referer: referer && /^https?:\/\//i.test(referer) ? referer : undefined,
      title,
      browser,
      sources: parseSources(u.searchParams.get('sources')),
    }
  } catch {
    return null
  }
}

/** Calls `handler` for the link that launched the app and for every later one. */
export async function onDeepLink(handler: (link: DeepLink) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link')
  const handle = (urls: string[] | null) => {
    for (const raw of urls ?? []) {
      const link = parseDeepLink(raw)
      if (link) handler(link)
    }
  }
  handle(await getCurrent().catch(() => null))
  const unlisten = await onOpenUrl(handle)
  return unlisten
}

export async function focusWindow(): Promise<void> {
  if (!isTauri()) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const w = getCurrentWindow()
  await w.unminimize().catch(() => {})
  await w.show().catch(() => {})
  await w.setFocus().catch(() => {})
}

export async function startDownload(request: DownloadRequest): Promise<void> {
  if (mockMode()) return (await import('./mock')).mockStartDownload(request)
  if (!isTauri()) notInTauri()
  return invoke('start_download', { request })
}

export async function cancelDownload(id: string): Promise<void> {
  if (mockMode()) return (await import('./mock')).mockCancel(id)
  if (!isTauri()) return
  return invoke('cancel_download', { id })
}

export async function defaultDownloadDir(): Promise<string> {
  if (!isTauri()) return '~/Downloads/Streamline'
  return invoke<string>('default_download_dir')
}

export async function toolVersions(): Promise<ToolVersions> {
  if (!isTauri()) return {}
  return invoke<ToolVersions>('tool_versions')
}

export async function updateYtdlp(): Promise<string> {
  if (!isTauri()) notInTauri()
  return invoke<string>('update_ytdlp')
}

export async function revealFile(path: string): Promise<void> {
  if (!isTauri()) return
  return invoke('reveal_file', { path })
}

export async function openFile(path: string): Promise<void> {
  if (!isTauri()) return
  return invoke('open_file', { path })
}

export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const result = await open({ directory: true, multiple: false, defaultPath })
  return typeof result === 'string' ? result : null
}

export async function readClipboard(): Promise<string> {
  try {
    if (isTauri()) {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
      return (await readText()) ?? ''
    }
    return await navigator.clipboard.readText()
  } catch {
    return ''
  }
}

export async function openUrl(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, '_blank')
    return
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}

export function onDownloadEvent(handler: (e: DownloadEvent) => void): Promise<UnlistenFn> {
  if (mockMode()) return import('./mock').then((m) => m.mockListen(handler)).then((un) => () => void un())
  if (!isTauri()) return Promise.resolve(() => {})
  return listen<DownloadEvent>('download-event', (e) => handler(e.payload))
}

// --- Browser extension ------------------------------------------------------

const MOCK_EXTENSION: ExtensionStatus = {
  os: /Mac/i.test(navigator.userAgent) ? 'macos' : /Windows/i.test(navigator.userAgent) ? 'windows' : 'linux',
  dir: '~/Library/Application Support/com.luisfalconmx.streamline/extension',
  shortcut: '~/Streamline Extension',
  bundledVersion: '0.1.4',
  copiedVersion: null,
  anyInstalled: false,
  browsers: [
    { id: 'chrome', name: 'Google Chrome', available: true, extensionInstalled: false },
    { id: 'brave', name: 'Brave', available: true, extensionInstalled: false },
  ],
}

export async function extensionStatus(): Promise<ExtensionStatus> {
  if (!isTauri()) return MOCK_EXTENSION
  return invoke<ExtensionStatus>('extension_status')
}

export interface InstalledExtension {
  /** Real folder inside the app data directory */
  path: string
  /** What to select in the browser (the ~/Streamline Extension shortcut on macOS) */
  pick: string
}

/** Copies (or updates) the bundled extension into the app data folder. */
export async function installExtension(): Promise<InstalledExtension> {
  if (!isTauri()) return { path: MOCK_EXTENSION.dir, pick: MOCK_EXTENSION.shortcut ?? MOCK_EXTENSION.dir }
  return invoke<InstalledExtension>('install_extension')
}

export async function openExtensionsPage(browser: 'chrome' | 'brave'): Promise<void> {
  if (!isTauri()) return
  return invoke('open_extensions_page', { browser })
}

export async function writeClipboard(text: string): Promise<void> {
  try {
    if (isTauri()) {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
      await writeText(text)
    } else {
      await navigator.clipboard.writeText(text)
    }
  } catch {
    /* ignore */
  }
}


// --- Floating guide window ---------------------------------------------------

let savedGeometry: { w: number; h: number; x: number; y: number } | null = null

/**
 * While the user follows the install steps in the browser, shrink Streamline to
 * a small always-on-top panel on the right so the instructions stay visible.
 */
export async function setFloatingGuide(on: boolean): Promise<void> {
  if (!isTauri()) return
  const { getCurrentWindow, currentMonitor, LogicalSize, LogicalPosition } = await import('@tauri-apps/api/window')
  const w = getCurrentWindow()
  try {
    if (on) {
      if (!savedGeometry) {
        const scale = await w.scaleFactor()
        const size = (await w.outerSize()).toLogical(scale)
        const pos = (await w.outerPosition()).toLogical(scale)
        savedGeometry = { w: size.width, h: size.height, x: pos.x, y: pos.y }
      }
      const mon = await currentMonitor()
      const width = 480
      const height = 660
      await w.setMinSize(null)
      await w.setSize(new LogicalSize(width, height))
      if (mon) {
        const ms = mon.size.toLogical(mon.scaleFactor)
        const mp = mon.position.toLogical(mon.scaleFactor)
        await w.setPosition(new LogicalPosition(mp.x + ms.width - width - 24, mp.y + 64))
      }
      await w.setAlwaysOnTop(true)
    } else if (savedGeometry) {
      const g = savedGeometry
      savedGeometry = null
      await w.setAlwaysOnTop(false)
      await w.setSize(new LogicalSize(g.w, g.h))
      await w.setPosition(new LogicalPosition(g.x, g.y))
      await w.setMinSize(new LogicalSize(860, 620))
    }
  } catch (e) {
    console.warn('floating guide', e)
  }
}
