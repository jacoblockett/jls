import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { containedPath, extractZip } from './archive'
import { compiledTarget, isTargetKey, type TargetKey } from './targets'

if (Bun.isStandaloneExecutable) compiledTarget()

export const DEFAULT_RELEASE_MANIFEST_URL = 'https://github.com/jacoblockett/jls/releases/latest/download/manifest.json'

type FetchLike = typeof fetch

export type ReleaseArtifact = {
  url: string
  sha256: string
}

export type TargetArtifactMap = Partial<Record<TargetKey, ReleaseArtifact>>
export type SkillArtifactMap = Partial<Record<TargetKey | 'portable', ReleaseArtifact>>

export type ReleasedSkill = {
  version: string
  min_installer: string
  artifacts: SkillArtifactMap
}

export type SkillReference = {
  manifest_url: string
}

export type ReleaseIndex = {
  format: 3
  installer: {
    version: string
    artifacts: TargetArtifactMap
  }
  skills: Record<string, SkillReference>
}

export type ReleaseManifest = {
  format: 3
  installer: {
    version: string
    artifacts: TargetArtifactMap
  }
  skills: Record<string, ReleasedSkill>
}

export type InstallerUpdate = {
  version: string
  artifact: ReleaseArtifact
}

export type GeneratedDataSpec = {
  path: string
  marker?: string
  ownership_marker?: string
}

export type HarnessResources = Record<string, Record<string, string[]>>

export type SkillPackageManifest = {
  format: 1
  name: string
  version: string
  min_installer: string
  description: string
  skill_files: string[]
  harness_resources?: HarnessResources
  runtime_files?: string[]
  runtime?: string
  runtime_artifacts?: Record<string, string>
  runtime_cli?: string
  cli_token?: string
  instruction_fragment?: string
  generated_data?: GeneratedDataSpec[]
}

export type DownloadedSkillPackage = {
  manifest: SkillPackageManifest
  root: string
  cleanup: () => void
}

export type SelectedSkillArtifact = {
  key: TargetKey | 'portable'
  artifact: ReleaseArtifact
}

function semverParts(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareVersions(a: string, b: string): number {
  const left = semverParts(a)
  const right = semverParts(b)
  if (!left || !right) throw new Error(`invalid semantic version comparison: ${a} vs ${b}`)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

function parseSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} has an invalid SHA-256`)
  }
  return value
}

function parseArtifact(value: unknown, label: string): ReleaseArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${label}`)
  const raw = value as Record<string, unknown>
  if (typeof raw.url !== 'string' || !raw.url.trim()) throw new Error(`${label} is missing a URL`)
  return { url: raw.url, sha256: parseSha256(raw.sha256, label) }
}

function parseArtifactMap(value: unknown, label: string, allowPortable: false): TargetArtifactMap
function parseArtifactMap(value: unknown, label: string, allowPortable: true): SkillArtifactMap
function parseArtifactMap(
  value: unknown,
  label: string,
  allowPortable: boolean,
): TargetArtifactMap | SkillArtifactMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) throw new Error(`${label} must contain at least one artifact`)

  const artifacts: Record<string, ReleaseArtifact> = {}
  for (const [key, artifact] of entries) {
    if (key !== 'portable' && !isTargetKey(key)) throw new Error(`${label} has invalid target ${key}`)
    if (key === 'portable' && !allowPortable) throw new Error(`${label} cannot publish a portable artifact`)
    artifacts[key] = parseArtifact(artifact, `${label}.${key}`)
  }
  return artifacts
}

function parseSkillReference(value: unknown, name: string): SkillReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid released skill reference ${name}`)
  const manifestUrl = (value as Record<string, unknown>).manifest_url
  if (typeof manifestUrl !== 'string' || !manifestUrl.trim()) throw new Error(`${name} skill reference is missing manifest_url`)
  return { manifest_url: manifestUrl }
}

export function parseReleaseManifest(value: unknown): ReleaseIndex {
  if (!value || typeof value !== 'object') throw new Error('invalid release manifest')
  const raw = value as Record<string, unknown>
  if (raw.format !== 3) throw new Error('unsupported release manifest format')

  if (!raw.installer || typeof raw.installer !== 'object') throw new Error('release manifest is missing installer metadata')
  const installerRaw = raw.installer as Record<string, unknown>
  if (typeof installerRaw.version !== 'string' || !semverParts(installerRaw.version)) {
    throw new Error('invalid installer release version')
  }
  const installerArtifacts = parseArtifactMap(installerRaw.artifacts, 'installer release artifacts', false)

  if (!raw.skills || typeof raw.skills !== 'object' || Array.isArray(raw.skills)) {
    throw new Error('release manifest is missing skill references')
  }
  const skills: Record<string, SkillReference> = {}
  for (const [name, reference] of Object.entries(raw.skills as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid released skill name ${name}`)
    skills[name] = parseSkillReference(reference, name)
  }

  return {
    format: 3,
    installer: { version: installerRaw.version, artifacts: installerArtifacts },
    skills,
  }
}

export function parseSkillReleaseManifest(name: string, value: unknown): ReleasedSkill {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid released skill manifest ${name}`)
  const raw = value as Record<string, unknown>
  if (raw.format !== 1) throw new Error(`unsupported released skill manifest format for ${name}`)
  if (raw.name !== name) throw new Error(`released skill manifest for ${name} identifies ${String(raw.name)}`)
  if (typeof raw.version !== 'string' || !semverParts(raw.version)) throw new Error(`invalid released skill version ${name}`)
  if (typeof raw.min_installer !== 'string' || !semverParts(raw.min_installer)) {
    throw new Error(`invalid minimum installer version for ${name}`)
  }
  return {
    version: raw.version,
    min_installer: raw.min_installer,
    artifacts: parseArtifactMap(raw.artifacts, `released skill ${name} artifacts`, true),
  }
}

async function fetchReleaseIndex(
  manifestUrl: string,
  fetcher: FetchLike,
): Promise<ReleaseIndex | null> {
  const response = await fetcher(manifestUrl, { headers: { 'user-agent': 'jls' } })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`stable release check failed with HTTP ${response.status}`)
  return parseReleaseManifest(await response.json())
}

export async function fetchStableReleaseManifest(
  manifestUrl = process.env.JLS_UPDATE_MANIFEST_URL || DEFAULT_RELEASE_MANIFEST_URL,
  fetcher: FetchLike = fetch,
): Promise<ReleaseManifest | null> {
  const index = await fetchReleaseIndex(manifestUrl, fetcher)
  if (!index) return null

  const skills: Record<string, ReleasedSkill> = {}
  await Promise.all(Object.entries(index.skills).map(async ([name, reference]) => {
    const response = await fetcher(reference.manifest_url, { headers: { 'user-agent': 'jls' } })
    if (response.status === 404) return
    if (!response.ok) throw new Error(`${name} release check failed with HTTP ${response.status}`)
    skills[name] = parseSkillReleaseManifest(name, await response.json())
  }))

  return { format: 3, installer: index.installer, skills }
}

function targetKey(target?: TargetKey): TargetKey {
  return target ?? compiledTarget().key
}

export function selectInstallerArtifact(manifest: ReleaseManifest | ReleaseIndex, target: TargetKey): ReleaseArtifact {
  const artifact = manifest.installer.artifacts[target]
  if (!artifact) throw new Error(`installer release has no ${target} artifact`)
  return artifact
}

export function selectSkillArtifact(name: string, released: ReleasedSkill, target: TargetKey): SelectedSkillArtifact {
  const exact = released.artifacts[target]
  if (exact) return { key: target, artifact: exact }
  const portable = released.artifacts.portable
  if (portable) return { key: 'portable', artifact: portable }
  throw new Error(`${name} has no ${target} or portable release artifact`)
}

export async function checkInstallerUpdate(
  currentVersion: string,
  manifestUrl = process.env.JLS_UPDATE_MANIFEST_URL || DEFAULT_RELEASE_MANIFEST_URL,
  fetcher: FetchLike = fetch,
  target?: TargetKey,
): Promise<InstallerUpdate | null> {
  const manifest = await fetchReleaseIndex(manifestUrl, fetcher)
  if (!manifest || compareVersions(manifest.installer.version, currentVersion) <= 0) return null
  const currentTarget = targetKey(target)
  return { version: manifest.installer.version, artifact: selectInstallerArtifact(manifest, currentTarget) }
}

async function downloadVerified(
  artifact: ReleaseArtifact,
  destination: string,
  label: string,
  fetcher: FetchLike = fetch,
): Promise<string> {
  const response = await fetcher(artifact.url, { headers: { 'user-agent': 'jls' } })
  if (!response.ok) throw new Error(`${label} download failed with HTTP ${response.status}`)

  const bytes = new Uint8Array(await response.arrayBuffer())
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== artifact.sha256) {
    throw new Error(`${label} SHA-256 mismatch: expected ${artifact.sha256}, got ${actual}`)
  }

  try {
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, bytes)
    return destination
  } catch (error) {
    try { rmSync(destination, { force: true }) } catch {}
    throw error
  }
}

export async function downloadVerifiedInstaller(
  update: InstallerUpdate,
  destination: string,
  fetcher: FetchLike = fetch,
): Promise<string> {
  const path = await downloadVerified(update.artifact, destination, 'installer update', fetcher)
  try { chmodSync(path, 0o755) } catch {}
  return path
}

export async function stageInstallerUpdate(
  executable: string,
  update: InstallerUpdate,
  fetcher: FetchLike = fetch,
): Promise<string> {
  const staged = join(dirname(executable), `.${basename(executable)}.update-${process.pid}-${Date.now()}`)
  try {
    return await downloadVerifiedInstaller(update, staged, fetcher)
  } catch (error) {
    try { rmSync(staged, { force: true }) } catch {}
    throw error
  }
}

export function windowsReplacementCommand(staged: string, executable: string): string {
  const stagedEscaped = staged.replaceAll('"', '""')
  const executableEscaped = executable.replaceAll('"', '""')
  return `ping 127.0.0.1 -n 2 >nul & move /y "${stagedEscaped}" "${executableEscaped}" >nul`
}

export function scheduleInstallerReplacement(staged: string, executable: string): void {
  if (process.platform !== 'win32') {
    renameSync(staged, executable)
    return
  }

  const child = spawn('cmd.exe', ['/d', '/s', '/c', windowsReplacementCommand(staged, executable)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

function packagePath(value: unknown, label: string): string {
  return containedPath(value, label)
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value
}

function pathArray(value: unknown, label: string, required = false): string[] | undefined {
  if (value === undefined && !required) return undefined
  if (!Array.isArray(value) || (required && value.length === 0)) throw new Error(`${label} must be a non-empty array`)
  return value.map((item, index) => packagePath(item, `${label}[${index}]`))
}

function pathRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = packagePath(item, `${label}.${key}`)
  }
  return result
}

function harnessResources(value: unknown, label: string): HarnessResources | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const result: HarnessResources = {}
  for (const [harness, rawResources] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(harness)) throw new Error(`${label} has invalid harness ${harness}`)
    if (!rawResources || typeof rawResources !== 'object' || Array.isArray(rawResources)) {
      throw new Error(`${label}.${harness} must be an object`)
    }
    const resources: Record<string, string[]> = {}
    for (const [kind, rawPaths] of Object.entries(rawResources as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9_-]*$/.test(kind)) throw new Error(`${label}.${harness} has invalid resource type ${kind}`)
      resources[kind] = pathArray(rawPaths, `${label}.${harness}.${kind}`, true)!
    }
    result[harness] = resources
  }
  return result
}

export function parseSkillPackageManifest(value: unknown): SkillPackageManifest {
  if (!value || typeof value !== 'object') throw new Error('invalid skill package manifest')
  const raw = value as Record<string, unknown>
  if (raw.format !== 1) throw new Error('unsupported skill package manifest format')
  if (typeof raw.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(raw.name)) throw new Error('invalid skill package name')
  if (typeof raw.version !== 'string' || !semverParts(raw.version)) throw new Error(`invalid ${raw.name} package version`)
  if (typeof raw.min_installer !== 'string' || !semverParts(raw.min_installer)) {
    throw new Error(`invalid ${raw.name} minimum installer version`)
  }
  if (typeof raw.description !== 'string' || !raw.description.trim()) throw new Error(`${raw.name} package is missing description`)

  const generatedData: GeneratedDataSpec[] | undefined = raw.generated_data === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(raw.generated_data)) throw new Error(`${raw.name} generated_data must be an array`)
      return raw.generated_data.map((value, index) => {
        if (!value || typeof value !== 'object') throw new Error(`${raw.name} generated_data[${index}] is invalid`)
        const entry = value as Record<string, unknown>
        return {
          path: packagePath(entry.path, `${raw.name} generated_data[${index}].path`),
          marker: entry.marker === undefined
            ? undefined
            : packagePath(entry.marker, `${raw.name} generated_data[${index}].marker`),
          ownership_marker: entry.ownership_marker === undefined
            ? undefined
            : packagePath(entry.ownership_marker, `${raw.name} generated_data[${index}].ownership_marker`),
        }
      })
    })()

  return {
    format: 1,
    name: raw.name,
    version: raw.version,
    min_installer: raw.min_installer,
    description: raw.description,
    skill_files: pathArray(raw.skill_files, `${raw.name} skill_files`, true)!,
    harness_resources: harnessResources(raw.harness_resources, `${raw.name} harness_resources`),
    runtime_files: pathArray(raw.runtime_files, `${raw.name} runtime_files`),
    runtime: optionalString(raw.runtime, `${raw.name} runtime`),
    runtime_artifacts: pathRecord(raw.runtime_artifacts, `${raw.name} runtime_artifacts`),
    runtime_cli: optionalString(raw.runtime_cli, `${raw.name} runtime_cli`),
    cli_token: optionalString(raw.cli_token, `${raw.name} cli_token`),
    instruction_fragment: raw.instruction_fragment === undefined
      ? undefined
      : packagePath(raw.instruction_fragment, `${raw.name} instruction_fragment`),
    generated_data: generatedData,
  }
}

function assertPackageFiles(root: string, manifest: SkillPackageManifest): void {
  const declared = new Set<string>([
    ...manifest.skill_files,
    ...Object.values(manifest.harness_resources ?? {}).flatMap((resources) => Object.values(resources).flat()),
    ...(manifest.runtime_files ?? []),
    ...Object.values(manifest.runtime_artifacts ?? {}),
    ...(manifest.instruction_fragment ? [manifest.instruction_fragment] : []),
  ])
  for (const rel of declared) {
    if (!existsSync(join(root, rel))) throw new Error(`${manifest.name} package is missing ${rel}`)
  }
}

function assertPackageTarget(name: string, manifest: SkillPackageManifest, selected: TargetKey | 'portable'): void {
  const runtimeTargets = Object.keys(manifest.runtime_artifacts ?? {})
  if (selected === 'portable') {
    if (runtimeTargets.length > 0) throw new Error(`${name} portable package cannot contain target-specific runtime artifacts`)
    return
  }
  if (!manifest.runtime) return
  if (runtimeTargets.length !== 1 || runtimeTargets[0] !== selected) {
    throw new Error(`${name} ${selected} package must contain only its ${selected} runtime artifact`)
  }
}

export async function downloadSkillPackage(
  name: string,
  released: ReleasedSkill,
  fetcher: FetchLike = fetch,
  target?: TargetKey,
): Promise<DownloadedSkillPackage> {
  const currentTarget = targetKey(target)
  const selected = selectSkillArtifact(name, released, currentTarget)
  const scratch = mkdtempSync(join(tmpdir(), `jls-${name}-`))
  const archive = join(scratch, `${name}.zip`)
  const root = join(scratch, 'package')
  mkdirSync(root, { recursive: true })

  try {
    await downloadVerified(selected.artifact, archive, `${name} ${released.version}`, fetcher)
    extractZip(archive, root)

    const manifestPath = join(root, 'manifest.json')
    if (!existsSync(manifestPath)) throw new Error(`${name} package is missing manifest.json`)
    const manifest = parseSkillPackageManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
    if (manifest.name !== name) throw new Error(`${name} package manifest identifies ${manifest.name}`)
    if (manifest.version !== released.version) {
      throw new Error(`${name} package version ${manifest.version} does not match release index ${released.version}`)
    }
    if (manifest.min_installer !== released.min_installer) {
      throw new Error(`${name} package min_installer does not match release index`)
    }
    assertPackageTarget(name, manifest, selected.key)
    assertPackageFiles(root, manifest)

    return {
      manifest,
      root,
      cleanup: () => rmSync(scratch, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true })
    throw error
  }
}
