import { Button } from '@heroui/react'
import { Puzzle } from 'lucide-react'
import { useExtension } from '../extension-state'
import { useStore } from '../store'

/**
 * Persistent reminder shown after the wizard was closed. It has no close
 * button: it disappears by itself once the extension is detected in Chrome or Brave.
 */
export function ExtensionBanner() {
  const { status, wizardOpen, openWizard } = useExtension()
  const { settings } = useStore()
  if (!status || status.anyInstalled || wizardOpen || !settings.extensionWizardDone) return null
  if (!status.browsers.some((b) => b.available)) return null

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-separator bg-accent-soft px-6 py-2">
      <Puzzle className="size-4 shrink-0 text-accent" />
      <p className="min-w-0 flex-1 truncate text-sm">
        <b>Instala la extensión del navegador</b>
        <span className="text-muted"> para enviar videos a Streamline con un clic desde Chrome o Brave.</span>
      </p>
      <Button size="sm" onPress={openWizard}>
        Instalar extensión
      </Button>
    </div>
  )
}
