import type { DownloadRequest, MediaMode, Settings } from './types'

export function buildRequest(
  url: string,
  format: string,
  mode: MediaMode,
  settings: Settings,
  audio?: { format?: string; quality?: string },
  opts: { remux?: boolean } = {},
): Omit<DownloadRequest, 'id'> {
  const isAudio = mode === 'audio'
  return {
    url,
    format,
    outputDir: settings.outputDir,
    audioFormat: isAudio ? (audio?.format ?? settings.audioFormat) : undefined,
    audioQuality: isAudio ? (audio?.quality ?? '0') : undefined,
    mergeFormat: isAudio ? undefined : settings.mergeFormat,
    remuxVideo: !isAudio && !!opts.remux,
    embedSubs: !isAudio && settings.embedSubs,
    subLangs: settings.subLangs,
    // Thumbnails cannot be embedded into WAV/WebM files.
    embedThumbnail:
      settings.embedThumbnail &&
      !(isAudio && audio?.format === 'wav') &&
      !(!isAudio && settings.mergeFormat === 'webm'),
    embedMetadata: settings.embedMetadata,
    sponsorblock: settings.sponsorblock,
    concurrentFragments: settings.concurrentFragments,
    cookiesBrowser: settings.cookiesBrowser || undefined,
    filenameTemplate: settings.filenameTemplate || undefined,
  }
}
