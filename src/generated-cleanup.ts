import { existsSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { platform } from 'node:os'
import { spawnSync } from 'node:child_process'
import { generatedDataOwned } from './install-ownership'

export type PathCleanupSpec = {
  kind: 'path'
  path: string
  marker?: string
  ownershipMarker?: string
  description: string
}

export type BeadsMetadataCleanupSpec = {
  kind: 'beads-metadata'
  description: string
  metadataKey: string
  metadataValue: string
}

export type CleanupSpec = PathCleanupSpec | BeadsMetadataCleanupSpec

export type DetectedCleanup = {
  skill: string
  description: string
  spec: CleanupSpec
  paths?: string[]
  issueIds?: string[]
}

export type RawSkillManifest = {
  name: string
  generated_data?: unknown
  generated_cleanup?: unknown
}

type RunResult = {
  status: number | null
  stdout: string
  stderr: string
}

type Runner = (command: string, args: string[], cwd: string) => RunResult

const isWindows = platform() === 'win32'

function defaultRunner(command: string, args: string[], cwd: string): RunResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function commandExists(command: string): boolean {
  return spawnSync(isWindows ? 'where' : 'which', [command], {
    stdio: 'ignore',
    windowsHide: true,
  }).status === 0
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function containedRelativePath(value: unknown, label: string): string {
  const path = nonEmptyString(value, label)
  const parts = path.split(/[\\/]+/)
  if (isAbsolute(path) || parts.includes('..')) throw new Error(`${label} must be a relative contained path`)
  return path
}

export function cleanupSpecs(raw: RawSkillManifest): CleanupSpec[] {
  const specs: CleanupSpec[] = []

  if (raw.generated_data !== undefined) {
    if (!Array.isArray(raw.generated_data)) throw new Error(`${raw.name} generated_data must be an array`)
    raw.generated_data.forEach((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${raw.name} generated_data[${index}] is invalid`)
      }
      const entry = value as Record<string, unknown>
      const path = containedRelativePath(entry.path, `${raw.name} generated_data[${index}].path`)
      const marker = entry.marker === undefined
        ? undefined
        : containedRelativePath(entry.marker, `${raw.name} generated_data[${index}].marker`)
      const ownershipMarker = entry.ownership_marker === undefined
        ? undefined
        : containedRelativePath(entry.ownership_marker, `${raw.name} generated_data[${index}].ownership_marker`)
      const description = typeof entry.description === 'string' && entry.description.trim()
        ? entry.description.trim()
        : `Generated data at ${path}`
      specs.push({ kind: 'path', path, marker, ownershipMarker, description })
    })
  }

  if (raw.generated_cleanup !== undefined) {
    if (!Array.isArray(raw.generated_cleanup)) throw new Error(`${raw.name} generated_cleanup must be an array`)
    raw.generated_cleanup.forEach((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${raw.name} generated_cleanup[${index}] is invalid`)
      }
      const entry = value as Record<string, unknown>
      if (entry.kind !== 'beads-metadata') {
        throw new Error(`${raw.name} generated_cleanup[${index}] has unsupported kind ${String(entry.kind)}`)
      }
      const metadataKey = nonEmptyString(entry.metadata_key, `${raw.name} generated_cleanup[${index}].metadata_key`)
      const metadataValue = nonEmptyString(entry.metadata_value, `${raw.name} generated_cleanup[${index}].metadata_value`)
      if (!/^[A-Za-z0-9_.:-]+$/.test(metadataKey)) {
        throw new Error(`${raw.name} generated_cleanup[${index}] has invalid metadata_key`)
      }
      const description = nonEmptyString(entry.description, `${raw.name} generated_cleanup[${index}].description`)
      specs.push({ kind: 'beads-metadata', description, metadataKey, metadataValue })
    })
  }

  return specs
}

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function cleanupPath(scopeRoot: string, spec: PathCleanupSpec): string {
  const root = resolve(scopeRoot)
  const target = resolve(root, spec.path)
  if (!pathWithin(root, target)) throw new Error(`generated-data path escaped selected scope: ${spec.path}`)
  return normalize(target)
}

function parseIssues(stdout: string, spec: BeadsMetadataCleanupSpec): string[] {
  const parsed = JSON.parse(stdout || '[]') as unknown
  const issues = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).issues)
      ? (parsed as Record<string, unknown>).issues as unknown[]
      : []

  const ids: string[] = []
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) continue
    const record = issue as Record<string, unknown>
    const metadata = record.metadata
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue
    if ((metadata as Record<string, unknown>)[spec.metadataKey] !== spec.metadataValue) continue
    if (typeof record.id === 'string' && record.id.trim()) ids.push(record.id.trim())
  }
  return [...new Set(ids)].sort()
}

export function beadsIssueIds(
  scopeRoot: string,
  spec: BeadsMetadataCleanupSpec,
  runner: Runner = defaultRunner,
): string[] {
  const beadsRoot = join(scopeRoot, '.beads')
  if (!existsSync(beadsRoot) || !statSync(beadsRoot).isDirectory()) return []
  if (runner === defaultRunner && !commandExists('bd')) return []

  const filter = `${spec.metadataKey}=${spec.metadataValue}`
  const result = runner('bd', ['list', '--metadata-field', filter, '--json', '--limit', '0'], scopeRoot)
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`
    throw new Error(`failed to inspect Beads generated data: ${detail}`)
  }
  return parseIssues(result.stdout, spec)
}

export function detectGeneratedCleanup(
  scopeRoot: string,
  manifest: RawSkillManifest,
  runner: Runner = defaultRunner,
): DetectedCleanup[] {
  const result: DetectedCleanup[] = []
  for (const spec of cleanupSpecs(manifest)) {
    if (spec.kind === 'path') {
      const path = cleanupPath(scopeRoot, spec)
      if (!existsSync(path)) continue
      if (spec.ownershipMarker) {
        if (!generatedDataOwned(path, manifest.name, spec.ownershipMarker)) continue
      } else if (spec.marker && !existsSync(join(path, spec.marker))) {
        continue
      }
      result.push({ skill: manifest.name, description: spec.description, spec, paths: [path] })
      continue
    }

    const issueIds = beadsIssueIds(scopeRoot, spec, runner)
    if (issueIds.length > 0) {
      result.push({ skill: manifest.name, description: spec.description, spec, issueIds })
    }
  }
  return result
}

export function removeGeneratedCleanup(
  scopeRoot: string,
  cleanup: DetectedCleanup,
  runner: Runner = defaultRunner,
): void {
  if (cleanup.spec.kind === 'path') {
    for (const path of cleanup.paths ?? []) {
      if (cleanup.spec.ownershipMarker && !generatedDataOwned(path, cleanup.skill, cleanup.spec.ownershipMarker)) {
        throw new Error(`refusing to remove generated data whose JLS ownership contract no longer matches: ${path}`)
      }
      if (!cleanup.spec.ownershipMarker && cleanup.spec.marker && !existsSync(join(path, cleanup.spec.marker))) {
        throw new Error(`refusing to remove generated data whose marker no longer exists: ${path}`)
      }
      rmSync(path, { recursive: true, force: true })
    }
    return
  }

  // Re-query at execution time so the deletion set is defined exclusively by
  // explicit structured metadata, never by a stale title/body/text match.
  const issueIds = beadsIssueIds(scopeRoot, cleanup.spec, runner)
  for (let offset = 0; offset < issueIds.length; offset += 100) {
    const batch = issueIds.slice(offset, offset + 100)
    if (batch.length === 0) continue
    const result = runner('bd', ['delete', ...batch, '--force'], scopeRoot)
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`
      throw new Error(`failed to remove Tasks-generated Beads issues: ${detail}`)
    }
  }
}
