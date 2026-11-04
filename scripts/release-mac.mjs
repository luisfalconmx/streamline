#!/usr/bin/env node
/**
 * Builds the macOS .dmg files locally (Apple Silicon + Intel), zips the browser
 * extension and uploads everything to the GitHub Release of the current version.
 *
 * Usage: pnpm release:mac            (both architectures)
 *        pnpm release:mac --arm-only (only Apple Silicon)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const tag = `v${version}`
const targets = process.argv.includes('--arm-only')
  ? [['aarch64-apple-darwin', 'aarch64']]
  : [['aarch64-apple-darwin', 'aarch64'], ['x86_64-apple-darwin', 'x64']]

const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' })

const dmgs = []
for (const [triple, arch] of targets) {
  console.log(`\n▶ ${triple}`)
  run('rustup', ['target', 'add', triple])
  run('node', ['scripts/fetch-sidecars.mjs', triple])
  run('pnpm', ['tauri', 'build', '--target', triple, '--bundles', 'app,dmg'])
  dmgs.push(join(ROOT, 'src-tauri/target', triple, 'release/bundle/dmg', `Streamline_${version}_${arch}.dmg`))
}

// Browser extension (Chrome/Brave/Edge), zipped for "Load unpacked".
const zip = join(ROOT, 'src-tauri/target', `streamline-extension-${version}.zip`)
run('rm', ['-f', zip])
execFileSync('zip', ['-qr', zip, '.', '-x', '.*'], { cwd: join(ROOT, 'extension'), stdio: 'inherit' })

console.log(`\n▶ Subiendo a ${tag}`)
run('gh', ['release', 'upload', tag, ...dmgs, zip, '--clobber'])
console.log('Listo.')
