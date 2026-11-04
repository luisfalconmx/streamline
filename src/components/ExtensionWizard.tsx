import { Button, Modal, Spinner } from '@heroui/react'
import { Check, CircleCheck, Copy, ExternalLink, Folder, FolderOpen, Puzzle } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useExtension } from '../extension-state'
import {
  installExtension,
  openExtensionsPage,
  revealFile,
  setFloatingGuide,
  writeClipboard,
  type InstalledExtension,
} from '../lib/tauri'
import type { BrowserStatus } from '../lib/types'
import { BraveLogo, ChromeLogo } from './BrowserLogos'

type Step =
  | { kind: 'choose' }
  | { kind: 'guide'; browser: BrowserStatus; installed: InstalledExtension }
  | { kind: 'done'; browser: BrowserStatus }

const LOGO: Record<BrowserStatus['id'], (p: { className?: string }) => ReactNode> = {
  chrome: ChromeLogo,
  brave: BraveLogo,
}

function BrowserLogo({ id, className }: { id: BrowserStatus['id']; className?: string }) {
  const L = LOGO[id]
  return <L className={className} />
}

export function ExtensionWizard() {
  const { status, refresh, wizardOpen, closeWizard } = useExtension()
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [opened, setOpened] = useState(false)
  const os = status?.os ?? 'macos'
  const fileManager = os === 'macos' ? 'Finder' : os === 'windows' ? 'el Explorador' : 'la carpeta'

  useEffect(() => {
    if (wizardOpen) {
      setStep({ kind: 'choose' })
      setError(null)
    }
  }, [wizardOpen])

  // While the user follows the guide, check often and jump to "done" as soon as
  // the extension confirms itself (deep link) or shows up in the browser profile.
  useEffect(() => {
    if (step.kind !== 'guide') return
    const id = setInterval(refresh, 1500)
    return () => clearInterval(id)
  }, [step.kind, refresh])

  useEffect(() => {
    if (step.kind !== 'guide' || !status) return
    const b = status.browsers.find((x) => x.id === step.browser.id && x.extensionInstalled)
      ?? status.browsers.find((x) => x.extensionInstalled)
    if (b) setStep({ kind: 'done', browser: b })
  }, [status, step])

  // Floating panel only while the browser steps are in progress.
  useEffect(() => {
    const floating = wizardOpen && step.kind === 'guide' && opened
    setFloatingGuide(floating)
  }, [wizardOpen, step.kind, opened])

  useEffect(() => () => void setFloatingGuide(false), [])

  const install = async (b: BrowserStatus) => {
    setBusy(b.id)
    setError(null)
    try {
      const installed = await installExtension()
      await writeClipboard(installed.pick)
      setCopied(true)
      setOpened(false)
      setStep({ kind: 'guide', browser: b, installed })
      refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const openBrowser = async (b: BrowserStatus) => {
    setOpened(true)
    await openExtensionsPage(b.id).catch((e) => setError(String(e)))
  }

  const copyPath = async (path: string) => {
    await writeClipboard(path)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const folderName = status?.shortcut?.split('/').pop() ?? 'Streamline Extension'

  // The third step depends on the OS file dialog.
  const pickStep =
    os === 'macos' ? (
      <>
        En la ventana que se abre pulsa <Kbd>⌘ ⇧ H</Kbd> (tu carpeta de inicio), elige <b>{folderName}</b> y pulsa{' '}
        <b>Seleccionar</b>.
      </>
    ) : os === 'windows' ? (
      <>
        Haz clic en la barra de dirección de la ventana, pega la ruta con <Kbd>Ctrl V</Kbd> (ya está copiada), pulsa{' '}
        <Kbd>Enter</Kbd> y luego <b>Seleccionar carpeta</b>.
      </>
    ) : (
      <>
        Pulsa <Kbd>Ctrl L</Kbd>, pega la ruta con <Kbd>Ctrl V</Kbd> (ya está copiada) y pulsa <b>Seleccionar</b>.
      </>
    )

  const pickHint =
    os === 'macos' ? (
      <>
        ¿No la ves? Pulsa <Kbd>⌘ ⇧ G</Kbd>, pega con <Kbd>⌘ V</Kbd> y pulsa <b>Abrir</b>. También puedes arrastrar la
        carpeta desde Finder a esa ventana.
      </>
    ) : null

  return (
    <Modal.Backdrop isOpen={wizardOpen} onOpenChange={(open) => !open && closeWizard()} isDismissable={false}>
      <Modal.Container size="md">
        <Modal.Dialog className="sm:max-w-[560px]">
          {step.kind === 'choose' && (
            <>
              <Modal.Header>
                <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
                  <Puzzle className="size-5" />
                </Modal.Icon>
                <Modal.Heading>Descarga desde tu navegador</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-5">
                <p className="text-sm text-muted">
                  Instala la extensión de Streamline: detecta los videos de cualquier página y te los envía aquí con un
                  clic, con el título de la página y listos para descargar.
                </p>

                <div className="grid grid-cols-2 gap-3">
                  {(status?.browsers ?? []).map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      disabled={!b.available || !!busy}
                      onClick={() => install(b)}
                      className="group flex flex-col items-center gap-2.5 rounded-2xl border border-border bg-surface p-5 text-center transition hover:border-accent hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-surface"
                    >
                      <span className="flex size-14 items-center justify-center">
                        {busy === b.id ? <Spinner /> : <BrowserLogo id={b.id} className="size-12 drop-shadow-sm" />}
                      </span>
                      <span className="text-sm font-semibold">Instalar en {b.name}</span>
                      <span className="text-xs text-muted">
                        {b.extensionInstalled ? 'Ya instalada ✓' : b.available ? 'Te guiamos paso a paso' : 'No está instalado'}
                      </span>
                    </button>
                  ))}
                </div>

                <p className="text-xs text-muted">
                  La extensión se guarda dentro de los datos de Streamline, así no se borra por accidente
                  {status?.shortcut ? (
                    <>
                      {' '}
                      (con un acceso directo <b>{folderName}</b> en tu carpeta de inicio)
                    </>
                  ) : null}
                  .
                </p>

                {error && <p className="text-sm text-danger">{error}</p>}
              </Modal.Body>
              <Modal.Footer>
                <Button variant="ghost" onPress={closeWizard}>
                  Ahora no
                </Button>
              </Modal.Footer>
            </>
          )}

          {step.kind === 'guide' && (
            <>
              <Modal.Header>
                <Modal.Icon className="bg-transparent">
                  <BrowserLogo id={step.browser.id} className="size-8" />
                </Modal.Icon>
                <Modal.Heading>Termina en {step.browser.name}</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-4">
                <p className="text-sm text-muted">
                  {step.browser.name} pide confirmar las extensiones que no vienen de su tienda. Son 4 pasos rápidos;
                  esta ventana se queda visible a un lado mientras los haces.
                </p>
                <ol className="flex flex-col gap-3">
                  <GuideStep n={1}>
                    <div className="flex flex-col items-start gap-2">
                      <span>Abre la página de extensiones de {step.browser.name}.</span>
                      <Button size="sm" variant={opened ? 'secondary' : 'primary'} onPress={() => openBrowser(step.browser)}>
                        <ExternalLink className="size-4" />
                        {opened ? 'Abrir de nuevo' : `Abrir extensiones de ${step.browser.name}`}
                      </Button>
                    </div>
                  </GuideStep>
                  <GuideStep n={2}>
                    Activa <b>Modo de desarrollador</b> (interruptor arriba a la derecha).
                  </GuideStep>
                  <GuideStep n={3}>
                    Pulsa <b>Cargar descomprimida</b>.
                  </GuideStep>
                  <GuideStep n={4}>{pickStep}</GuideStep>
                </ol>
                {pickHint && <p className="-mt-1 pl-9 text-xs text-muted">{pickHint}</p>}

                <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2">
                  <Folder className="size-4 shrink-0 text-muted" />
                  <span className="selectable min-w-0 flex-1 truncate font-mono text-xs" title={step.installed.pick}>
                    {step.installed.pick}
                  </span>
                  <Button size="sm" variant="ghost" onPress={() => revealFile(step.installed.pick)}>
                    <FolderOpen className="size-4" /> {os === 'macos' ? 'Finder' : 'Abrir'}
                  </Button>
                  <Button size="sm" variant={copied ? 'secondary' : 'tertiary'} onPress={() => copyPath(step.installed.pick)}>
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                    {copied ? 'Copiada' : 'Copiar'}
                  </Button>
                </div>

                <div className="flex items-start gap-2 rounded-xl bg-accent-soft px-3 py-2.5 text-sm">
                  <Spinner size="sm" className="mt-0.5 shrink-0" />
                  <span>
                    Al cargarla, {step.browser.name} preguntará <b>«¿Abrir Streamline?»</b>: marca <b>Permitir siempre</b>{' '}
                    y pulsa <b>Abrir</b>. Así se conecta y este paso termina solo.
                  </span>
                </div>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="ghost" onPress={() => setStep({ kind: 'choose' })}>
                  Volver
                </Button>
                <Button variant="ghost" onPress={closeWizard}>
                  Más tarde
                </Button>
              </Modal.Footer>
            </>
          )}

          {step.kind === 'done' && (
            <>
              <Modal.Header>
                <Modal.Icon className="bg-success-soft text-success">
                  <CircleCheck className="size-5" />
                </Modal.Icon>
                <Modal.Heading>¡Extensión instalada en {step.browser.name}!</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p className="text-sm text-muted">
                  Fija el icono de Streamline en la barra del navegador. En cualquier página con video, ábrelo y pulsa{' '}
                  <b>Descargar en la app</b>: Streamline se abrirá con el video listo para descargar.
                </p>
                <p className="mt-2 text-xs text-muted">
                  No borres la carpeta de la extensión desde {fileManager}: el navegador la necesita para funcionar.
                </p>
              </Modal.Body>
              <Modal.Footer>
                <Button onPress={closeWizard}>Empezar</Button>
              </Modal.Footer>
            </>
          )}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}

function GuideStep({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-sm">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-foreground">
        {n}
      </span>
      <span className="pt-0.5">{children}</span>
    </li>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md border border-border bg-surface-secondary px-1.5 py-0.5 font-sans text-xs font-semibold">
      {children}
    </kbd>
  )
}
