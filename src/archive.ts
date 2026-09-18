import AdmZip from 'adm-zip'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function containedPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty path`)
  }

  const normalized = value.replaceAll('\\', '/')
  const parts = normalized.split('/').filter((part) => part !== '.' && part !== '')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || parts.includes('..')) {
    throw new Error(`${label} must be a relative contained path`)
  }
  return parts.join('/')
}

export function extractZip(archive: string, destinationRoot: string): void {
  let zip: AdmZip
  try {
    zip = new AdmZip(archive)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`could not inspect skill archive: ${message}`)
  }

  const entries = zip.getEntries().map((entry) => ({
    entry,
    path: containedPath(entry.entryName.replace(/\/+$/, ''), 'skill archive entry'),
  }))

  for (const { entry, path } of entries) {
    const destination = join(destinationRoot, path)
    if (entry.isDirectory) {
      mkdirSync(destination, { recursive: true })
      continue
    }
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, entry.getData())
  }
}
