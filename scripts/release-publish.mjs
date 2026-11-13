#!/usr/bin/env node
/**
 * CI step: uploads every collected installer and merges their updater entries
 * into the release's latest.json.
 * Usage: node scripts/release-publish.mjs <dir>
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publish, readVersion, RELEASE_NOTES } from './release-lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = resolve(process.argv[2] ?? 'release-out')
const version = readVersion(ROOT)

const names = readdirSync(dir, { recursive: true }).map(String)
const files = names.filter((n) => !n.endsWith('.json') && /\.(exe|msi|AppImage|deb|rpm|dmg|tar\.gz)$/.test(n)).map((n) => join(dir, n))
const platforms = Object.assign(
  {},
  ...names.filter((n) => /platforms-.*\.json$/.test(n)).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8'))),
)
publish({ tag: `v${version}`, version, files, platforms, notes: RELEASE_NOTES })
