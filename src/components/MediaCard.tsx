import { Card, Chip, Spinner } from '@heroui/react'
import { Calendar, Clock, ExternalLink, Eye, Monitor, ThumbsUp, User } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatCount, formatDate, formatDuration } from '../lib/format'
import { bestThumbnail } from '../lib/qualities'
import { openUrl } from '../lib/tauri'
import type { YtInfo } from '../lib/types'

function Meta({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted">
      {icon}
      {children}
    </span>
  )
}

export function MediaCard({ info, loadingPreview }: { info: YtInfo; loadingPreview?: boolean }) {
  const thumb = bestThumbnail(info)
  const author = info.uploader ?? info.channel

  return (
    <Card className="flex-row gap-5 p-4">
      <div className="relative aspect-video w-72 shrink-0 overflow-hidden rounded-xl bg-default">
        {thumb ? (
          <img src={thumb} alt="" className="size-full object-cover" referrerPolicy="no-referrer" />
        ) : loadingPreview ? (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-sm text-muted">
            <Spinner size="sm" />
            Generando miniatura…
          </div>
        ) : (
          <div className="flex size-full items-center justify-center text-muted">Sin miniatura</div>
        )}
        {info.duration ? (
          <span className="absolute right-2 bottom-2 rounded-md bg-black/75 px-1.5 py-0.5 text-xs font-medium text-white">
            {formatDuration(info.duration)}
          </span>
        ) : null}
        {info.is_live && (
          <span className="absolute top-2 left-2 rounded-md bg-red-600 px-1.5 py-0.5 text-xs font-semibold text-white">
            EN VIVO
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3 py-1">
        <div className="flex items-center gap-2">
          {info.extractor_key && (
            <Chip size="sm" variant="soft" color="accent">
              {info.extractor_key.replace(/Tab$/, '')}
            </Chip>
          )}
        </div>
        <h2 className="selectable line-clamp-2 text-xl leading-snug font-semibold" title={info.title}>
          {info.title}
        </h2>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {author && <Meta icon={<User className="size-4" />}>{author}</Meta>}
          {info.duration ? <Meta icon={<Clock className="size-4" />}>{formatDuration(info.duration)}</Meta> : null}
          {info.view_count != null && <Meta icon={<Eye className="size-4" />}>{formatCount(info.view_count)} vistas</Meta>}
          {info.like_count != null && <Meta icon={<ThumbsUp className="size-4" />}>{formatCount(info.like_count)}</Meta>}
          {info.upload_date && <Meta icon={<Calendar className="size-4" />}>{formatDate(info.upload_date)}</Meta>}
          {info.direct && info.formats?.at(-1)?.height ? (
            <Meta icon={<Monitor className="size-4" />}>
              {info.formats.at(-1)!.width}×{info.formats.at(-1)!.height}
              {info.formats.at(-1)!.fps ? ` · ${Math.round(info.formats.at(-1)!.fps!)} fps` : ''}
            </Meta>
          ) : null}
        </div>
        {info.description && (
          <p className="selectable line-clamp-2 text-sm text-muted">{info.description}</p>
        )}
        <button
          type="button"
          onClick={() => openUrl(info.webpage_url)}
          className="mt-auto inline-flex w-fit items-center gap-1 text-sm text-link hover:underline"
        >
          Abrir en el navegador <ExternalLink className="size-3.5" />
        </button>
      </div>
    </Card>
  )
}
