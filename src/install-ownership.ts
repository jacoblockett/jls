import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OWNERSHIP_MARKER = '.jls-owned.json'

type OwnershipMarker = {
  format: 1
  owner: 'jls'
  kind: 'runtime-root' | 'skill-runtime' | 'generated-data'
  skill?: string
}

type GeneratedDataSpec = {
  path: string
  marker?: string
  ownership_marker?: string
}

function markerPath(root: string): string {
  return join(root, OWNERSHIP_MARKER)
}

function parseMarker(path: string): OwnershipMarker | undefined {
  if (!existsSync(path) || !statSync(path).isFile()) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as OwnershipMarker
    if (value?.format !== 1 || value.owner !== 'jls') return undefined
    if (!['runtime-root', 'skill-runtime', 'generated-data'].includes(value.kind)) return undefined
    return value
  } catch {
    return undefined
  }
}

function readMarker(root: string): OwnershipMarker | undefined {
  return parseMarker(markerPath(root))
}

function writeMarker(root: string, marker: OwnershipMarker): void {
  mkdirSync(root, { recursive: true })
  const path = markerPath(root)
  if (existsSync(path)) return
  writeFileSync(path, `${JSON.stringify(marker)}\n`, { flag: 'wx' })
}

export function runtimeMetaRoot(scopeRoot: string): string {
  return join(scopeRoot, '.jls')
}

export function runtimeSkillRoot(scopeRoot: string, skill: string): string {
  return join(runtimeMetaRoot(scopeRoot), skill)
}

export function runtimeRootOwned(scopeRoot: string): boolean {
  const marker = readMarker(runtimeMetaRoot(scopeRoot))
  return marker?.kind === 'runtime-root' && marker.skill === undefined
}

export function runtimeSkillOwned(scopeRoot: string, skill: string): boolean {
  const marker = readMarker(runtimeSkillRoot(scopeRoot, skill))
  return marker?.kind === 'skill-runtime' && marker.skill === skill
}

export function generatedDataOwned(target: string, skill: string, ownershipMarker: string): boolean {
  const marker = parseMarker(join(target, ownershipMarker))
  return marker?.kind === 'generated-data' && marker.skill === skill
}

export function assertRuntimeLayoutAvailable(
  scopeRoot: string,
  skill: string,
  legacyRootOwned = false,
  legacySkillOwned = false,
): void {
  const metaRoot = runtimeMetaRoot(scopeRoot)
  if (existsSync(metaRoot)) {
    if (!statSync(metaRoot).isDirectory()) {
      throw new Error(`runtime path collides with an existing non-directory: ${metaRoot}`)
    }
    const marker = markerPath(metaRoot)
    if (existsSync(marker) && !runtimeRootOwned(scopeRoot)) {
      throw new Error(`runtime path has an invalid JLS ownership marker: ${metaRoot}`)
    }
    if (!existsSync(marker) && !legacyRootOwned) {
      throw new Error(`runtime path collides with an existing path not owned by JLS: ${metaRoot}`)
    }
  }

  const skillRoot = runtimeSkillRoot(scopeRoot, skill)
  if (existsSync(skillRoot)) {
    if (!statSync(skillRoot).isDirectory()) {
      throw new Error(`runtime path collides with an existing non-directory: ${skillRoot}`)
    }
    const marker = markerPath(skillRoot)
    if (existsSync(marker) && !runtimeSkillOwned(scopeRoot, skill)) {
      throw new Error(`runtime path has an invalid JLS ownership marker: ${skillRoot}`)
    }
    if (!existsSync(marker) && !legacySkillOwned) {
      throw new Error(`runtime path collides with an existing path not owned by JLS: ${skillRoot}`)
    }
  }
}

export function markRuntimeLayout(scopeRoot: string, skill: string): void {
  const metaRoot = runtimeMetaRoot(scopeRoot)
  const skillRoot = runtimeSkillRoot(scopeRoot, skill)
  writeMarker(metaRoot, { format: 1, owner: 'jls', kind: 'runtime-root' })
  writeMarker(skillRoot, { format: 1, owner: 'jls', kind: 'skill-runtime', skill })
}

export function cleanupRuntimeMetaRoot(scopeRoot: string): void {
  const metaRoot = runtimeMetaRoot(scopeRoot)
  if (!existsSync(metaRoot) || !statSync(metaRoot).isDirectory()) return
  const entries = readdirSync(metaRoot)
  if (entries.length === 0) {
    rmdirSync(metaRoot)
    return
  }
  if (!runtimeRootOwned(scopeRoot)) return
  const remaining = entries.filter((entry) => entry !== OWNERSHIP_MARKER)
  if (remaining.length > 0) return
  rmSync(markerPath(metaRoot), { force: true })
  rmdirSync(metaRoot)
}

export function assertGeneratedDataOwnership(
  scopeRoot: string,
  skill: string,
  specs: GeneratedDataSpec[] | undefined,
): void {
  for (const spec of specs ?? []) {
    const target = join(scopeRoot, spec.path)
    if (!existsSync(target)) continue
    if (!statSync(target).isDirectory()) {
      throw new Error(`${skill} generated-data path collides with an existing non-directory: ${target}`)
    }
    if (spec.ownership_marker) {
      if (!generatedDataOwned(target, skill, spec.ownership_marker)) {
        throw new Error(`${skill} generated-data path already exists but does not carry its JLS ownership contract: ${target}`)
      }
      continue
    }
    if (!spec.marker) {
      throw new Error(`${skill} generated-data path already exists without an ownership marker contract: ${target}`)
    }
    const marker = join(target, spec.marker)
    if (!existsSync(marker) || !statSync(marker).isFile()) {
      throw new Error(`${skill} generated-data path already exists but is not identified as ${skill} data: ${target}`)
    }
  }
}

export function assertVacantOrOwned(path: string, owned: boolean, label: string): void {
  if (existsSync(path) && !owned) throw new Error(`${label} collides with an existing path not owned by JLS: ${path}`)
}
