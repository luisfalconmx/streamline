import { Button, Card, Checkbox, Chip, toast } from '@heroui/react'
import { Download, ListVideo } from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatDuration, uid } from '../lib/format'
import { bestThumbnail, PLAYLIST_PRESETS, presetSelector } from '../lib/qualities'
import { buildRequest } from '../lib/request'
import type { DownloadItem, YtInfo } from '../lib/types'
import { useStore } from '../store'
import { FolderPicker } from './FolderPicker'
import { SimpleSelect } from './SimpleSelect'

export function PlaylistPanel({ info, onQueued }: { info: YtInfo; onQueued: () => void }) {
  const { settings, enqueue } = useStore()
  const entries = useMemo(() => (info.entries ?? []).filter((e) => e && (e.url || e.id)), [info])
  const [checked, setChecked] = useState<Set<string>>(() => new Set(entries.map((e) => e.id)))
  const [presetKey, setPresetKey] = useState('best')
  const preset = PLAYLIST_PRESETS.find((p) => p.key === presetKey)!

  const allChecked = checked.size === entries.length
  const totalDuration = entries.reduce((acc, e) => acc + (e.duration ?? 0), 0)

  const toggle = (id: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const downloadSelected = () => {
    const format = presetSelector(preset, settings)
    const items: DownloadItem[] = entries
      .filter((e) => checked.has(e.id))
      .reverse()
      .map((e) => {
        const url = e.url?.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`
        return {
          id: uid(),
          url,
          title: e.title ?? e.id,
          thumbnail: bestThumbnail(e),
          uploader: e.uploader ?? e.channel ?? info.uploader,
          duration: e.duration,
          qualityLabel: preset.mode === 'audio' ? settings.audioFormat.toUpperCase() : preset.label,
          mode: preset.mode,
          request: buildRequest(url, format, preset.mode, settings, { format: settings.audioFormat, quality: '0' }),
          status: 'queued',
          progress: 0,
          createdAt: Date.now(),
        }
      })
    if (!items.length) return
    enqueue(items)
    toast.success(`${items.length} videos añadidos a descargas`, {
      description: info.title,
      actionProps: { children: 'Ver', onPress: onQueued, variant: 'tertiary' },
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex-row items-center gap-4 p-5">
        <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <ListVideo className="size-7" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <Chip size="sm" variant="soft" color="accent">
              Playlist
            </Chip>
            <span className="text-sm text-muted">
              {entries.length} videos{totalDuration ? ` · ${formatDuration(totalDuration)}` : ''}
            </span>
          </div>
          <h2 className="selectable truncate text-xl font-semibold">{info.title}</h2>
          {(info.uploader || info.channel) && <p className="text-sm text-muted">{info.uploader ?? info.channel}</p>}
        </div>
      </Card>

      <Card className="gap-0 p-0">
        <div className="flex items-center justify-between border-b border-separator px-5 py-3">
          <Checkbox
            isSelected={allChecked}
            isIndeterminate={!allChecked && checked.size > 0}
            onChange={(on) => setChecked(on ? new Set(entries.map((e) => e.id)) : new Set())}
          >
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              <span className="text-sm">Seleccionar todo ({checked.size}/{entries.length})</span>
            </Checkbox.Content>
          </Checkbox>
          <SimpleSelect
            ariaLabel="Calidad para la playlist"
            className="w-48"
            value={presetKey}
            options={PLAYLIST_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
            onChange={setPresetKey}
          />
        </div>
        <ul className="scroll-area max-h-[420px] overflow-y-auto">
          {entries.map((e, idx) => (
            <li key={`${e.id}-${idx}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-surface-hover">
              <Checkbox aria-label={e.title ?? e.id} isSelected={checked.has(e.id)} onChange={(on) => toggle(e.id, on)}>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
              </Checkbox>
              <span className="w-7 text-right text-xs text-muted tabular-nums">{idx + 1}</span>
              <div className="aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-default">
                {bestThumbnail(e) && (
                  <img src={bestThumbnail(e)} alt="" className="size-full object-cover" loading="lazy" referrerPolicy="no-referrer" />
                )}
              </div>
              <span className="min-w-0 flex-1 truncate text-sm">{e.title ?? e.id}</span>
              <span className="text-xs text-muted tabular-nums">{formatDuration(e.duration)}</span>
            </li>
          ))}
        </ul>
      </Card>

      <div className="surface sticky bottom-4 flex items-center gap-4 rounded-3xl px-6 py-4 shadow-overlay backdrop-blur-md">
        <div className="min-w-0 flex-1">
          <FolderPicker compact />
        </div>
        <Button size="lg" className="min-w-56" isDisabled={!checked.size} onPress={downloadSelected}>
          <Download className="size-5" />
          Descargar {checked.size} {checked.size === 1 ? 'video' : 'videos'}
        </Button>
      </div>
    </div>
  )
}
