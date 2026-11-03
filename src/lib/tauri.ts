import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { DownloadEvent, DownloadRequest, ToolVersions, YtInfo } from './types'

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
/** Browser preview during development (e.g. inside Docker) uses a mock backend. */
const mockMode = () => import.meta.env.DEV && !isTauri()

function notInTauri(): never {
  throw new Error('Streamline debe ejecutarse dentro de la app de escritorio (pnpm tauri dev).')
}

export async function fetchInfo(url: string, cookiesBrowser?: string): Promise<YtInfo> {
  if (mockMode()) return (await import('./mock')).mockFetchInfo(url)
  if (!isTauri()) notInTauri()
  return invoke<YtInfo>('fetch_info', { url, cookiesBrowser: cookiesBrowser || null })
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
