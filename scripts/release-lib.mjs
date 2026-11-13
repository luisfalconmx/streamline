/**
 * Release helpers shared by CI (Windows/Linux) and `pnpm release:mac`.
 *
 * - Installers are published without the version in their name
 *   (`Streamline_x64-setup.exe`, `Streamline_aarch64.dmg`…), so
 *   `releases/latest/download/<name>` is a permanent download link.
 * - `latest.json` is the manifest the in-app updater reads: one entry per
 *   platform with the signed update file. Each publish merges its platforms
 *   into the manifest already attached to the release.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const REPO = 'luisfalconmx/streamline'

/** What each build target produces, and how it is renamed. */
const TARGETS = {
  'x86_64-pc-windows-msvc': {
    files: [
      { dir: 'nsis', match: /-setup\.exe$/, name: 'Streamline_x64-setup.exe', updater: 'windows-x86_64' },
      { dir: 'msi', match: /\.msi$/, name: 'Streamline_x64.msi' },
    ],
  },
  'x86_64-unknown-linux-gnu': {
    files: [
      { dir: 'appimage', match: /\.AppImage$/, name: 'Streamline_amd64.AppImage', updater: 'linux-x86_64' },
      { dir: 'deb', match: /\.deb$/, name: 'Streamline_amd64.deb' },
      { dir: 'rpm', match: /\.rpm$/, name: 'Streamline.x86_64.rpm' },
    ],
  },
  'aarch64-apple-darwin': {
    files: [
      { dir: 'dmg', match: /\.dmg$/, name: 'Streamline_aarch64.dmg' },
      { dir: 'macos', match: /\.app\.tar\.gz$/, name: 'Streamline_aarch64.app.tar.gz', updater: 'darwin-aarch64' },
    ],
  },
  'x86_64-apple-darwin': {
    files: [
      { dir: 'dmg', match: /\.dmg$/, name: 'Streamline_x64.dmg' },
      { dir: 'macos', match: /\.app\.tar\.gz$/, name: 'Streamline_x64.app.tar.gz', updater: 'darwin-x86_64' },
    ],
  },
}

/**
 * Copies the bundles of `target` into `outDir` with their final names and
 * returns the updater platforms they provide.
 */
export function collect({ bundleDir, target, tag, outDir }) {
  const spec = TARGETS[target]
  if (!spec) throw new Error(`Target sin configurar: ${target}`)
  mkdirSync(outDir, { recursive: true })
  const files = []
  const platforms = {}
  for (const f of spec.files) {
    const dir = join(bundleDir, f.dir)
    const found = existsSync(dir) ? readdirSync(dir).filter((n) => f.match.test(n)) : []
    if (found.length !== 1) throw new Error(`Se esperaba 1 archivo ${f.match} en ${dir}, hay ${found.length}`)
    const dest = join(outDir, f.name)
    copyFileSync(join(dir, found[0]), dest)
    files.push(dest)
    if (f.updater) {
      const sig = join(dir, `${found[0]}.sig`)
      if (!existsSync(sig)) {
        throw new Error(`Falta la firma ${sig}. ¿Se compiló con --config src-tauri/tauri.release.conf.json y TAURI_SIGNING_PRIVATE_KEY?`)
      }
      platforms[f.updater] = {
        signature: readFileSync(sig, 'utf8').trim(),
        url: `https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(f.name)}`,
      }
    }
  }
  return { files, platforms }
}

const gh = (args, opts = {}) => execFileSync('gh', ['--repo', REPO, ...args], { encoding: 'utf8', ...opts })

/**
 * Creates the release if needed, uploads `files` and merges `platforms` into
 * the release's `latest.json`.
 */
export function publish({ tag, version, files, platforms, notes }) {
  try {
    gh(['release', 'view', tag], { stdio: 'pipe' })
  } catch {
    gh(['release', 'create', tag, '--title', `Streamline ${tag}`, '--notes', notes ?? ''], { stdio: 'inherit' })
  }
  if (files.length) gh(['release', 'upload', tag, ...files, '--clobber'], { stdio: 'inherit' })

  const work = join(tmpdir(), `streamline-${tag}-${process.pid}`)
  mkdirSync(work, { recursive: true })
  const manifestPath = join(work, 'latest.json')
  let manifest = { platforms: {} }
  try {
    gh(['release', 'download', tag, '--pattern', 'latest.json', '--dir', work, '--clobber'], { stdio: 'pipe' })
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    /* first publish of this release */
  }
  manifest = {
    version,
    notes: `Streamline ${tag}`,
    pub_date: new Date().toISOString(),
    platforms: { ...manifest.platforms, ...platforms },
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  gh(['release', 'upload', tag, manifestPath, '--clobber'], { stdio: 'inherit' })
  console.log(`latest.json → ${Object.keys(manifest.platforms).sort().join(', ')}`)
}

export function readVersion(root) {
  return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
}

export const RELEASE_NOTES = `## Descargas

| Sistema | Archivo |
| --- | --- |
| macOS (Apple Silicon M1–M4) | [Streamline_aarch64.dmg](https://github.com/${REPO}/releases/latest/download/Streamline_aarch64.dmg) |
| macOS (Intel) | [Streamline_x64.dmg](https://github.com/${REPO}/releases/latest/download/Streamline_x64.dmg) |
| Windows | [Streamline_x64-setup.exe](https://github.com/${REPO}/releases/latest/download/Streamline_x64-setup.exe) o \`.msi\` |
| Linux | [Streamline_amd64.AppImage](https://github.com/${REPO}/releases/latest/download/Streamline_amd64.AppImage), \`.deb\` o \`.rpm\` |

Una vez instalada, Streamline avisa sola cuando hay una versión nueva y se actualiza con un clic (en Linux, con la AppImage).

**macOS:** la app no está firmada con un certificado de Apple. Si macOS dice que está dañada, ejecuta
\`xattr -cr /Applications/Streamline.app\` una vez tras instalarla.

**Windows:** si SmartScreen la bloquea, pulsa «Más información» → «Ejecutar de todas formas».`
