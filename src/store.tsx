import { toast } from '@heroui/react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { cancelDownload, defaultDownloadDir, onDownloadEvent, startDownload } from './lib/tauri'
import type { DownloadEvent, DownloadItem, Settings } from './lib/types'

const SETTINGS_KEY = 'streamline.settings.v1'
const HISTORY_KEY = 'streamline.history.v1'

export const DEFAULT_SETTINGS: Settings = {
  outputDir: '',
  mergeFormat: 'mp4',
  preferH264: false,
  audioFormat: 'mp3',
  embedThumbnail: true,
  embedMetadata: true,
  embedSubs: false,
  subLangs: 'es.*,en.*',
  sponsorblock: false,
  concurrentFragments: 8,
  maxParallel: 3,
  cookiesBrowser: '',
  autoAnalyzeClipboard: true,
  filenameTemplate: '%(title).180B.%(ext)s',
  extensionWizardDone: false,
  extensionConfirmed: [],
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

function loadHistory(): DownloadItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const items: DownloadItem[] = raw ? JSON.parse(raw) : []
    // Anything that was running when the app closed is now interrupted.
    return items.map((i) =>
      ['queued', 'starting', 'downloading', 'processing'].includes(i.status)
        ? { ...i, status: 'error', error: 'Descarga interrumpida al cerrar la app' }
        : i,
    )
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Downloads reducer
// ---------------------------------------------------------------------------

type Action =
  | { type: 'add'; items: DownloadItem[] }
  | { type: 'patch'; id: string; patch: Partial<DownloadItem> }
  | { type: 'event'; event: DownloadEvent }
  | { type: 'remove'; id: string }
  | { type: 'clearFinished' }

function stageLabel(pp: string): string {
  if (pp === 'Merger') return 'Uniendo video y audio'
  if (pp === 'ExtractAudio') return 'Convirtiendo audio'
  if (pp.includes('Convertor') || pp.includes('Remux')) return 'Convirtiendo'
  if (pp.includes('Thumbnail')) return 'Insertando miniatura'
  if (pp.includes('Metadata')) return 'Guardando metadatos'
  if (pp.includes('Subtitle')) return 'Insertando subtítulos'
  if (pp.includes('SponsorBlock') || pp.includes('ModifyChapters')) return 'Quitando patrocinios'
  if (pp === 'MoveFiles') return 'Finalizando'
  return 'Procesando'
}

function reducer(state: DownloadItem[], action: Action): DownloadItem[] {
  switch (action.type) {
    case 'add':
      return [...action.items, ...state]
    case 'patch':
      return state.map((i) => (i.id === action.id ? { ...i, ...action.patch } : i))
    case 'remove':
      return state.filter((i) => i.id !== action.id)
    case 'clearFinished':
      return state.filter((i) => !['done', 'error', 'cancelled'].includes(i.status))
    case 'event': {
      const e = action.event
      return state.map((i) => {
        if (i.id !== e.id) return i
        switch (e.kind) {
          case 'progress': {
            const total = e.total ?? undefined
            const downloaded = e.downloaded ?? undefined
            let streamProgress =
              total && downloaded != null
                ? downloaded / total
                : e.fragmentCount && e.fragmentIndex
                  ? e.fragmentIndex / e.fragmentCount
                  : 0
            if (e.status === 'finished') streamProgress = 1
            // Separate video + audio streams: video ≈ 90% of the work, audio the rest.
            const split = i.mode === 'video' && e.stream !== 'av'
            const progress = !split
              ? streamProgress
              : e.stream === 'video'
                ? streamProgress * 0.9
                : Math.max(i.progress, 0.9 + streamProgress * 0.1)
            const completedBytes =
              e.status === 'finished' ? (i.completedBytes ?? 0) + (total ?? downloaded ?? 0) : i.completedBytes
            return {
              ...i,
              status: 'downloading',
              stage: split && e.stream === 'audio' ? 'Descargando audio' : 'Descargando',
              stream: e.stream,
              downloaded: e.status === 'finished' ? undefined : downloaded,
              total: e.status === 'finished' ? undefined : total,
              completedBytes,
              speed: e.speed ?? undefined,
              eta: e.eta ?? undefined,
              progress: Math.min(1, Math.max(0, progress)),
            }
          }
          case 'stage':
            return { ...i, status: 'processing', stage: stageLabel(e.stage), speed: undefined, eta: undefined }
          case 'file':
            return { ...i, filePath: e.path }
          case 'done':
            return { ...i, status: 'done', progress: 1, stage: undefined, speed: undefined, eta: undefined, finishedAt: Date.now() }
          case 'error':
            return { ...i, status: 'error', error: e.message, speed: undefined, eta: undefined, finishedAt: Date.now() }
          case 'cancelled':
            return { ...i, status: 'cancelled', speed: undefined, eta: undefined, finishedAt: Date.now() }
        }
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface Store {
  settings: Settings
  updateSettings: (patch: Partial<Settings>) => void
  resetSettings: () => void
  downloads: DownloadItem[]
  enqueue: (items: DownloadItem[]) => void
  cancel: (id: string) => void
  retry: (id: string) => void
  remove: (id: string) => void
  clearFinished: () => void
  activeCount: number
}

const StoreContext = createContext<Store | null>(null)

const ACTIVE = new Set(['starting', 'downloading', 'processing'])

export function StoreProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => load(SETTINGS_KEY, DEFAULT_SETTINGS))
  const [downloads, dispatch] = useReducer(reducer, undefined, loadHistory)
  const starting = useRef(new Set<string>())

  // Resolve default download folder on first run.
  useEffect(() => {
    if (!settings.outputDir) {
      defaultDownloadDir().then((dir) => setSettings((s) => ({ ...s, outputDir: s.outputDir || dir })))
    }
  }, [settings.outputDir])

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      /* ignore */
    }
  }, [settings])

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(downloads.slice(0, 200)))
    } catch {
      /* ignore */
    }
  }, [downloads])

  // Backend events.
  const titles = useRef(new Map<string, string>())
  useEffect(() => {
    titles.current = new Map(downloads.map((d) => [d.id, d.title]))
  }, [downloads])
  useEffect(() => {
    const un = onDownloadEvent((event) => {
      dispatch({ type: 'event', event })
      const title = titles.current.get(event.id) ?? 'Descarga'
      if (event.kind === 'done') {
        toast.success('Descarga completada', { description: title })
      } else if (event.kind === 'error') {
        toast.danger('Error en la descarga', { description: event.message })
      }
    })
    return () => {
      un.then((f) => f())
    }
  }, [])

  // Queue runner: keep up to `maxParallel` downloads running.
  useEffect(() => {
    const running = downloads.filter((d) => ACTIVE.has(d.status)).length
    let slots = Math.max(0, settings.maxParallel - running)
    if (!slots) return
    const queued = downloads.filter((d) => d.status === 'queued' && !starting.current.has(d.id)).reverse()
    for (const item of queued) {
      if (!slots--) break
      starting.current.add(item.id)
      dispatch({ type: 'patch', id: item.id, patch: { status: 'starting', stage: 'Preparando…' } })
      startDownload({ ...item.request, id: item.id })
        .catch((err) =>
          dispatch({ type: 'event', event: { kind: 'error', id: item.id, message: String(err) } }),
        )
        .finally(() => starting.current.delete(item.id))
    }
  }, [downloads, settings.maxParallel])

  const updateSettings = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), [])
  const resetSettings = useCallback(
    () =>
      setSettings((s) => ({
        ...DEFAULT_SETTINGS,
        outputDir: s.outputDir,
        extensionWizardDone: s.extensionWizardDone,
        extensionConfirmed: s.extensionConfirmed,
      })),
    [],
  )
  const enqueue = useCallback((items: DownloadItem[]) => dispatch({ type: 'add', items }), [])
  const cancel = useCallback(
    (id: string) => {
      const item = downloads.find((d) => d.id === id)
      if (item?.status === 'queued') {
        dispatch({ type: 'event', event: { kind: 'cancelled', id } })
      } else {
        cancelDownload(id)
      }
    },
    [downloads],
  )
  const retry = useCallback(
    (id: string) =>
      dispatch({
        type: 'patch',
        id,
        patch: { status: 'queued', error: undefined, progress: 0, downloaded: undefined, total: undefined, completedBytes: undefined, stage: undefined },
      }),
    [],
  )
  const remove = useCallback((id: string) => dispatch({ type: 'remove', id }), [])
  const clearFinished = useCallback(() => dispatch({ type: 'clearFinished' }), [])

  const activeCount = downloads.filter((d) => ACTIVE.has(d.status) || d.status === 'queued').length

  const value = useMemo<Store>(
    () => ({
      settings,
      updateSettings,
      resetSettings,
      downloads,
      enqueue,
      cancel,
      retry,
      remove,
      clearFinished,
      activeCount,
    }),
    [settings, updateSettings, resetSettings, downloads, enqueue, cancel, retry, remove, clearFinished, activeCount],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used inside <StoreProvider>')
  return ctx
}
