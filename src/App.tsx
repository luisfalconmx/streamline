import { Tabs, Toast } from '@heroui/react'
import { Download, ListOrdered, Settings2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { DownloadsView } from './components/DownloadsView'
import { DownloadView } from './components/DownloadView'
import { Logo } from './components/Logo'
import { SettingsView } from './components/SettingsView'
import { UpdateButton } from './components/UpdateButton'
import { useStore } from './store'

type View = 'download' | 'downloads' | 'settings'

export default function App() {
  const [view, setView] = useState<View>('download')
  const { activeCount } = useStore()
  const mainRef = useRef<HTMLElement>(null)

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [view])

  return (
    <div className="app-bg flex h-full flex-col text-foreground">
      <header className="grid shrink-0 grid-cols-[200px_1fr_200px] items-center gap-4 border-b border-separator px-6 py-3">
        <div className="flex items-center gap-2.5">
          <Logo className="size-8" />
          <span className="text-lg font-bold tracking-tight">Streamline</span>
          <span className="text-xs font-medium text-muted tabular-nums">v{__APP_VERSION__}</span>
        </div>

        <Tabs selectedKey={view} onSelectionChange={(k) => setView(k as View)} className="justify-self-center">
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

        <div className="flex justify-end">
          <UpdateButton />
        </div>
      </header>

      <main ref={mainRef} className="scroll-area relative flex-1 overflow-y-auto">
        {/* Keep the download view mounted so the analysed video survives tab switches. */}
        <div className={view === 'download' ? 'contents' : 'hidden'}>
          <DownloadView onShowDownloads={() => setView('downloads')} />
        </div>
        {view === 'downloads' && <DownloadsView onNew={() => setView('download')} />}
        {view === 'settings' && <SettingsView />}
      </main>

      <Toast.Provider placement="bottom end" />
    </div>
  )
}
