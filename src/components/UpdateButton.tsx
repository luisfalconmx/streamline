import { Button, toast, Tooltip } from '@heroui/react'
import type { Update } from '@tauri-apps/plugin-updater'
import { ArrowDownToLine } from 'lucide-react'
import { useEffect, useState } from 'react'
import { checkForUpdate, installUpdate } from '../lib/updater'

/** Only shows up when GitHub has a newer release; one click updates and restarts. */
export function UpdateButton() {
  const [update, setUpdate] = useState<Update | null>(null)
  const [progress, setProgress] = useState<number | null | undefined>(undefined)
  const installing = progress !== undefined

  useEffect(() => {
    checkForUpdate().then(setUpdate)
  }, [])

  if (!update) return null

  const run = async () => {
    setProgress(null)
    try {
      await installUpdate(update, setProgress)
    } catch (e) {
      setProgress(undefined)
      toast.danger('No se pudo actualizar', { description: String(e) })
    }
  }

  const label = !installing
    ? `Actualizar a v${update.version}`
    : progress === 1
      ? 'Reiniciando…'
      : progress == null
        ? 'Descargando…'
        : `Descargando ${Math.round(progress * 100)}%`

  return (
    <Tooltip delay={300}>
      <Button size="sm" onPress={run} isPending={installing} className="tabular-nums">
        {!installing && <ArrowDownToLine className="size-4" />}
        {label}
      </Button>
      <Tooltip.Content>
        <p>
          {installing
            ? 'Streamline se reiniciará al terminar.'
            : `Hay una nueva versión (v${update.version}). Se descarga e instala sola.`}
        </p>
      </Tooltip.Content>
    </Tooltip>
  )
}
