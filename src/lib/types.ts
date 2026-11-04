/** Subset of the yt-dlp info JSON (`-J`) that Streamline uses. */
export interface YtFormat {
  format_id: string
  format_note?: string
  ext: string
  vcodec?: string
  acodec?: string
  width?: number | null
  height?: number | null
  fps?: number | null
  tbr?: number | null
  abr?: number | null
  vbr?: number | null
  asr?: number | null
  filesize?: number | null
  filesize_approx?: number | null
  dynamic_range?: string | null
  protocol?: string
  language?: string | null
  audio_channels?: number | null
  has_drm?: boolean | string
}

export interface YtEntry {
  id: string
  url: string
  title?: string
  duration?: number | null
  thumbnails?: { url: string; width?: number; height?: number }[]
  uploader?: string | null
  channel?: string | null
}

export interface YtInfo {
  _type?: 'video' | 'playlist' | 'url' | 'multi_video'
  id: string
  title: string
  fulltitle?: string
  webpage_url: string
  original_url?: string
  extractor_key?: string
  extractor?: string
  uploader?: string | null
  channel?: string | null
  channel_follower_count?: number | null
  duration?: number | null
  duration_string?: string
  view_count?: number | null
  like_count?: number | null
  upload_date?: string | null
  thumbnail?: string | null
  thumbnails?: { url: string; width?: number; height?: number }[]
  description?: string | null
  is_live?: boolean
  /** Set by the generic extractor for direct file links */
  direct?: boolean
  formats?: YtFormat[]
  subtitle_langs?: string[]
  entries?: YtEntry[]
  playlist_count?: number
  // Single-format results
  format_id?: string
  ext?: string
  filesize?: number | null
  filesize_approx?: number | null
  height?: number | null
}

export type MediaMode = 'video' | 'audio'

export interface QualityOption {
  key: string
  label: string
  sublabel: string
  badge?: string
  /** yt-dlp `-f` selector */
  format: string
  /** Estimated final size in bytes, if known */
  size?: number
  approx?: boolean
  height?: number
  audioFormat?: string
  audioQuality?: string
  /** Container of the source file (direct links) */
  ext?: string
  /** Separate URL for this quality (qualities sent by the browser extension) */
  url?: string
}

export type DownloadStatus =
  | 'queued'
  | 'starting'
  | 'downloading'
  | 'processing'
  | 'done'
  | 'error'
  | 'cancelled'

export interface DownloadItem {
  id: string
  url: string
  title: string
  thumbnail?: string | null
  uploader?: string | null
  duration?: number | null
  qualityLabel: string
  mode: MediaMode
  estimatedSize?: number
  request: Omit<DownloadRequest, 'id'>
  status: DownloadStatus
  stage?: string
  stream?: 'video' | 'audio' | 'av'
  downloaded?: number
  total?: number
  /** Bytes of streams already finished (video before audio, etc.) */
  completedBytes?: number
  speed?: number
  eta?: number
  /** 0..1 */
  progress: number
  filePath?: string
  error?: string
  createdAt: number
  finishedAt?: number
}

export interface DownloadRequest {
  id: string
  url: string
  format: string
  outputDir: string
  audioFormat?: string
  audioQuality?: string
  mergeFormat?: string
  remuxVideo?: boolean
  embedSubs: boolean
  subLangs?: string
  embedThumbnail: boolean
  embedMetadata: boolean
  sponsorblock: boolean
  concurrentFragments: number
  cookiesBrowser?: string
  filenameTemplate?: string
  /** Forced output extension (direct links whose URL hides the real type) */
  ext?: string
  /** Literal file name instead of yt-dlp's %(title)s */
  title?: string
  /** Page the video was found on (browser extension) */
  referer?: string
}

export type DownloadEvent =
  | {
      kind: 'progress'
      id: string
      status: string
      downloaded?: number | null
      total?: number | null
      speed?: number | null
      eta?: number | null
      stream: 'video' | 'audio' | 'av'
      fragmentIndex?: number | null
      fragmentCount?: number | null
    }
  | { kind: 'stage'; id: string; stage: string }
  | { kind: 'file'; id: string; path: string }
  | { kind: 'done'; id: string }
  | { kind: 'error'; id: string; message: string }
  | { kind: 'cancelled'; id: string }

export interface ToolVersions {
  ytdlp?: string | null
  ffmpeg?: string | null
  deno?: string | null
}

export interface Settings {
  outputDir: string
  mergeFormat: 'mp4' | 'mkv' | 'webm'
  preferH264: boolean
  audioFormat: 'mp3' | 'm4a' | 'opus' | 'flac' | 'wav'
  embedThumbnail: boolean
  embedMetadata: boolean
  embedSubs: boolean
  subLangs: string
  sponsorblock: boolean
  concurrentFragments: number
  maxParallel: number
  cookiesBrowser: string
  autoAnalyzeClipboard: boolean
  filenameTemplate: string
  /** The first-run extension wizard was shown and closed */
  extensionWizardDone: boolean
  /** Browsers whose extension confirmed itself via streamline://extension-installed */
  extensionConfirmed: string[]
}

export interface MediaPreview {
  thumbnail?: string | null
  duration?: number | null
  width?: number | null
  height?: number | null
  fps?: number | null
  vcodec?: string | null
  acodec?: string | null
}

export interface BrowserStatus {
  id: 'chrome' | 'brave'
  name: string
  available: boolean
  extensionInstalled: boolean
}

export interface ExtensionStatus {
  os: 'macos' | 'windows' | 'linux' | string
  /** Real folder: <app data>/extension */
  dir: string
  /** macOS: visible shortcut ~/Streamline Extension */
  shortcut?: string | null
  bundledVersion?: string | null
  copiedVersion?: string | null
  browsers: BrowserStatus[]
  anyInstalled: boolean
}
