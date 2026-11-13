import { Alert, Button, Card, Input, Label, Skeleton, Switch, Tabs, TextField, toast } from '@heroui/react'
import { Download, Film, Music, Sparkles, Zap } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { formatBytes, uid } from '../lib/format'
import {
  applyPreview,
  bestThumbnail,
  buildAudioOptions,
  buildSourceOptions,
  buildVideoOptions,
  heightCount,
  isMediaFileUrl,
  nameFromDirectUrl,
} from '../lib/qualities'
import { buildRequest } from '../lib/request'
import {
  fetchInfo,
  isBotCheck,
  probeMedia,
  probeSizes,
  scrapePage,
  type PageInfo,
  type PageSource,
} from '../lib/tauri'
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

/** Browsers offered when YouTube asks to confirm you're not a bot. */
const SESSION_BROWSERS = [
  { id: 'chrome', name: 'Chrome' },
  { id: 'brave', name: 'Brave' },
  { id: 'firefox', name: 'Firefox' },
  { id: 'edge', name: 'Edge' },
  ...(/Mac/i.test(navigator.userAgent) ? [{ id: 'safari', name: 'Safari' }] : []),
]

interface Props {
  onShowDownloads: () => void
}

interface Analysis {
  info: YtInfo
  /** URL yt-dlp analysed (the page, or a video file / manifest found on it) */
  analyzed: string
  /** Page the video files came from, sent as Referer */
  referer?: string
  /** Each quality is its own file (found on the page) */
  sources?: PageSource[]
}

/**
 * yt-dlp knows the formats of the sites it supports (YouTube, TikTok…). For any
 * other page, the page itself is read: its title names the video and the
 * player's quality menu (every `<source>`, the player config or an HLS
 * manifest) gives all the resolutions, even when only one is loaded.
 */
async function resolveAnalysis(
  target: string,
  ytdlp: PromiseSettledResult<YtInfo>,
  page: PageInfo | null,
  cookies: string | undefined,
): Promise<Analysis> {
  const info = ytdlp.status === 'fulfilled' ? ytdlp.value : null
  const found = info ? heightCount(info) : 0
  // yt-dlp already lists every resolution (YouTube, Vimeo, HLS…): trust it.
  if (info && found >= 2) return withPageDetails({ info, analyzed: target }, page, target)

  let result: Analysis | null = info ? { info, analyzed: target } : null
  const sources = page?.sources ?? []
  const files = sources.filter((s) => !s.manifest && s.quality)
  const manifests = sources.filter((s) => s.manifest)

  if (page && files.length >= 2 && files.length > found) {
    // One file per quality: analyse the best one, list them all.
    const best = files[0]
    try {
      result = { info: await fetchInfo(best.url, cookies, page.url), analyzed: best.url, referer: page.url, sources: files }
    } catch (e) {
      if (!result) throw e
    }
  } else if (page && manifests.length) {
    // HLS/DASH manifest: yt-dlp lists every variant inside it.
    try {
      const m = await fetchInfo(manifests[0].url, cookies, page.url)
      if (!result || heightCount(m) > found) result = { info: m, analyzed: manifests[0].url, referer: page.url }
    } catch (e) {
      if (!result) throw e
    }
  } else if (page && !result && sources.length) {
    const first = sources[0]
    result = { info: await fetchInfo(first.url, cookies, page.url), analyzed: first.url, referer: page.url }
  }

  if (!result) throw ytdlp.status === 'rejected' ? ytdlp.reason : new Error('No se encontró ningún video en la página.')
  return withPageDetails(result, page, target)
}

/** yt-dlp extractors that only read the page generically (no site-specific title). */
const GENERIC_EXTRACTORS = new Set(['Generic', 'HTML5MediaEmbed'])

/** The page title names the video; yt-dlp's title for generic pages is a file or script name. */
function withPageDetails(result: Analysis, page: PageInfo | null, target: string): Analysis {
  const { info } = result
  const generic = !!info.direct || !!result.referer || GENERIC_EXTRACTORS.has(info.extractor_key ?? '')
  const title = generic ? page?.title || (info.direct ? nameFromDirectUrl(target) : undefined) : undefined
  result.info = {
    ...info,
    title: title || info.title,
    // The cover Streamline already downloaded itself (a `data:` URL) always
    // shows; remote thumbnail URLs are often refused to the app's webview
    // (hotlink protection, signed CDN links). Then yt-dlp's thumbnail, except
    // on generic pages where it is only a guess.
    thumbnail:
      (page?.image?.startsWith('data:')
        ? page.image
        : generic
          ? page?.image || info.thumbnail
          : info.thumbnail || page?.image) || undefined,
    webpage_url: info.webpage_url || result.analyzed,
  }
  return result
}

export function DownloadView({ onShowDownloads }: Props) {
  const { settings, updateSettings, enqueue } = useStore()
  const [url, setUrl] = useState('')
  /** Link that was analysed (its hostname labels the preview). */
  const [pastedUrl, setPastedUrl] = useState('')
  const [analysis, setAnalysis] = useState<Omit<Analysis, 'info'> | null>(null)
  /** File name the user can edit before downloading (without extension). */
  const [fileName, setFileName] = useState('')
  /** Analysed with YouTube's 360p fallback clients (no browser session). */
  const [limited, setLimited] = useState(false)
  const [probing, setProbing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<YtInfo | null>(null)
  const [mode, setMode] = useState<MediaMode>('video')
  const [selected, setSelected] = useState<string>()
  const requestSeq = useRef(0)
  const sources = analysis?.sources
  const referer = analysis?.referer

  const analyze = useCallback(
    async (target: string, opts: { cookies?: string; limited?: boolean } = {}) => {
      const seq = ++requestSeq.current
      const cookies = opts.cookies ?? settings.cookiesBrowser
      setLimited(!!opts.limited)
      setPastedUrl(target)
      setAnalysis(null)
      setLoading(true)
      setError(null)
      setInfo(null)
      setSelected(undefined)
      try {
        const [ytdlp, page] = await Promise.allSettled([
          fetchInfo(target, cookies, undefined, opts.limited),
          isMediaFileUrl(target) ? Promise.resolve(null) : scrapePage(target),
        ])
        if (seq !== requestSeq.current) return
        const result = await resolveAnalysis(target, ytdlp, page.status === 'fulfilled' ? page.value : null, cookies)
        if (seq !== requestSeq.current) return
        const { info: data, ...rest } = result
        setAnalysis(rest)
        setInfo(data)
        setFileName(data.title ?? '')
        const hasVideo = !!rest.sources || buildVideoOptions(data, settings).length > 0
        setMode(hasVideo ? 'video' : 'audio')

        // Sizes the page does not say: ask the server (HEAD) in the background.
        const srcs = rest.sources
        if (srcs?.some((x) => !x.size)) {
          probeSizes(srcs.map((x) => x.url), rest.referer).then((sizes) => {
            if (seq !== requestSeq.current) return
            setAnalysis((cur) =>
              cur ? { ...cur, sources: cur.sources?.map((x, i) => (x.size ? x : { ...x, size: sizes[i] ?? undefined })) } : cur,
            )
          })
        }

        // Direct files come without thumbnail/duration: ask ffmpeg in the background.
        if (data.direct && (!data.thumbnail || !data.duration)) {
          setProbing(true)
          probeMedia(rest.analyzed, rest.referer)
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
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (seq === requestSeq.current) setLoading(false)
      }
    },
    [settings],
  )

  const isPlaylist = info?._type === 'playlist' || (info?.entries?.length ?? 0) > 0

  const options = useMemo(() => {
    if (!info || isPlaylist) return []
    if (mode === 'video' && sources && sources.length > 1) return buildSourceOptions(info, sources, analysis!.analyzed)
    return mode === 'video' ? buildVideoOptions(info, settings) : buildAudioOptions(info, settings)
  }, [info, isPlaylist, mode, settings, sources, analysis])

  const current = options.find((o) => o.key === selected) ?? options[0]

  /** Extension the file will get, shown next to the name. */
  const fileExt =
    mode === 'audio'
      ? current?.audioFormat && current.audioFormat !== 'best'
        ? current.audioFormat
        : undefined
      : info?.direct || sources
        ? current?.ext
        : settings.mergeFormat

  const download = () => {
    if (!info || !current) return
    const source = current.url ?? (info.webpage_url || url)
    const name = fileName.replace(/\s+/g, ' ').trim()
    const item: DownloadItem = {
      id: uid(),
      url: source,
      title: name || info.title,
      thumbnail: bestThumbnail(info),
      uploader: info.uploader ?? info.channel,
      duration: info.duration,
      qualityLabel: current.label,
      mode,
      estimatedSize: current.size,
      request: buildRequest(source, current.format, mode, settings, {
        format: current.audioFormat,
        quality: current.audioQuality,
      }, {
        remux: !!info.direct || info.extractor_key === 'Generic',
        ext: info.direct ? current.ext : undefined,
        title: name || undefined,
        referer,
        limited,
      }),
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    }
    enqueue([item])
    toast.success('Añadido a descargas', {
      description: name || info.title,
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

      {error && isBotCheck(error) && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content className="gap-2">
            <Alert.Title>YouTube pide confirmar que no eres un robot</Alert.Title>
            <Alert.Description>
              YouTube marcó tu conexión por hacer muchas solicitudes. Usa tu sesión de YouTube del navegador para
              obtener todas las calidades, o sigue sin sesión con un máximo de 360p.
              {settings.cookiesBrowser ? ` Ahora se usa la sesión de ${BROWSER_LABEL[settings.cookiesBrowser] ?? settings.cookiesBrowser}.` : ''}
            </Alert.Description>
            <div className="flex flex-wrap gap-2 pt-1">
              {SESSION_BROWSERS.map((b) => (
                <Button
                  key={b.id}
                  size="sm"
                  variant={settings.cookiesBrowser === b.id ? 'secondary' : 'primary'}
                  onPress={() => {
                    updateSettings({ cookiesBrowser: b.id })
                    analyze(url, { cookies: b.id })
                  }}
                >
                  Usar mi sesión de {b.name}
                </Button>
              ))}
              <Button size="sm" variant="tertiary" onPress={() => analyze(url, { limited: true })}>
                Seguir sin sesión (máx. 360p)
              </Button>
            </div>
            <p className="text-xs text-muted">
              Necesitas haber iniciado sesión en YouTube en ese navegador. macOS puede pedirte permiso para leer sus datos
              (acceso al llavero): pulsa <b>Permitir siempre</b>.
            </p>
          </Alert.Content>
        </Alert>
      )}

      {error && !isBotCheck(error) && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>No se pudo analizar el enlace</Alert.Title>
            <Alert.Description className="selectable break-words">{friendlyError(error, settings.cookiesBrowser)}</Alert.Description>
          </Alert.Content>
          <Button size="sm" variant="danger-soft" onPress={() => analyze(url, { limited })}>
            Reintentar
          </Button>
        </Alert>
      )}

      {limited && info && (
        <p className="-mt-2 text-xs text-warning">
          Analizado sin sesión de YouTube: calidad máxima 360p. Para más calidad, usa tu sesión del navegador en Ajustes →
          Cookies del navegador.
        </p>
      )}

      {info && isPlaylist && <PlaylistPanel info={info} onQueued={onShowDownloads} />}

      {info && !isPlaylist && (
        <>
          <MediaCard info={info} loadingPreview={probing} site={hostnameOf(pastedUrl)} />

          <Card className="gap-5 p-5">
            <TextField value={fileName} onChange={setFileName} className="gap-1.5">
              <Label className="text-sm font-medium">Nombre del archivo</Label>
              <div className="flex min-w-0 items-center gap-2">
                {/* Grows with the name: an invisible copy of the text sizes the grid cell. */}
                <div className="inline-grid min-w-0 max-w-full *:col-start-1 *:row-start-1">
                  <span aria-hidden className="invisible overflow-hidden border px-3 pr-4 text-base whitespace-pre sm:text-sm">
                    {fileName || info.title}
                  </span>
                  <Input className="w-full min-w-40" placeholder={info.title} />
                </div>
                {fileExt && <span className="shrink-0 text-sm font-medium text-muted">.{fileExt}</span>}
              </div>
            </TextField>

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

          <div className="surface sticky bottom-4 flex items-center gap-4 rounded-3xl px-6 py-4 shadow-overlay backdrop-blur-md">
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

/** `https://www.youtube.com/watch?…` → `youtube.com` */
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || undefined
  } catch {
    return undefined
  }
}

const BROWSER_LABEL: Record<string, string> = {
  brave: 'Brave',
  chrome: 'Google Chrome',
  firefox: 'Firefox',
  safari: 'Safari',
  edge: 'Microsoft Edge',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
}

/** Turns cookie/permission failures into something actionable. */
function friendlyError(error: string, browser?: string): string {
  const name = browser ? (BROWSER_LABEL[browser] ?? browser) : 'el navegador'
  if (browser && /Operation not permitted|Permission denied|PermissionError/i.test(error)) {
    return `macOS no dejó a Streamline leer la sesión de ${name}. Abre Ajustes del Sistema → Privacidad y seguridad → Acceso total al disco, activa Streamline y vuelve a intentarlo. (${error})`
  }
  if (browser && /could not find .*cookies|cookies database|Failed to decrypt|keyring|keychain/i.test(error)) {
    return `No se pudo leer la sesión de ${name}: cierra ${name} por completo y vuelve a intentarlo, o elige otro navegador en Ajustes → Cookies del navegador. (${error})`
  }
  return error
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
