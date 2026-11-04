import { Alert, Button, Card, Skeleton, Switch, Tabs, toast } from '@heroui/react'
import { Download, Film, Music, Sparkles, Zap } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes, looksLikeUrl, uid } from '../lib/format'
import { applyPreview, bestThumbnail, buildAudioOptions, buildVideoOptions, nameFromDirectUrl } from '../lib/qualities'
import { buildRequest } from '../lib/request'
import { fetchInfo, probeMedia, readClipboard, type IncomingLink } from '../lib/tauri'
import type { DownloadItem, MediaMode, Settings, YtInfo } from '../lib/types'
import { useStore } from '../store'
import { FolderPicker } from './FolderPicker'
import { Logo } from './Logo'
import { MediaCard } from './MediaCard'
import { PlaylistPanel } from './PlaylistPanel'
import { QualityPicker } from './QualityPicker'
import { SimpleSelect } from './SimpleSelect'
import { UrlBar } from './UrlBar'

const SITES = ['YouTube', 'TikTok', 'Instagram', 'X / Twitter', 'Facebook', 'Vimeo', 'Twitch', 'Reddit', 'SoundCloud', 'Dailymotion']

const CONTAINERS: { value: Settings['mergeFormat']; label: string }[] = [
  { value: 'mp4', label: 'MP4' },
  { value: 'mkv', label: 'MKV' },
  { value: 'webm', label: 'WebM' },
]
const AUDIO_FORMATS: { value: Settings['audioFormat']; label: string }[] = [
  { value: 'mp3', label: 'MP3' },
  { value: 'm4a', label: 'M4A (AAC)' },
  { value: 'opus', label: 'Opus' },
  { value: 'flac', label: 'FLAC' },
  { value: 'wav', label: 'WAV' },
]

interface Props {
  onShowDownloads: () => void
  /** Link received from the browser extension (`streamline://`). */
  incoming?: (IncomingLink & { nonce: number }) | null
}

export function DownloadView({ onShowDownloads, incoming }: Props) {
  const { settings, updateSettings, enqueue } = useStore()
  const [url, setUrl] = useState('')
  const [referer, setReferer] = useState<string>()
  const [probing, setProbing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<YtInfo | null>(null)
  const [mode, setMode] = useState<MediaMode>('video')
  const [selected, setSelected] = useState<string>()
  const requestSeq = useRef(0)
  const lastClipboard = useRef('')

  const analyze = useCallback(
    async (target: string, ref?: string) => {
      const seq = ++requestSeq.current
      setReferer(ref)
      setLoading(true)
      setError(null)
      setInfo(null)
      setSelected(undefined)
      try {
        const data = await fetchInfo(target, settings.cookiesBrowser, ref)
        if (seq !== requestSeq.current) return
        if (data.direct) {
          // yt-dlp names direct files after the CDN script (e.g. "remote_control").
          const name = nameFromDirectUrl(target)
          if (name) data.title = name
        }
        setInfo(data)
        const hasVideo = buildVideoOptions(data, settings).length > 0
        setMode(hasVideo ? 'video' : 'audio')

        // Direct files come without thumbnail/duration: ask ffmpeg in the background.
        if (data.direct && !data.thumbnail) {
          setProbing(true)
          probeMedia(data.webpage_url || target, ref)
            .then((preview) => {
              if (seq !== requestSeq.current) return
              setInfo((cur) => (cur ? applyPreview(cur, preview) : cur))
              if (preview.vcodec) setMode('video')
            })
            .catch(() => {})
            .finally(() => seq === requestSeq.current && setProbing(false))
        }
      } catch (e) {
        if (seq !== requestSeq.current) return
        setError(String(e))
      } finally {
        if (seq === requestSeq.current) setLoading(false)
      }
    },
    [settings],
  )

  // Links sent by the browser extension: paste and analyse automatically.
  useEffect(() => {
    if (!incoming) return
    setUrl(incoming.url)
    analyze(incoming.url, incoming.referer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming?.nonce])

  // Detect links copied to the clipboard when the window gains focus.
  useEffect(() => {
    if (!settings.autoAnalyzeClipboard) return
    const check = async () => {
      const text = (await readClipboard()).trim()
      if (!text || text === lastClipboard.current) return
      lastClipboard.current = text
      if (looksLikeUrl(text) && text !== url && !loading) {
        setUrl(text)
        analyze(text)
      }
    }
    // Remember whatever is already on the clipboard at startup instead of analysing it.
    readClipboard().then((t) => (lastClipboard.current = t.trim()))
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [settings.autoAnalyzeClipboard, analyze, url, loading])

  const isPlaylist = info?._type === 'playlist' || (info?.entries?.length ?? 0) > 0

  const options = useMemo(() => {
    if (!info || isPlaylist) return []
    return mode === 'video' ? buildVideoOptions(info, settings) : buildAudioOptions(info, settings)
  }, [info, isPlaylist, mode, settings])

  const current = options.find((o) => o.key === selected) ?? options[0]

  const download = () => {
    if (!info || !current) return
    const item: DownloadItem = {
      id: uid(),
      url: info.webpage_url || url,
      title: info.title,
      thumbnail: bestThumbnail(info),
      uploader: info.uploader ?? info.channel,
      duration: info.duration,
      qualityLabel: current.label,
      mode,
      estimatedSize: current.size,
      request: buildRequest(info.webpage_url || url, current.format, mode, settings, {
        format: current.audioFormat,
        quality: current.audioQuality,
      }, {
        remux: !!info.direct || info.extractor_key === 'Generic',
        ext: info.direct ? current.ext : undefined,
        title: info.direct ? info.title : undefined,
        referer,
      }),
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    }
    enqueue([item])
    toast.success('Añadido a descargas', {
      description: info.title,
      actionProps: { children: 'Ver', onPress: onShowDownloads, variant: 'tertiary' },
    })
  }

  const empty = !info && !loading && !error

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 py-8">
      {empty && (
        <div className="flex flex-col items-center gap-4 pt-10 pb-4 text-center">
          <Logo className="size-16 drop-shadow-lg" />
          <h1 className="text-4xl font-bold tracking-tight">
            Descarga cualquier video. <span className="brand-text">Sin límites.</span>
          </h1>
          <p className="max-w-xl text-muted">
            Pega un enlace y elige la calidad. Streamline descarga a máxima velocidad usando
            fragmentos en paralelo, sin anuncios y sin límites de tamaño.
          </p>
        </div>
      )}

      <UrlBar value={url} onChange={setUrl} onSubmit={analyze} loading={loading} compact={!empty} />

      {empty && (
        <>
          <div className="flex flex-wrap justify-center gap-2">
            {SITES.map((s) => (
              <span key={s} className="rounded-full border border-border px-3 py-1 text-xs text-muted">
                {s}
              </span>
            ))}
            <span className="rounded-full border border-border px-3 py-1 text-xs text-muted">+1.800 sitios</span>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <Feature icon={<Zap className="size-5" />} title="Velocidad máxima">
              Descarga hasta 32 fragmentos en paralelo y evita el throttling.
            </Feature>
            <Feature icon={<Sparkles className="size-5" />} title="Hasta 8K y HDR">
              Elige resolución, FPS y formato viendo el peso exacto del archivo.
            </Feature>
            <Feature icon={<Music className="size-5" />} title="Solo audio">
              Extrae MP3, M4A, Opus, FLAC o WAV con portada y metadatos.
            </Feature>
          </div>
        </>
      )}

      {loading && <LoadingCard />}

      {error && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>No se pudo analizar el enlace</Alert.Title>
            <Alert.Description className="selectable break-words">{error}</Alert.Description>
          </Alert.Content>
          <Button size="sm" variant="danger-soft" onPress={() => analyze(url, referer)}>
            Reintentar
          </Button>
        </Alert>
      )}

      {info && isPlaylist && <PlaylistPanel info={info} onQueued={onShowDownloads} />}

      {info && !isPlaylist && (
        <>
          <MediaCard info={info} loadingPreview={probing} />

          <Card className="gap-5 p-5">
            <div className="flex items-center justify-between gap-4">
              <Tabs
                selectedKey={mode}
                onSelectionChange={(k) => {
                  setMode(k as MediaMode)
                  setSelected(undefined)
                }}
              >
                <Tabs.ListContainer>
                  <Tabs.List aria-label="Tipo de descarga">
                    <Tabs.Tab id="video" className="whitespace-nowrap">
                      <Film className="mr-1.5 size-4" /> Video
                      <Tabs.Indicator />
                    </Tabs.Tab>
                    <Tabs.Tab id="audio" className="whitespace-nowrap">
                      <Music className="mr-1.5 size-4" /> Solo audio
                      <Tabs.Indicator />
                    </Tabs.Tab>
                  </Tabs.List>
                </Tabs.ListContainer>
              </Tabs>

              {mode === 'video' ? (
                <SimpleSelect
                  ariaLabel="Contenedor"
                  className="w-32"
                  value={settings.mergeFormat}
                  options={CONTAINERS}
                  onChange={(v) => updateSettings({ mergeFormat: v })}
                />
              ) : (
                <SimpleSelect
                  ariaLabel="Formato de audio"
                  className="w-40"
                  value={settings.audioFormat}
                  options={AUDIO_FORMATS}
                  onChange={(v) => {
                    updateSettings({ audioFormat: v })
                    setSelected(undefined)
                  }}
                />
              )}
            </div>

            <QualityPicker options={options} selected={current?.key} onSelect={setSelected} />

            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-separator pt-4">
              <Toggle
                label="Miniatura"
                isSelected={settings.embedThumbnail}
                onChange={(v) => updateSettings({ embedThumbnail: v })}
              />
              <Toggle
                label="Metadatos"
                isSelected={settings.embedMetadata}
                onChange={(v) => updateSettings({ embedMetadata: v })}
              />
              {mode === 'video' && (info.subtitle_langs?.length ?? 0) > 0 && (
                <Toggle
                  label="Subtítulos"
                  isSelected={settings.embedSubs}
                  onChange={(v) => updateSettings({ embedSubs: v })}
                />
              )}
              {info.extractor_key === 'Youtube' && (
                <Toggle
                  label="Quitar patrocinios"
                  isSelected={settings.sponsorblock}
                  onChange={(v) => updateSettings({ sponsorblock: v })}
                />
              )}
            </div>
          </Card>

          <div className="sticky bottom-0 -mx-8 flex items-center gap-4 border-t border-separator bg-background/85 px-8 py-4 backdrop-blur-md">
            <div className="min-w-0 flex-1">
              <FolderPicker compact />
            </div>
            <Button size="lg" className="min-w-56" onPress={download} isDisabled={!current}>
              <Download className="size-5" />
              Descargar {current?.size ? `· ${current.approx ? '≈' : ''}${formatBytes(current.size)}` : ''}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function Toggle({ label, isSelected, onChange }: { label: string; isSelected: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch size="sm" isSelected={isSelected} onChange={onChange}>
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <span className="text-sm">{label}</span>
      </Switch.Content>
    </Switch>
  )
}

function Feature({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <Card className="gap-2 p-5">
      <div className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">{icon}</div>
      <h3 className="font-semibold">{title}</h3>
      <p className="text-sm text-muted">{children}</p>
    </Card>
  )
}

function LoadingCard() {
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex-row gap-5 p-4">
        <Skeleton className="aspect-video w-72 rounded-xl" />
        <div className="flex flex-1 flex-col gap-3 py-2">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-6 w-4/5 rounded-lg" />
          <Skeleton className="h-4 w-3/5 rounded-lg" />
          <Skeleton className="h-4 w-2/5 rounded-lg" />
        </div>
      </Card>
      <Card className="grid grid-cols-3 gap-3 p-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-2xl" />
        ))}
      </Card>
    </div>
  )
}
