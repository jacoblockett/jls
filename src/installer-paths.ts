import { existsSync, realpathSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { basename, dirname, join, normalize, resolve } from 'node:path'

const isWindows = platform() === 'win32'

function rawUserHome(): string {
  return process.env.USERPROFILE || process.env.HOME || homedir()
}

function expandPath(raw: string): string {
  let value = raw.trim()
  value = value.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole)
  value = value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced, plain) => {
    const name = braced || plain
    return process.env[name] ?? whole
  })
  if (value === '~') return rawUserHome()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(rawUserHome(), value.slice(2))
  return value
}

export function normalizedPath(path: string): string {
  const value = normalize(path)
  if (!isWindows) return value
  return value.replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`)
}

export function canonicalPath(raw: string): string {
  const absolute = resolve(expandPath(raw))
  if (existsSync(absolute)) {
    try {
      return normalizedPath(realpathSync.native(absolute))
    } catch {}
  }
  if (isWindows) {
    let existing = absolute
    const missing: string[] = []
    while (!existsSync(existing)) {
      const parent = dirname(existing)
      if (parent === existing) break
      missing.unshift(basename(existing))
      existing = parent
    }
    if (existsSync(existing)) {
      try {
        return normalizedPath(join(realpathSync.native(existing), ...missing))
      } catch {}
    }
  }
  return normalizedPath(absolute)
}

export function userHome(): string {
  return canonicalPath(rawUserHome())
}

// UI and lifecycle code must agree on installer-owned paths. Keep this logic
// centralized so path normalization cannot drift between discovery and mutation.
export function installerDataRoot(): string {
  if (isWindows) {
    const local = process.env.LOCALAPPDATA || join(userHome(), 'AppData', 'Local')
    return canonicalPath(join(local, 'JLS'))
  }
  const data = process.env.XDG_DATA_HOME || join(userHome(), '.local', 'share')
  return canonicalPath(join(data, 'JLS'))
}

export function skillMetadataRoot(): string {
  return join(installerDataRoot(), 'skill-manifests')
}

export function cachedManifestPath(name: string): string {
  return join(skillMetadataRoot(), `${name}.json`)
}
