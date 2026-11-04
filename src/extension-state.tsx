import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { extensionStatus, installExtension } from './lib/tauri'
import type { ExtensionStatus } from './lib/types'
import { useStore } from './store'

interface ExtensionState {
  status: ExtensionStatus | null
  /** Folder where the extension lives (<app data>/extension). */
  dir: string
  refresh: () => Promise<ExtensionStatus | null>
  /** The extension reported itself from this browser (streamline:// handshake). */
  markConfirmed: (browser: string) => void
  wizardOpen: boolean
  openWizard: () => void
  closeWizard: () => void
}

const Ctx = createContext<ExtensionState | null>(null)

const POLL_MS = 4000

export function ExtensionProvider({ children }: { children: ReactNode }) {
  const { settings, updateSettings } = useStore()
  const [rawStatus, setStatus] = useState<ExtensionStatus | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const confirmed = settings.extensionConfirmed
  const confirmedRef = useRef(confirmed)
  confirmedRef.current = confirmed

  // Reading browser profiles is blocked by macOS privacy protection, so the
  // extension's own confirmation (deep link) counts as "installed" too.
  const merge = useCallback((s: ExtensionStatus | null): ExtensionStatus | null => {
    if (!s) return s
    const ok = confirmedRef.current
    const browsers = s.browsers.map((b) => ({ ...b, extensionInstalled: b.extensionInstalled || ok.includes(b.id) }))
    return { ...s, browsers, anyInstalled: s.anyInstalled || ok.length > 0 || browsers.some((b) => b.extensionInstalled) }
  }, [])
  const status = useMemo(() => merge(rawStatus), [merge, rawStatus, confirmed])
  const dir = status?.dir ?? ''
  const autoOpened = useRef(false)
  const updating = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const s = await extensionStatus()
      setStatus(s)
      return merge(s)
    } catch {
      return null
    }
  }, [merge])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Until it is installed, keep checking (the user installs it in the browser).
  useEffect(() => {
    if (status?.anyInstalled) return
    const id = setInterval(refresh, POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(id)
      window.removeEventListener('focus', refresh)
    }
  }, [status?.anyInstalled, refresh])

  // First launch: show the wizard once.
  useEffect(() => {
    if (!status || autoOpened.current) return
    autoOpened.current = true
    if (!settings.extensionWizardDone && !status.anyInstalled) setWizardOpen(true)
  }, [status, settings.extensionWizardDone])

  // Keep the copied extension up to date when the app ships a newer version.
  useEffect(() => {
    if (!status?.copiedVersion || !status.bundledVersion || updating.current) return
    if (status.copiedVersion === status.bundledVersion) return
    updating.current = true
    installExtension()
      .then(refresh)
      .catch(() => {})
      .finally(() => (updating.current = false))
  }, [status, refresh])

  const markConfirmed = useCallback(
    (browser: string) => {
      if (confirmedRef.current.includes(browser)) return
      const next = [...confirmedRef.current, browser]
      confirmedRef.current = next
      updateSettings({ extensionConfirmed: next })
    },
    [updateSettings],
  )

  const openWizard = useCallback(() => setWizardOpen(true), [])
  const closeWizard = useCallback(() => {
    setWizardOpen(false)
    updateSettings({ extensionWizardDone: true })
  }, [updateSettings])

  const value = useMemo(
    () => ({ status, dir, refresh, markConfirmed, wizardOpen, openWizard, closeWizard }),
    [status, dir, refresh, markConfirmed, wizardOpen, openWizard, closeWizard],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useExtension() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useExtension must be used inside <ExtensionProvider>')
  return ctx
}
