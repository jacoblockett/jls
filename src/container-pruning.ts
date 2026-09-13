import { existsSync, lstatSync, readdirSync, rmdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export function containerAncestors(filePath: string, boundary: string): string[] {
  const root = resolve(boundary)
  let current = dirname(resolve(filePath))
  const rel = relative(root, current)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return []

  const result: string[] = []
  while (current !== root) {
    result.push(current)
    current = dirname(current)
  }
  return result
}

function pruneEmptyDirectory(path: string): boolean {
  if (!existsSync(path)) return false
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false
  if (readdirSync(path).length !== 0) return false
  rmdirSync(path)
  return true
}

export function pruneEmptyContainers(paths: string[]): void {
  // Containers are never ownership evidence. Pruning is safe only because each
  // candidate is explicitly known and is rechecked to be a real empty directory.
  const candidates = [...new Set(paths.map((path) => resolve(path)))]
    .sort((a, b) => b.length - a.length)

  for (const path of candidates) {
    if (!pruneEmptyDirectory(path)) continue

    // Harness adapters commonly create a neutral leaf such as `skills` or
    // `agents` inside a hidden harness root. If that known leaf is gone and its
    // immediate hidden parent is now empty, prune that shell too. Never climb
    // beyond this one parent, so the selected management root is not a candidate.
    const parent = dirname(path)
    if (!basename(path).startsWith('.') && basename(parent).startsWith('.')) {
      pruneEmptyDirectory(parent)
    }
  }
}
