import { existsSync, lstatSync, readdirSync, rmdirSync } from 'node:fs'
import { resolve } from 'node:path'

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
