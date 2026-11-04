import { browserId, handshakeLink } from './shared.js'

// Tell the desktop app that the extension is installed. Opening a custom
// scheme from the extension tab shows the browser's "Open Streamline?" prompt.
async function connect() {
  const link = handshakeLink(await browserId(), chrome.runtime.getManifest().version)
  const tab = await chrome.tabs.getCurrent()
  if (tab?.id != null) await chrome.tabs.update(tab.id, { url: link })
  else location.href = link
  await chrome.storage.local.set({ connected: true })
}

const btn = document.getElementById('connect')
btn.addEventListener('click', async () => {
  await connect()
  btn.classList.add('ok')
  btn.textContent = 'Abriendo Streamline…'
})

connect().catch(() => {})
