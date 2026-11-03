import { Button, Card, Chip, ProgressBar, Tooltip } from '@heroui/react'
import { Ban, FolderOpen, Inbox, Play, RotateCcw, Trash2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatBytes, formatEta, formatSpeed } from '../lib/format'
import { openFile, revealFile } from '../lib/tauri'
import type { DownloadItem, DownloadStatus } from '../lib/types'
import { useStore } from '../store'
import { FolderPicker } from './FolderPicker'

const STATUS: Record<DownloadStatus, { label: string; color: 'default' | 'accent' | 'success' | 'danger' | 'warning' }> = {
  queued: { label: 'En cola', color: 'default' },
  starting: { label: 'Iniciando', color: 'accent' },
  downloading: { label: 'Descargando', color: 'accent' },
  processing: { label: 'Procesando', color: 'warning' },
  done: { label: 'Completado', color: 'success' },
  error: { label: 'Error', color: 'danger' },
  cancelled: { label: 'Cancelado', color: 'default' },
}

export function DownloadsView({ onNew }: { onNew: () => void }) {
  const { downloads, clearFinished, settings } = useStore()
  // Running items first, then the queue in the order it will be processed.
  const running = downloads.filter((d) => ['starting', 'downloading', 'processing'].includes(d.status))
  const queued = downloads.filter((d) => d.status === 'queued').reverse()
  const active = [...running, ...queued]
  const finished = downloads.filter((d) => ['done', 'error', 'cancelled'].includes(d.status))
  const totalSpeed = active.reduce((acc, d) => acc + (d.status === 'downloading' ? (d.speed ?? 0) : 0), 0)

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 py-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Descargas</h1>
          <p className="text-sm text-muted">
            {active.length ? `${active.length} activas · ${formatSpeed(totalSpeed)}` : 'Nada descargándose ahora mismo'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="tertiary" size="sm" onPress={() => revealFile(settings.outputDir)}>
            <FolderOpen className="size-4" /> Abrir carpeta
          </Button>
          {finished.length > 0 && (
            <Button variant="ghost" size="sm" onPress={clearFinished}>
              <Trash2 className="size-4" /> Limpiar historial
            </Button>
          )}
        </div>
      </div>

      {!downloads.length && (
        <Card className="items-center gap-3 py-16 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-default text-muted">
            <Inbox className="size-7" />
          </div>
          <h3 className="font-semibold">Aún no hay descargas</h3>
          <p className="max-w-sm text-sm text-muted">Pega un enlace en la pestaña Descargar para empezar.</p>
          <Button className="mt-2" onPress={onNew}>
            Nueva descarga
          </Button>
        </Card>
      )}

      {active.length > 0 && (
        <Section title="En progreso">
          {active.map((d) => (
            <DownloadRow key={d.id} item={d} />
          ))}
        </Section>
      )}
      {finished.length > 0 && (
        <Section title="Historial">
          {finished.map((d) => (
            <DownloadRow key={d.id} item={d} />
          ))}
        </Section>
      )}

      <div className="mt-auto border-t border-separator pt-4">
        <FolderPicker />
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-xs font-semibold tracking-wider text-muted uppercase">{title}</h2>
      {children}
    </section>
  )
}

function IconAction({ label, onPress, children, danger }: { label: string; onPress: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <Tooltip delay={300}>
      <Button isIconOnly size="sm" variant={danger ? 'danger-soft' : 'ghost'} aria-label={label} onPress={onPress}>
        {children}
      </Button>
      <Tooltip.Content>
        <p>{label}</p>
      </Tooltip.Content>
    </Tooltip>
  )
}

function DownloadRow({ item }: { item: DownloadItem }) {
  const { cancel, retry, remove } = useStore()
  const status = STATUS[item.status]
  const running = ['starting', 'downloading', 'processing'].includes(item.status)
  const indeterminate = item.status === 'starting' || item.status === 'processing'
  const pct = Math.round(item.progress * 100)

  return (
    <Card className="flex-row items-center gap-4 p-3">
      <div className="relative aspect-video w-36 shrink-0 overflow-hidden rounded-lg bg-default">
        {item.thumbnail && (
          <img src={item.thumbnail} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />
        )}
        {item.status === 'done' && item.filePath && (
          <button
            type="button"
            aria-label="Reproducir"
            onClick={() => openFile(item.filePath!)}
            className="absolute inset-0 flex items-center justify-center bg-black/0 text-white opacity-0 transition hover:bg-black/40 hover:opacity-100"
          >
            <Play className="size-8 fill-white" />
          </button>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium" title={item.title}>
            {item.title}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <Chip size="sm" variant="soft" color={status.color}>
            {item.status === 'downloading' || item.status === 'processing' ? (item.stage ?? status.label) : status.label}
          </Chip>
          <span>{item.mode === 'audio' ? 'Audio' : 'Video'} · {item.qualityLabel}</span>
          {item.estimatedSize && item.status === 'queued' ? <span>· ≈ {formatBytes(item.estimatedSize)}</span> : null}
          {item.status === 'done' && item.completedBytes ? <span>· {formatBytes(item.completedBytes)}</span> : null}
        </div>

        {running && (
          <div className="flex flex-col gap-1">
            <ProgressBar
              aria-label="Progreso"
              size="sm"
              color={item.status === 'processing' ? 'success' : 'accent'}
              value={indeterminate ? undefined : pct}
              isIndeterminate={indeterminate}
            >
              <ProgressBar.Track>
                <ProgressBar.Fill />
              </ProgressBar.Track>
            </ProgressBar>
            {item.status === 'downloading' && (
              <div className="flex gap-4 text-xs text-muted tabular-nums">
                <span className="font-medium text-foreground">{pct}%</span>
                <span>
                  {formatBytes((item.completedBytes ?? 0) + (item.downloaded ?? 0))}
                  {item.estimatedSize ? ` / ≈ ${formatBytes(item.estimatedSize)}` : item.total ? ` / ${formatBytes(item.total)}` : ''}
                </span>
                <span>{formatSpeed(item.speed)}</span>
                <span>Restante: {formatEta(item.eta)}</span>
              </div>
            )}
          </div>
        )}

        {item.status === 'error' && item.error && (
          <p className="selectable line-clamp-2 text-xs text-danger" title={item.error}>
            {item.error}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {(running || item.status === 'queued') && (
          <IconAction label="Cancelar" onPress={() => cancel(item.id)} danger>
            {item.status === 'queued' ? <X className="size-4" /> : <Ban className="size-4" />}
          </IconAction>
        )}
        {item.status === 'done' && item.filePath && (
          <>
            <IconAction label="Abrir archivo" onPress={() => openFile(item.filePath!)}>
              <Play className="size-4" />
            </IconAction>
            <IconAction label="Mostrar en carpeta" onPress={() => revealFile(item.filePath!)}>
              <FolderOpen className="size-4" />
            </IconAction>
          </>
        )}
        {(item.status === 'error' || item.status === 'cancelled') && (
          <IconAction label="Reintentar" onPress={() => retry(item.id)}>
            <RotateCcw className="size-4" />
          </IconAction>
        )}
        {!running && item.status !== 'queued' && (
          <IconAction label="Quitar de la lista" onPress={() => remove(item.id)}>
            <Trash2 className="size-4" />
          </IconAction>
        )}
      </div>
    </Card>
  )
}
