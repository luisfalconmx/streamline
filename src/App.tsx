import { Button, Tabs, Toast, toast, Tooltip, useTheme } from '@heroui/react'
import { Download, ListOrdered, Moon, Settings2, Sun } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { DownloadsView } from './components/DownloadsView'
import { ExtensionBanner } from './components/ExtensionBanner'
import { ExtensionWizard } from './components/ExtensionWizard'
import { DownloadView } from './components/DownloadView'
import { Logo } from './components/Logo'
import { SettingsView } from './components/SettingsView'
import { useExtension } from './extension-state'
import { focusWindow, onDeepLink, type IncomingLink } from './lib/tauri'
import { useStore } from './store'

type View = 'download' | 'downloads' | 'settings'

const BROWSER_NAMES: Record<string, string> = { brave: 'Brave', chrome: 'Google Chrome', edge: 'Microsoft Edge', opera: 'Opera' }

export default function App() {
  const [view, setView] = useState<View>('download')
  const { activeCount } = useStore()
  const { resolvedTheme, setTheme } = useTheme('system')
  const mainRef = useRef<HTMLElement>(null)
  const { markConfirmed } = useExtension()
  const [incoming, setIncoming] = useState<(IncomingLink & { nonce: number }) | null>(null)

  // `streamline://download?url=…` from the browser extension.
  useEffect(() => {
    let nonce = 0
    const off = onDeepLink((link) => {
      if (link.browser) markConfirmed(link.browser)
      if (link.kind === 'extension-installed') {
        toast.success('Extensión conectada', {
          description: `Streamline ya recibe videos desde ${BROWSER_NAMES[link.browser] ?? link.browser}.`,
        })
        focusWindow()
        return
      }
      setView('download')
      setIncoming({ url: link.url, referer: link.referer, title: link.title, nonce: ++nonce })
      focusWindow()
    })
    return () => {
      off.then((f) => f())
    }
  }, [markConfirmed])
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [view])

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-6 border-b border-separator px-6 py-3">
        <div className="flex items-center gap-2.5">
          <Logo className="size-8" />
          <span className="text-lg font-bold tracking-tight">Streamline</span>
        </div>

        <Tabs selectedKey={view} onSelectionChange={(k) => setView(k as View)} className="mx-auto">
          <Tabs.ListContainer>
            <Tabs.List aria-label="Navegación">
              <Tabs.Tab id="download">
                <Download className="mr-1.5 size-4" /> Descargar
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="downloads">
                <ListOrdered className="mr-1.5 size-4" /> Descargas
                {activeCount > 0 && (
                  <span className="ml-1.5 rounded-full bg-accent px-1.5 text-[11px] leading-[18px] font-semibold text-accent-foreground tabular-nums">
                    {activeCount}
                  </span>
                )}
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="settings">
                <Settings2 className="mr-1.5 size-4" /> Ajustes
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>

        <Tooltip delay={300}>
          <Button
            isIconOnly
            variant="ghost"
            aria-label="Cambiar tema"
            onPress={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          >
            {resolvedTheme === 'dark' ? <Sun className="size-5" /> : <Moon className="size-5" />}
          </Button>
          <Tooltip.Content>
            <p>{resolvedTheme === 'dark' ? 'Modo claro' : 'Modo oscuro'}</p>
          </Tooltip.Content>
        </Tooltip>
      </header>

      <ExtensionBanner />

      <main ref={mainRef} className="scroll-area relative flex-1 overflow-y-auto">
        {/* Keep the download view mounted so the analysed video survives tab switches. */}
        <div className={view === 'download' ? 'contents' : 'hidden'}>
          <DownloadView onShowDownloads={() => setView('downloads')} incoming={incoming} />
        </div>
        {view === 'downloads' && <DownloadsView onNew={() => setView('download')} />}
        {view === 'settings' && <SettingsView />}
      </main>

      <ExtensionWizard />
      <Toast.Provider placement="bottom end" />
    </div>
  )
}
