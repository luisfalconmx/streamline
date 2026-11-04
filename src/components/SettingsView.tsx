import { Button, Card, Chip, Input, Label, Switch, TextField, toast } from '@heroui/react'
import { RefreshCw } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { openUrl, toolVersions, updateYtdlp } from '../lib/tauri'
import type { Settings, ToolVersions } from '../lib/types'
import { useExtension } from '../extension-state'
import { useStore } from '../store'
import { FolderPicker } from './FolderPicker'
import { SimpleSelect } from './SimpleSelect'

const REPO = 'https://github.com/luisfalconmx/streamline'

export function SettingsView() {
  const { settings, updateSettings, resetSettings } = useStore()
  const ext = useExtension()
  const [versions, setVersions] = useState<ToolVersions>({})
  const [updating, setUpdating] = useState(false)

  const loadVersions = () => toolVersions().then(setVersions)
  useEffect(() => {
    loadVersions()
  }, [])

  const update = async () => {
    setUpdating(true)
    try {
      const out = await updateYtdlp()
      toast.success('yt-dlp actualizado', { description: out.split('\n').at(-1) })
      loadVersions()
    } catch (e) {
      toast.danger('No se pudo actualizar yt-dlp', { description: String(e) })
    } finally {
      setUpdating(false)
    }
  }

  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => updateSettings({ [k]: v } as Partial<Settings>)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-8 py-8">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Ajustes</h1>
          <p className="text-sm text-muted">Los cambios se guardan automáticamente.</p>
        </div>
        <Button variant="ghost" size="sm" onPress={resetSettings}>
          Restablecer
        </Button>
      </div>

      <Group title="General">
        <Row label="Carpeta de descargas" hint="Donde se guardarán tus archivos.">
          <div className="max-w-80">
            <FolderPicker />
          </div>
        </Row>
        <Row label="Descargas simultáneas" hint="Cuántos archivos descargar a la vez.">
          <SimpleSelect
            ariaLabel="Descargas simultáneas"
            className="w-28"
            value={String(settings.maxParallel)}
            options={['1', '2', '3', '4', '6', '8'].map((v) => ({ value: v, label: v }))}
            onChange={(v) => updateSettings({ maxParallel: Number(v) })}
          />
        </Row>
        <Row label="Detectar enlaces copiados" hint="Analiza automáticamente el enlace del portapapeles al volver a la app.">
          <Toggle isSelected={settings.autoAnalyzeClipboard} onChange={set('autoAnalyzeClipboard')} />
        </Row>
      </Group>

      <Group title="Extensión del navegador">
        <Row
          label="Streamline para Chrome y Brave"
          hint={ext.status?.shortcut ? `Carpeta: ${ext.status.shortcut}` : `Carpeta: ${ext.dir || '…'}`}
        >
          <div className="flex items-center gap-2">
            {ext.status?.browsers
              .filter((b) => b.available)
              .map((b) => (
                <Chip key={b.id} size="sm" variant="soft" color={b.extensionInstalled ? 'success' : 'default'}>
                  {b.name} {b.extensionInstalled ? '✓' : '—'}
                </Chip>
              ))}
            <Button size="sm" variant="secondary" onPress={ext.openWizard}>
              {ext.status?.anyInstalled ? 'Reinstalar' : 'Instalar'}
            </Button>
          </div>
        </Row>
      </Group>

      <Group title="Velocidad">
        <Row
          label="Fragmentos en paralelo"
          hint="Más fragmentos = más velocidad en streams DASH/HLS. Sin límite de ancho de banda."
        >
          <SimpleSelect
            ariaLabel="Fragmentos en paralelo"
            className="w-28"
            value={String(settings.concurrentFragments)}
            options={['1', '4', '8', '16', '24', '32'].map((v) => ({ value: v, label: v }))}
            onChange={(v) => updateSettings({ concurrentFragments: Number(v) })}
          />
        </Row>
      </Group>

      <Group title="Video y audio">
        <Row label="Contenedor de video" hint="MP4 es el más compatible. MKV admite todo.">
          <SimpleSelect
            ariaLabel="Contenedor de video"
            className="w-28"
            value={settings.mergeFormat}
            options={[
              { value: 'mp4', label: 'MP4' },
              { value: 'mkv', label: 'MKV' },
              { value: 'webm', label: 'WebM' },
            ]}
            onChange={set('mergeFormat')}
          />
        </Row>
        <Row
          label="Priorizar H.264"
          hint="Máxima compatibilidad (QuickTime, TVs, editores). Puede limitar la resolución a 1080p."
        >
          <Toggle isSelected={settings.preferH264} onChange={set('preferH264')} />
        </Row>
        <Row label="Formato de audio" hint="Formato al elegir «Solo audio».">
          <SimpleSelect
            ariaLabel="Formato de audio"
            className="w-36"
            value={settings.audioFormat}
            options={[
              { value: 'mp3', label: 'MP3' },
              { value: 'm4a', label: 'M4A (AAC)' },
              { value: 'opus', label: 'Opus' },
              { value: 'flac', label: 'FLAC' },
              { value: 'wav', label: 'WAV' },
            ]}
            onChange={set('audioFormat')}
          />
        </Row>
        <Row label="Insertar miniatura" hint="Usa la portada del video como carátula del archivo.">
          <Toggle isSelected={settings.embedThumbnail} onChange={set('embedThumbnail')} />
        </Row>
        <Row label="Insertar metadatos y capítulos">
          <Toggle isSelected={settings.embedMetadata} onChange={set('embedMetadata')} />
        </Row>
        <Row label="Insertar subtítulos" hint="Idiomas en formato yt-dlp, por ejemplo: es.*,en.*">
          <div className="flex items-center gap-3">
            <TextField aria-label="Idiomas de subtítulos" value={settings.subLangs} onChange={set('subLangs')} isDisabled={!settings.embedSubs}>
              <Input className="w-32" />
            </TextField>
            <Toggle isSelected={settings.embedSubs} onChange={set('embedSubs')} />
          </div>
        </Row>
        <Row label="Quitar patrocinios (YouTube)" hint="Elimina segmentos patrocinados usando SponsorBlock.">
          <Toggle isSelected={settings.sponsorblock} onChange={set('sponsorblock')} />
        </Row>
      </Group>

      <Group title="Avanzado">
        <Row
          label="Cookies del navegador"
          hint="Para videos privados, con restricción de edad o de miembros. Usa tu sesión del navegador."
        >
          <SimpleSelect
            ariaLabel="Cookies del navegador"
            className="w-36"
            value={settings.cookiesBrowser || 'none'}
            options={[
              { value: 'none', label: 'Ninguno' },
              { value: 'chrome', label: 'Chrome' },
              { value: 'firefox', label: 'Firefox' },
              { value: 'safari', label: 'Safari' },
              { value: 'edge', label: 'Edge' },
              { value: 'brave', label: 'Brave' },
              { value: 'opera', label: 'Opera' },
              { value: 'vivaldi', label: 'Vivaldi' },
            ]}
            onChange={(v) => updateSettings({ cookiesBrowser: v === 'none' ? '' : v })}
          />
        </Row>
        <Row label="Nombre de archivo" hint="Plantilla de salida de yt-dlp.">
          <TextField aria-label="Plantilla de nombre" value={settings.filenameTemplate} onChange={set('filenameTemplate')}>
            <Input className="w-64 font-mono text-xs" />
          </TextField>
        </Row>
      </Group>

      <Group title="Acerca de">
        <Row label="Motor de descarga">
          <div className="flex flex-wrap items-center gap-2">
            <Chip size="sm" variant="soft" color={versions.ytdlp ? 'success' : 'danger'}>
              yt-dlp {versions.ytdlp ?? 'no encontrado'}
            </Chip>
            <Chip size="sm" variant="soft" color={versions.ffmpeg ? 'success' : 'warning'}>
              ffmpeg {versions.ffmpeg ?? 'no encontrado'}
            </Chip>
            <Chip size="sm" variant="soft" color={versions.deno ? 'success' : 'warning'}>
              deno {versions.deno ?? 'no encontrado'}
            </Chip>
          </div>
        </Row>
        <Row label="Actualizar yt-dlp" hint="Los sitios cambian a menudo; actualiza si alguna descarga falla.">
          <Button size="sm" variant="secondary" onPress={update} isPending={updating}>
            <RefreshCw className="size-4" /> Buscar actualización
          </Button>
        </Row>
        <Row label="Streamline 0.1.4" hint="Código abierto. Impulsado por yt-dlp.">
          <Button size="sm" variant="ghost" onPress={() => openUrl(REPO)}>
            GitHub
          </Button>
        </Row>
      </Group>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-semibold tracking-wider text-muted uppercase">{title}</h2>
      <Card className="gap-0 divide-y divide-separator p-0">{children}</Card>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-4">
      <div className="min-w-0">
        <Label className="text-sm font-medium">{label}</Label>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ isSelected, onChange }: { isSelected: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch aria-label="Activar" isSelected={isSelected} onChange={onChange}>
      <Switch.Control>
        <Switch.Thumb />
      </Switch.Control>
    </Switch>
  )
}
