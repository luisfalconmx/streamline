#!/usr/bin/env node
/**
 * Downloads the external binaries bundled with Streamline as Tauri sidecars:
 *   - yt-dlp  (official standalone builds from github.com/yt-dlp/yt-dlp)
 *   - ffmpeg / ffprobe (merging formats, audio extraction, thumbnails)
 *   - deno (JavaScript runtime yt-dlp needs for full YouTube support)
 *
 * Usage: node scripts/fetch-sidecars.mjs [target-triple] [--force]
 * The target triple defaults to the host (`rustc -vV`), or to TAURI_TARGET / TARGET.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src-tauri', 'binaries')
const args = process.argv.slice(2)
const force = args.includes('--force')

function hostTriple() {
  try {
    const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    return out.match(/host: (\S+)/)[1]
  } catch {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
    if (process.platform === 'darwin') return `${arch}-apple-darwin`
    if (process.platform === 'win32') return `${arch}-pc-windows-msvc`
    return `${arch}-unknown-linux-gnu`
  }
}

const triple = args.find((a) => !a.startsWith('--')) || process.env.TAURI_TARGET || process.env.TARGET || hostTriple()
const isWin = triple.includes('windows')
const isMac = triple.includes('apple-darwin')
const isArm = triple.startsWith('aarch64')
const exe = isWin ? '.exe' : ''

const YTDLP = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
const FFBUILDS = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest'
const DENO = 'https://github.com/denoland/deno/releases/latest/download'
const MARTIN = 'https://ffmpeg.martin-riedl.de/redirect/latest/macos'

function sources() {
  const ytdlp = isMac
    ? `${YTDLP}/yt-dlp_macos`
    : isWin
      ? `${YTDLP}/${isArm ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe'}`
      : `${YTDLP}/${isArm ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'}`

  let ffmpeg
  if (isMac) {
    const a = isArm ? 'arm64' : 'amd64'
    ffmpeg = {
      ffmpeg: { url: `${MARTIN}/${a}/release/ffmpeg.zip`, file: 'ffmpeg' },
      ffprobe: { url: `${MARTIN}/${a}/release/ffprobe.zip`, file: 'ffprobe' },
    }
  } else {
    const name = isWin ? (isArm ? 'winarm64' : 'win64') : isArm ? 'linuxarm64' : 'linux64'
    const ext = isWin ? 'zip' : 'tar.xz'
    const url = `${FFBUILDS}/ffmpeg-master-latest-${name}-gpl.${ext}`
    ffmpeg = {
      ffmpeg: { url, file: `ffmpeg${exe}` },
      ffprobe: { url, file: `ffprobe${exe}` },
    }
  }
  const deno = { url: `${DENO}/deno-${triple}.zip`, file: `deno${exe}` }
  return { ytdlp, ffmpeg, deno }
}

async function download(url, dest) {
  process.stdout.write(`  ↓ ${url}\n`)
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'streamline-build' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(dest, buf)
  return dest
}

function extract(archive, dir) {
  mkdirSync(dir, { recursive: true })
  if (archive.endsWith('.zip')) {
    try {
      execFileSync('unzip', ['-o', '-q', archive, '-d', dir], { stdio: 'inherit' })
    } catch {
      // bsdtar (macOS, Windows 10+) understands zip archives too.
      execFileSync('tar', ['-xf', archive, '-C', dir], { stdio: 'inherit' })
    }
  } else {
    execFileSync('tar', ['-xJf', archive, '-C', dir], { stdio: 'inherit' })
  }
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) {
      const found = findFile(p, name)
      if (found) return found
    } else if (entry === name) {
      return p
    }
  }
  return null
}

function target(name) {
  return join(OUT, `${name}-${triple}${exe}`)
}

function install(src, name) {
  const dest = target(name)
  copyFileSync(src, dest)
  if (!isWin) chmodSync(dest, 0o755)
  const mb = (statSync(dest).size / 1024 / 1024).toFixed(1)
  console.log(`  ✓ ${dest.replace(ROOT + '/', '')} (${mb} MB)`)
}

async function main() {
  console.log(`Sidecars para ${triple}`)
  mkdirSync(OUT, { recursive: true })
  const tmp = join(tmpdir(), `streamline-sidecars-${triple}-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  const src = sources()

  try {
    // yt-dlp
    if (force || !existsSync(target('yt-dlp'))) {
      const f = await download(src.ytdlp, join(tmp, `yt-dlp${exe}`))
      install(f, 'yt-dlp')
    } else console.log('  • yt-dlp ya existe')

    // ffmpeg + ffprobe
    const archives = new Map()
    for (const tool of ['ffmpeg', 'ffprobe']) {
      if (!force && existsSync(target(tool))) {
        console.log(`  • ${tool} ya existe`)
        continue
      }
      const { url, file } = src.ffmpeg[tool]
      let dir = archives.get(url)
      if (!dir) {
        const archive = await download(url, join(tmp, `${tool}-${url.split('/').pop()}`))
        dir = join(tmp, `x-${tool}`)
        extract(archive, dir)
        archives.set(url, dir)
      }
      const bin = findFile(dir, file)
      if (!bin) throw new Error(`${file} no encontrado en ${url}`)
      install(bin, tool)
    }

    // deno
    if (force || !existsSync(target('deno'))) {
      const archive = await download(src.deno.url, join(tmp, 'deno.zip'))
      const dir = join(tmp, 'x-deno')
      extract(archive, dir)
      install(findFile(dir, src.deno.file), 'deno')
    } else console.log('  • deno ya existe')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  console.log('Listo.')
}

main().catch((e) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
