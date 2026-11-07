import { Button, Card, Chip, Input, Label, ProgressBar, Spinner, Switch, TextField, toast, Tooltip } from '@heroui/react'
import {
  Camera,
  FileVideo,
  FolderOpen,
  ImagePlus,
  Pause,
  Play,
  Redo2,
  Save,
  Scissors,
  SkipBack,
  SkipForward,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatBytes, uid } from '../../lib/format'
import {
  editorCapture,
  editorExport,
  editorKeyframes,
  editorOpen,
  fileSrc,
  onEditorProgress,
  pickImageFile,
  pickVideoFile,
  revealFile,
  type EditorMedia,
} from '../../lib/tauri'
import { useStore } from '../../store'
import { Timeline } from './Timeline'
import { formatTime, keepRanges, normalizeCuts, snapCut, type Cut } from './cuts'

interface Props {
  /** File to open (pencil button in Descargas); `nonce` re-opens the same one. */
  request?: { path: string; nonce: number } | null
}

export function EditorView({ request }: Props) {
  const { downloads, settings } = useStore()
  const [media, setMedia] = useState<EditorMedia | null>(null)
  const [src, setSrc] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    try {
      const m = await editorOpen(path)
      setMedia(m)
      setSrc(m.previewPath ? await fileSrc(m.previewPath) : undefined)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (request?.path) open(request.path)
  }, [request?.nonce, request?.path, open])

  const chooseFile = async () => {
    const p = await pickVideoFile(settings.outputDir)
    if (p) open(p)
  }

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
        <Spinner />
        Abriendo video…
      </div>
    )
  }

  if (!media) {
    const recent = downloads.filter((d) => d.status === 'done' && d.filePath && d.mode === 'video').slice(0, 8)
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 py-10">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Scissors className="size-7" />
          </div>
          <h1 className="text-2xl font-bold">Editor de video</h1>
          <p className="max-w-md text-sm text-muted">
            Recorta las partes que no quieres, cambia el título y elige la portada. Los cortes no recodifican: un video
            4K sigue en 4K con la misma calidad.
          </p>
          <Button className="mt-2" onPress={chooseFile}>
            <FolderOpen className="size-4" /> Elegir video del equipo
          </Button>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>

        {recent.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold tracking-wider text-muted uppercase">Descargados recientemente</h2>
            <div className="grid grid-cols-2 gap-3">
              {recent.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => open(d.filePath!)}
                  className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-2.5 text-left transition hover:border-accent hover:bg-accent-soft"
                >
                  <div className="aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-default">
                    {d.thumbnail && <img src={d.thumbnail} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />}
                  </div>
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-sm font-medium">{d.title}</p>
                    <p className="text-xs text-muted">{d.qualityLabel}</p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    )
  }

  return <Editor key={media.path + (media.size ?? '')} media={media} src={src} onReload={open} onClose={() => setMedia(null)} onPickOther={chooseFile} />
}

// ---------------------------------------------------------------------------

interface EditorProps {
  media: EditorMedia
  src?: string
  onReload: (path: string) => Promise<void>
  onClose: () => void
  onPickOther: () => void
}

function Editor({ media, src, onReload, onClose, onPickOther }: EditorProps) {
  const video = useRef<HTMLVideoElement>(null)
  const duration = media.duration
  const [current, setCurrent] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [cuts, setCuts] = useState<Cut[]>([])
  const [history, setHistory] = useState<Cut[][]>([])
  const [future, setFuture] = useState<Cut[][]>([])
  const [markIn, setMarkIn] = useState<number | null>(null)
  const [keyframes, setKeyframes] = useState<number[]>([])
  const [precise, setPrecise] = useState(false)
  const [skipCuts, setSkipCuts] = useState(true)
  const [title, setTitle] = useState(media.title ?? media.fileName.replace(/\.[^.]+$/, ''))
  const [cover, setCover] = useState<{ path: string; url: string } | null>(null)
  const [oldCoverUrl, setOldCoverUrl] = useState<string>()
  const [capturing, setCapturing] = useState(false)
  const [exporting, setExporting] = useState<{ jobId: string; progress: number; stage: string } | null>(null)
  const [confirmReplace, setConfirmReplace] = useState(false)

  useEffect(() => {
    editorKeyframes(media.path).then(setKeyframes).catch(() => setKeyframes([]))
    if (media.coverPath) fileSrc(media.coverPath).then(setOldCoverUrl)
  }, [media.path, media.coverPath])

  useEffect(() => {
    const un = onEditorProgress((p) => setExporting((cur) => (cur && cur.jobId === p.jobId ? { ...cur, ...p } : cur)))
    return () => {
      un.then((f) => f())
    }
  }, [])

  // Lossless mode snaps where the video resumes to a keyframe.
  const effectiveCuts = useMemo(() => {
    const n = normalizeCuts(cuts, duration)
    return precise ? n : n.map((c) => snapCut(c, keyframes, duration))
  }, [cuts, keyframes, precise, duration])
  const keep = useMemo(() => keepRanges(effectiveCuts, duration), [effectiveCuts, duration])
  const finalDuration = keep.reduce((acc, [a, b]) => acc + (b - a), 0)
  const dirty = cuts.length > 0 || !!cover || title.trim() !== (media.title ?? media.fileName.replace(/\.[^.]+$/, ''))

  const commit = (next: Cut[]) => {
    setHistory((h) => [...h.slice(-50), cuts])
    setFuture([])
    setCuts(next)
  }
  const addCut = (start: number, end: number) => {
    if (end - start < 0.1) return
    commit(normalizeCuts([...cuts, { id: uid(), start, end }], duration))
  }
  const undo = () => {
    const prev = history.at(-1)
    if (!prev) return
    setFuture((f) => [cuts, ...f])
    setHistory((h) => h.slice(0, -1))
    setCuts(prev)
  }
  const redo = () => {
    const next = future[0]
    if (!next) return
    setHistory((h) => [...h, cuts])
    setFuture((f) => f.slice(1))
    setCuts(next)
  }

  // --- Player --------------------------------------------------------------
  const seek = (t: number) => {
    const v = video.current
    const time = Math.min(Math.max(t, 0), duration)
    if (v) v.currentTime = time
    setCurrent(time)
  }
  const togglePlay = () => {
    const v = video.current
    if (!v) return
    if (v.paused) v.play()
    else v.pause()
  }
  const step = (frames: number) => seek(current + frames / (media.fps || 30))

  const onTime = () => {
    const v = video.current
    if (!v) return
    // Preview the result: jump over the removed parts while playing.
    if (skipCuts && !v.paused) {
      const inCut = effectiveCuts.find((c) => v.currentTime >= c.start && v.currentTime < c.end - 0.05)
      if (inCut) {
        v.currentTime = inCut.end >= duration - 0.05 ? duration : inCut.end
        if (inCut.end >= duration - 0.05) v.pause()
      }
    }
    setCurrent(v.currentTime)
  }

  const markInHere = () => setMarkIn(current)
  const markOutHere = () => {
    if (markIn == null) {
      // No IN mark: cut from the start of the video to here.
      addCut(0, current)
    } else {
      addCut(Math.min(markIn, current), Math.max(markIn, current))
    }
    setMarkIn(null)
  }

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable="true"]')) return
      const mod = e.metaKey || e.ctrlKey
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      } else if (e.key.toLowerCase() === 'i' && !mod) markInHere()
      else if (e.key.toLowerCase() === 'o' && !mod) markOutHere()
      else if (e.key === 'ArrowLeft') seek(current - (e.shiftKey ? 5 : 1 / (media.fps || 30)))
      else if (e.key === 'ArrowRight') seek(current + (e.shiftKey ? 5 : 1 / (media.fps || 30)))
      else if (mod && e.key.toLowerCase() === 'z' && e.shiftKey) redo()
      else if (mod && e.key.toLowerCase() === 'z') undo()
      else return
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // --- Cover ---------------------------------------------------------------
  const captureFrame = async () => {
    setCapturing(true)
    try {
      const path = await editorCapture(media.path, video.current?.currentTime ?? current)
      setCover({ path, url: await fileSrc(path) })
      toast.success('Fotograma capturado como portada', { description: `En ${formatTime(current, true)}, a resolución completa` })
    } catch (e) {
      toast.danger('No se pudo capturar el fotograma', { description: String(e) })
    } finally {
      setCapturing(false)
    }
  }
  const chooseCover = async () => {
    try {
      const path = await pickImageFile()
      if (path) setCover({ path, url: await fileSrc(path) })
    } catch (e) {
      toast.danger('Imagen no válida', { description: String(e) })
    }
  }

  // --- Save ------------------------------------------------------------------
  const save = async (saveAs: 'copy' | 'original') => {
    if (!keep.length) {
      toast.danger('No queda ninguna parte del video', { description: 'Quita algún corte antes de guardar.' })
      return
    }
    const jobId = uid()
    setExporting({ jobId, progress: 0, stage: 'Preparando' })
    video.current?.pause()
    try {
      const out = await editorExport({
        jobId,
        path: media.path,
        keep,
        title: title.trim() || undefined,
        coverPath: cover?.path,
        precise,
        saveAs,
      })
      toast.success(saveAs === 'copy' ? 'Copia guardada' : 'Original reemplazado', {
        description: out.split(/[\\/]/).pop(),
        actionProps: { children: 'Mostrar', onPress: () => revealFile(out), variant: 'tertiary' },
      })
      if (saveAs === 'original') await onReload(out)
    } catch (e) {
      toast.danger('No se pudo guardar', { description: String(e) })
    } finally {
      setExporting(null)
      setConfirmReplace(false)
    }
  }

  const coverUrl = cover?.url ?? oldCoverUrl
  const busy = !!exporting

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 gap-5 overflow-y-auto px-6 py-5">
        {/* ---------------- Player + timeline ---------------- */}
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex items-center gap-2">
            <FileVideo className="size-4 shrink-0 text-muted" />
            <span className="selectable truncate text-sm font-medium" title={media.path}>
              {media.fileName}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <Button size="sm" variant="ghost" onPress={onPickOther} isDisabled={busy}>
                <FolderOpen className="size-4" /> Abrir otro
              </Button>
              <Button size="sm" variant="ghost" onPress={onClose} isDisabled={busy}>
                Cerrar
              </Button>
            </div>
          </div>

          <div className="relative overflow-hidden rounded-2xl bg-black">
            {src ? (
              <video
                ref={video}
                src={src}
                className="mx-auto aspect-video max-h-[46vh] w-full object-contain"
                onTimeUpdate={onTime}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onClick={togglePlay}
                muted={muted}
                preload="auto"
                playsInline
              />
            ) : (
              <div className="flex aspect-video max-h-[46vh] w-full items-center justify-center text-sm text-white/70">
                Este formato no se puede previsualizar, pero sí editar.
              </div>
            )}
          </div>

          {/* Transport */}
          <div className="flex items-center gap-1.5">
            <IconBtn label="Fotograma anterior (←)" onPress={() => step(-1)}>
              <SkipBack className="size-4" />
            </IconBtn>
            <Button isIconOnly aria-label={playing ? 'Pausa' : 'Reproducir'} onPress={togglePlay}>
              {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
            <IconBtn label="Fotograma siguiente (→)" onPress={() => step(1)}>
              <SkipForward className="size-4" />
            </IconBtn>
            <IconBtn label={muted ? 'Activar sonido' : 'Silenciar'} onPress={() => setMuted((m) => !m)}>
              {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </IconBtn>
            <span className="ml-2 text-sm tabular-nums">
              {formatTime(current, true)} <span className="text-muted">/ {formatTime(duration, true)}</span>
            </span>

            <div className="ml-auto flex items-center gap-1.5">
              <Button size="sm" variant={markIn != null ? 'secondary' : 'tertiary'} onPress={markInHere}>
                Marcar inicio <Kbd>I</Kbd>
              </Button>
              <Button size="sm" variant="danger-soft" onPress={markOutHere}>
                <Scissors className="size-4" /> Cortar hasta aquí <Kbd>O</Kbd>
              </Button>
            </div>
          </div>

          <Timeline
            duration={duration}
            current={current}
            cuts={effectiveCuts}
            markIn={markIn}
            keyframes={keyframes}
            showKeyframes={!precise && keyframes.length < 400}
            onSeek={seek}
            onSelect={addCut}
          />

          <p className="-mt-2 text-xs text-muted">
            Arrastra sobre la línea de tiempo para marcar una parte a eliminar, o usa <Kbd>I</Kbd> y <Kbd>O</Kbd>.{' '}
            {!precise && keyframes.length > 0 && 'Las líneas finas son fotogramas clave: el video se reanuda en el más cercano.'}
          </p>

          {/* Cuts list */}
          <Card className="gap-0 p-0">
            <div className="flex items-center gap-2 border-b border-separator px-4 py-2.5">
              <Scissors className="size-4 text-muted" />
              <span className="text-sm font-semibold">Partes a eliminar</span>
              <Chip size="sm" variant="soft">
                {effectiveCuts.length}
              </Chip>
              <div className="ml-auto flex items-center gap-1">
                <IconBtn label="Deshacer (⌘Z)" onPress={undo} disabled={!history.length}>
                  <Undo2 className="size-4" />
                </IconBtn>
                <IconBtn label="Rehacer (⌘⇧Z)" onPress={redo} disabled={!future.length}>
                  <Redo2 className="size-4" />
                </IconBtn>
              </div>
            </div>
            {effectiveCuts.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted">Aún no hay cortes. El video se guardará completo.</p>
            ) : (
              <ul className="max-h-40 overflow-y-auto">
                {effectiveCuts.map((c, i) => (
                  <li key={c.id} className="flex items-center gap-3 px-4 py-2 text-sm hover:bg-surface-hover">
                    <span className="w-5 text-xs text-muted">{i + 1}</span>
                    <button type="button" className="tabular-nums hover:underline" onClick={() => seek(c.start)}>
                      {formatTime(c.start, true)} → {formatTime(c.end, true)}
                    </button>
                    <span className="text-xs text-muted">({formatTime(c.end - c.start, true)})</span>
                    <IconBtn label="Quitar corte" onPress={() => commit(cuts.filter((x) => x.id !== c.id))} className="ml-auto">
                      <Trash2 className="size-4" />
                    </IconBtn>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* ---------------- Side panel ---------------- */}
        <aside className="flex w-72 shrink-0 flex-col gap-4">
          <TextField value={title} onChange={setTitle} isDisabled={busy}>
            <Label>Título</Label>
            <Input placeholder="Título del video" />
          </TextField>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Portada</span>
            <div className="relative aspect-video overflow-hidden rounded-xl border border-border bg-default">
              {coverUrl ? (
                <img src={coverUrl} alt="Portada" className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center text-xs text-muted">Sin portada</div>
              )}
              {cover && (
                <span className="absolute top-2 left-2 rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-accent-foreground">
                  NUEVA
                </span>
              )}
            </div>
            {media.coverSupported ? (
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" variant="secondary" onPress={captureFrame} isPending={capturing} isDisabled={busy}>
                  <Camera className="size-4" /> Capturar
                </Button>
                <Button size="sm" variant="tertiary" onPress={chooseCover} isDisabled={busy}>
                  <ImagePlus className="size-4" /> Imagen…
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted">Los archivos {media.container.toUpperCase()} no admiten portada.</p>
            )}
            {cover && (
              <Button size="sm" variant="ghost" onPress={() => setCover(null)} isDisabled={busy}>
                Restaurar portada original
              </Button>
            )}
          </div>

          <Card className="gap-1.5 p-3.5 text-xs">
            <Info label="Resolución">
              {media.width}×{media.height}
              {media.fps ? ` · ${Math.round(media.fps)} fps` : ''}
            </Info>
            <Info label="Códecs">{[media.vcodec, media.acodec].filter(Boolean).join(' / ').toUpperCase()}</Info>
            <Info label="Tamaño">{formatBytes(media.size)}</Info>
            <Info label="Duración">
              {formatTime(duration)} → <b>{formatTime(finalDuration)}</b>
            </Info>
          </Card>

          <Switch isSelected={precise} onChange={setPrecise} isDisabled={busy}>
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <div className="flex flex-col">
                <span className="text-sm">Corte exacto al fotograma</span>
                <span className="text-xs text-muted">
                  {precise
                    ? 'Recodifica en alta calidad (misma resolución y fps). Tarda más.'
                    : 'Sin pérdida: no recodifica, mantiene la calidad exacta.'}
                </span>
              </div>
            </Switch.Content>
          </Switch>
          <Switch isSelected={skipCuts} onChange={setSkipCuts}>
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <span className="text-sm">Saltar los cortes al reproducir</span>
            </Switch.Content>
          </Switch>
        </aside>
      </div>

      {/* ---------------- Footer ---------------- */}
      <div className="flex shrink-0 items-center gap-4 border-t border-separator bg-background/85 px-6 py-3.5 backdrop-blur-md">
        {exporting ? (
          <div className="flex flex-1 items-center gap-3">
            <ProgressBar aria-label="Guardando" value={Math.round(exporting.progress * 100)} className="flex-1" size="sm">
              <ProgressBar.Track>
                <ProgressBar.Fill />
              </ProgressBar.Track>
            </ProgressBar>
            <span className="w-40 text-sm text-muted tabular-nums">
              {exporting.stage}… {Math.round(exporting.progress * 100)}%
            </span>
          </div>
        ) : (
          <p className="flex-1 text-sm text-muted">
            {dirty ? `Resultado: ${formatTime(finalDuration)} · ${keep.length} ${keep.length === 1 ? 'parte' : 'partes'}` : 'Sin cambios todavía'}
          </p>
        )}
        <Button
          variant={confirmReplace ? 'danger' : 'danger-soft'}
          onPress={() => (confirmReplace ? save('original') : setConfirmReplace(true))}
          isDisabled={busy || !dirty}
          onBlur={() => setConfirmReplace(false)}
        >
          {confirmReplace ? '¿Seguro? Reemplazar' : 'Guardar como original'}
        </Button>
        <Button onPress={() => save('copy')} isDisabled={busy || !dirty}>
          <Save className="size-4" /> Guardar como copia
        </Button>
      </div>
    </div>
  )
}

function IconBtn({
  label,
  onPress,
  children,
  disabled,
  className,
}: {
  label: string
  onPress: () => void
  children: ReactNode
  disabled?: boolean
  className?: string
}) {
  return (
    <Tooltip delay={400}>
      <Button isIconOnly size="sm" variant="ghost" aria-label={label} onPress={onPress} isDisabled={disabled} className={className}>
        {children}
      </Button>
      <Tooltip.Content>
        <p>{label}</p>
      </Tooltip.Content>
    </Tooltip>
  )
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="ml-1 rounded border border-border bg-surface-secondary px-1 font-sans text-[10px] font-semibold">
      {children}
    </kbd>
  )
}
