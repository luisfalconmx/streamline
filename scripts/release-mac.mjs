#!/usr/bin/env node
/**
 * Builds the macOS app locally (Apple Silicon + Intel), signs the update
 * packages and uploads the .dmg files and updater entries to the GitHub
 * Release of the current version.
 *
 * Needs the updater private key: ~/.tauri/streamline.key (or the
 * TAURI_SIGNING_PRIVATE_KEY variable).
 *
 * Usage: pnpm release:mac            (both architectures)
 *        pnpm release:mac --arm-only (only Apple Silicon)
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collect, publish, readVersion, RELEASE_NOTES } from './release-lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = readVersion(ROOT)
const tag = `v${version}`
const targets = process.argv.includes('--arm-only')
  ? ['aarch64-apple-darwin']
  : ['aarch64-apple-darwin', 'x86_64-apple-darwin']

const keyFile = join(homedir(), '.tauri/streamline.key')
const env = { ...process.env }
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  if (!existsSync(keyFile)) throw new Error(`Falta la llave del actualizador: ${keyFile}`)
  env.TAURI_SIGNING_PRIVATE_KEY = keyFile
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= ''

const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env })
const outDir = join(ROOT, 'src-tauri/target/release-out')

const files = []
let platforms = {}
for (const target of targets) {
  console.log(`\n▶ ${target}`)
  run('rustup', ['target', 'add', target])
  run('node', ['scripts/fetch-sidecars.mjs', target])
  run('pnpm', ['tauri', 'build', '--target', target, '--bundles', 'app,dmg', '--config', 'src-tauri/tauri.release.conf.json'])
  const bundleDir = join(ROOT, 'src-tauri/target', target, 'release/bundle')
  const r = collect({ bundleDir, target, tag, outDir })
  files.push(...r.files)
  platforms = { ...platforms, ...r.platforms }
}

console.log(`\n▶ Subiendo a ${tag}`)
publish({ tag, version, files, platforms, notes: RELEASE_NOTES })
console.log('Listo.')
