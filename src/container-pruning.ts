import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
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

function isStrictDescendant(path: string, boundary: string): boolean {
  const rel = relative(boundary, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function removeOwnedSubtree(path: string): void {
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return
  rmSync(path, { recursive: true, force: true })
}

function pruneEmptyOwnedRoot(path: string): void {
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return
  if (readdirSync(path).length !== 0) return
  rmdirSync(path)
}

export function pruneEmptyContainers(paths: string[]): void {
  const candidates = [...new Set(paths.map((path) => resolve(path)))]
  const outerBoundaries = candidates.filter((path) => (
    !candidates.some((other) => other !== path && isStrictDescendant(path, other))
  ))

  // The lifecycle passes shared harness containers as outer boundaries and the
  // JLS-owned skill/runtime directories beneath them as nested candidates.
  // Remove only those nested owned subtrees. Never climb into or prune the
  // harness boundary itself (.agents/skills, .codex/agents, .claude/*, etc.).
  for (const path of candidates.sort((a, b) => b.length - a.length)) {
    if (outerBoundaries.includes(path)) continue
    removeOwnedSubtree(path)
  }

  // These outer roots are JLS-owned rather than harness-owned. Remove them only
  // when empty so another installed skill/runtime or installer manifest survives.
  for (const path of outerBoundaries) {
    const name = basename(path)
    if (name === '.jls' || name === 'skill-manifests') pruneEmptyOwnedRoot(path)
  }
}
