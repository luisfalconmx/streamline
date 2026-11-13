import type { Update } from '@tauri-apps/plugin-updater'
import { isTauri } from './tauri'

/**
 * Asks GitHub (`latest.json` of the latest release) whether a newer version
 * exists. Any problem (offline, no release for this platform yet, dev build)
 * simply means "no update".
 */
export async function checkForUpdate(): Promise<Update | null> {
  if (!isTauri()) return null
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    return await check({ timeout: 15_000 })
  } catch (e) {
    console.info('Sin actualización disponible:', e)
    return null
  }
}

/**
 * Downloads the new version, checks its signature, installs it over the
 * current one and restarts the app. `onProgress` receives 0–1 (or null while
 * the size is unknown). On Windows the installer closes the app by itself.
 */
export async function installUpdate(update: Update, onProgress: (p: number | null) => void): Promise<void> {
  let total = 0
  let done = 0
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? 0
      onProgress(total ? 0 : null)
    } else if (event.event === 'Progress') {
      done += event.data.chunkLength
      onProgress(total ? Math.min(done / total, 1) : null)
    } else {
      onProgress(1)
    }
  })
  const { relaunch } = await import('@tauri-apps/plugin-process')
  await relaunch()
}
