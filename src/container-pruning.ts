import { existsSync, lstatSync, readdirSync, rmdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

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

export function pruneEmptyContainers(paths: string[]): void {
  // Containers are never ownership evidence. Pruning is safe only because each
  // candidate is explicitly known and is rechecked to be a real empty directory.
  const candidates = [...new Set(paths.map((path) => resolve(path)))]
    .sort((a, b) => b.length - a.length)

  for (const path of candidates) {
    if (!existsSync(path)) continue
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue
    if (readdirSync(path).length !== 0) continue
    rmdirSync(path)
  }
}
