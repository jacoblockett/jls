import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { containedPath, extractZip } from './archive'
import { expectedSkillNameFromRepository, SKILL_REPOSITORIES } from './skill-catalog'
import {
  compiledTarget,
  installerAssetName,
  isTargetKey,
  TARGET_KEYS,
  targetByKey,
  type TargetKey,
} from './targets'

if (Bun.isStandaloneExecutable) compiledTarget()

type FetchLike = typeof fetch

export const INSTALLER_REPOSITORY = 'jacoblockett/jls'

export type ReleaseArtifact = {
  url: string
  sha256: string
}

export type TargetArtifactMap = Partial<Record<TargetKey, ReleaseArtifact>>
export type SkillArtifactMap = Partial<Record<TargetKey | 'portable', ReleaseArtifact>>

export type DependencyDetect = {
  command?: string[]
  path?: string[]
}

export type SkillDependency = {
  name: string
  install_url: string
  detect: DependencyDetect
}

export type ReleasedSkill = {
  version: string
  description?: string
  dependencies?: SkillDependency[]
  artifacts: SkillArtifactMap
}

export type ReleaseManifest = {
  skills: Record<string, ReleasedSkill>
}

export type InstallerUpdate = {
  version: string
  artifact: ReleaseArtifact
}

export type GeneratedDataSpec = {
  path: string
  marker: string
}

export type HarnessResources = Record<string, Record<string, string[]>>

export type SkillTool = {
  artifacts: Record<string, string>
  token?: string
}

export type SkillPackageManifest = {
  name: string
  version: string
  description: string
  dependencies?: SkillDependency[]
  skill_files: string[]
  harness_resources?: HarnessResources
  tools?: Record<string, SkillTool>
  tool_files?: string[]
  // Legacy singular-runtime fields remain accepted so existing skill releases
  // install unchanged while the generic tool model becomes the package contract.
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

type GitHubReleaseAsset = {
  name: string
  browser_download_url: string
  digest?: string | null
}

type GitHubRelease = {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: GitHubReleaseAsset[]
}

type SkillRepositoryMetadata = {
  name: string
  description: string
  dependencies?: SkillDependency[]
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

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`)
  return value.map((item, index) => nonEmptyString(item, `${label}[${index}]`))
}

function parseDependencies(value: unknown, label: string): SkillDependency[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`)
  return value.map((item, index) => {
    const itemLabel = `${label}[${index}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${itemLabel} must be an object`)
    const raw = item as Record<string, unknown>
    const name = nonEmptyString(raw.name, `${itemLabel}.name`)
    const installUrl = nonEmptyString(raw.install_url, `${itemLabel}.install_url`)
    const parsedUrl = new URL(installUrl)
    if (parsedUrl.protocol !== 'https:') throw new Error(`${itemLabel}.install_url must use HTTPS`)
    if (!raw.detect || typeof raw.detect !== 'object' || Array.isArray(raw.detect)) {
      throw new Error(`${itemLabel}.detect must be an object`)
    }
    const detectRaw = raw.detect as Record<string, unknown>
    const command = stringArray(detectRaw.command, `${itemLabel}.detect.command`)
    const path = stringArray(detectRaw.path, `${itemLabel}.detect.path`)
    if (!command && !path) throw new Error(`${itemLabel}.detect must declare command and/or path`)
    return {
      name,
      install_url: installUrl,
      detect: {
        ...(command ? { command } : {}),
        ...(path ? { path } : {}),
      },
    }
  })
}

function parseSha256Digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} is missing a usable SHA-256 digest`)
  }
  return value.slice('sha256:'.length)
}

export function parseGitHubRelease(value: unknown, label = 'GitHub release'): GitHubRelease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${label}`)
  const raw = value as Record<string, unknown>
  const tagName = nonEmptyString(raw.tag_name, `${label}.tag_name`)
  if (raw.draft !== false || raw.prerelease !== false) throw new Error(`${label} must be a published stable release`)
  if (!Array.isArray(raw.assets)) throw new Error(`${label}.assets must be an array`)

  const assets = raw.assets.map((value, index) => {
    const assetLabel = `${label}.assets[${index}]`
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${assetLabel}`)
    const asset = value as Record<string, unknown>
    return {
      name: nonEmptyString(asset.name, `${assetLabel}.name`),
      browser_download_url: nonEmptyString(asset.browser_download_url, `${assetLabel}.browser_download_url`),
      digest: asset.digest === null || asset.digest === undefined
        ? asset.digest as null | undefined
        : nonEmptyString(asset.digest, `${assetLabel}.digest`),
    }
  })

  return { tag_name: tagName, draft: false, prerelease: false, assets }
}

function stableVersionFromTag(tag: string, label: string): string {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag)
  if (!match) throw new Error(`${label} tag must be vMAJOR.MINOR.PATCH: ${tag}`)
  return match[1]
}

function artifactFromReleaseAsset(asset: GitHubReleaseAsset, label: string): ReleaseArtifact {
  return {
    url: asset.browser_download_url,
    sha256: parseSha256Digest(asset.digest, label),
  }
}

export function parseSkillRepositoryManifest(repository: string, value: unknown): SkillRepositoryMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${repository} manifest.json is invalid`)
  }
  const raw = value as Record<string, unknown>
  const name = nonEmptyString(raw.name, `${repository} manifest name`)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`${repository} manifest has invalid skill name ${name}`)

  const expectedName = expectedSkillNameFromRepository(repository)
  if (expectedName && name !== expectedName) {
    throw new Error(`${repository} manifest identifies ${name}; expected ${expectedName}`)
  }

  return {
    name,
    description: nonEmptyString(raw.description, `${repository} manifest description`),
    dependencies: parseDependencies(raw.dependencies, `${repository} manifest dependencies`),
  }
}

function skillArtifacts(name: string, assets: GitHubReleaseAsset[], repository: string): SkillArtifactMap {
  const byName = new Map(assets.map((asset) => [asset.name, asset]))
  const artifacts: SkillArtifactMap = {}

  for (const target of TARGET_KEYS) {
    const asset = byName.get(`${name}-${target}.zip`)
    if (asset) artifacts[target] = artifactFromReleaseAsset(asset, `${repository} ${asset.name}`)
  }

  const portable = byName.get(`${name}.zip`)
  if (portable) artifacts.portable = artifactFromReleaseAsset(portable, `${repository} ${portable.name}`)

  if (Object.keys(artifacts).length === 0) {
    throw new Error(`${repository} latest release has no JLS package assets for ${name}`)
  }
  return artifacts
}

function githubReleaseUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}/releases/latest`
}

function repositoryManifestUrl(repository: string, tag: string): string {
  return `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(tag)}/manifest.json`
}

async function fetchLatestGitHubRelease(
  repository: string,
  fetcher: FetchLike,
): Promise<GitHubRelease | null> {
  const response = await fetcher(githubReleaseUrl(repository), {
    headers: { 'user-agent': 'jls', accept: 'application/vnd.github+json' },
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${repository} release check failed with HTTP ${response.status}`)
  return parseGitHubRelease(await response.json(), `${repository} latest release`)
}

async function resolveSkillRepository(
  repository: string,
  fetcher: FetchLike,
): Promise<[string, ReleasedSkill] | null> {
  const release = await fetchLatestGitHubRelease(repository, fetcher)
  if (!release) return null

  const version = stableVersionFromTag(release.tag_name, `${repository} latest release`)
  const manifestResponse = await fetcher(repositoryManifestUrl(repository, release.tag_name), {
    headers: { 'user-agent': 'jls' },
  })
  if (!manifestResponse.ok) {
    throw new Error(`${repository} manifest lookup for ${release.tag_name} failed with HTTP ${manifestResponse.status}`)
  }

  const metadata = parseSkillRepositoryManifest(repository, await manifestResponse.json())
  return [metadata.name, {
    version,
    description: metadata.description,
    ...(metadata.dependencies ? { dependencies: metadata.dependencies } : {}),
    artifacts: skillArtifacts(metadata.name, release.assets, repository),
  }]
}

export async function fetchAvailableSkills(
  repositories: readonly string[] = SKILL_REPOSITORIES,
  fetcher: FetchLike = fetch,
): Promise<ReleaseManifest> {
  const resolved = await Promise.all(repositories.map((repository) => resolveSkillRepository(repository, fetcher)))
  const skills: Record<string, ReleasedSkill> = {}

  for (const entry of resolved) {
    if (!entry) continue
    const [name, released] = entry
    if (skills[name]) throw new Error(`catalog repositories resolve to duplicate skill name ${name}`)
    skills[name] = released
  }

  return { skills }
}

function targetKey(target?: TargetKey): TargetKey {
  return target ?? compiledTarget().key
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
  repository = INSTALLER_REPOSITORY,
  fetcher: FetchLike = fetch,
  target?: TargetKey,
): Promise<InstallerUpdate | null> {
  const release = await fetchLatestGitHubRelease(repository, fetcher)
  if (!release) return null

  const version = stableVersionFromTag(release.tag_name, `${repository} latest release`)
  if (compareVersions(version, currentVersion) <= 0) return null

  const currentTarget = targetKey(target)
  const assetName = installerAssetName(targetByKey(currentTarget))
  const asset = release.assets.find((candidate) => candidate.name === assetName)
  if (!asset) throw new Error(`${repository} latest release has no ${assetName} installer asset`)

  return {
    version,
    artifact: artifactFromReleaseAsset(asset, `${repository} ${assetName}`),
  }
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

export async function stageInstallerUpdate(
  executable: string,
  update: InstallerUpdate,
  fetcher: FetchLike = fetch,
): Promise<string> {
  const staged = join(dirname(executable), `.${basename(executable)}.update-${process.pid}-${Date.now()}`)
  try {
    const path = await downloadVerified(update.artifact, staged, 'installer update', fetcher)
    try { chmodSync(path, 0o755) } catch {}
    return path
  } catch (error) {
    try { rmSync(staged, { force: true }) } catch {}
    throw error
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return nonEmptyString(value, label)
}

function pathArray(value: unknown, label: string, required = false): string[] | undefined {
  if (value === undefined && !required) return undefined
  if (!Array.isArray(value) || (required && value.length === 0)) throw new Error(`${label} must be a non-empty array`)
  return value.map((item, index) => containedPath(item, `${label}[${index}]`))
}

function pathRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = containedPath(item, `${label}.${key}`)
  }
  return result
}

function parseTools(value: unknown, label: string): Record<string, SkillTool> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) throw new Error(`${label} must contain at least one tool`)

  const result: Record<string, SkillTool> = {}
  const tokens = new Set<string>()
  for (const [name, rawTool] of entries) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`${label} has invalid tool name ${name}`)
    if (!rawTool || typeof rawTool !== 'object' || Array.isArray(rawTool)) {
      throw new Error(`${label}.${name} must be an object`)
    }
    const raw = rawTool as Record<string, unknown>
    const artifacts = pathRecord(raw.artifacts, `${label}.${name}.artifacts`)
    if (!artifacts || Object.keys(artifacts).length === 0) {
      throw new Error(`${label}.${name}.artifacts must contain at least one artifact`)
    }
    for (const target of Object.keys(artifacts)) {
      if (target !== 'portable' && !isTargetKey(target)) {
        throw new Error(`${label}.${name}.artifacts has invalid target ${target}`)
      }
    }

    const token = optionalString(raw.token, `${label}.${name}.token`)
    if (token && !/^[A-Z][A-Z0-9_]*$/.test(token)) {
      throw new Error(`${label}.${name}.token must be an uppercase token name`)
    }
    if (token && tokens.has(token)) throw new Error(`${label} reuses token ${token}`)
    if (token) tokens.add(token)
    result[name] = { artifacts, ...(token ? { token } : {}) }
  }
  return result
}

export function packageTools(manifest: SkillPackageManifest): Record<string, SkillTool> {
  if (manifest.tools) return manifest.tools
  if (!manifest.runtime) return {}
  if (!manifest.runtime_cli || !manifest.runtime_artifacts) {
    throw new Error(`${manifest.name} legacy runtime is missing runtime_cli or runtime_artifacts`)
  }
  return {
    [manifest.runtime_cli]: {
      artifacts: manifest.runtime_artifacts,
      token: manifest.cli_token || 'JL_SKILL_CLI',
    },
  }
}

export function packageToolFiles(manifest: SkillPackageManifest): string[] {
  return manifest.tool_files ?? manifest.runtime_files ?? []
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
  if (typeof raw.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(raw.name)) throw new Error('invalid skill package name')
  if (typeof raw.version !== 'string' || !semverParts(raw.version)) throw new Error(`invalid ${raw.name} package version`)
  if (typeof raw.description !== 'string' || !raw.description.trim()) throw new Error(`${raw.name} package is missing description`)

  const generatedData: GeneratedDataSpec[] | undefined = raw.generated_data === undefined
    ? undefined
    : (() => {
      if (!Array.isArray(raw.generated_data)) throw new Error(`${raw.name} generated_data must be an array`)
      return raw.generated_data.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error(`${raw.name} generated_data[${index}] is invalid`)
        }
        const entry = value as Record<string, unknown>
        return {
          path: containedPath(entry.path, `${raw.name} generated_data[${index}].path`),
          marker: containedPath(entry.marker, `${raw.name} generated_data[${index}].marker`),
        }
      })
    })()

  const tools = parseTools(raw.tools, `${raw.name} tools`)
  const toolFiles = pathArray(raw.tool_files, `${raw.name} tool_files`)
  const hasLegacyRuntime = raw.runtime !== undefined
    || raw.runtime_artifacts !== undefined
    || raw.runtime_cli !== undefined
    || raw.cli_token !== undefined
    || raw.runtime_files !== undefined
  if ((tools || toolFiles) && hasLegacyRuntime) {
    throw new Error(`${raw.name} cannot mix tools/tool_files with legacy runtime fields`)
  }

  const runtime = optionalString(raw.runtime, `${raw.name} runtime`)
  const runtimeArtifacts = pathRecord(raw.runtime_artifacts, `${raw.name} runtime_artifacts`)
  const runtimeCli = optionalString(raw.runtime_cli, `${raw.name} runtime_cli`)
  const cliToken = optionalString(raw.cli_token, `${raw.name} cli_token`)
  const runtimeFiles = pathArray(raw.runtime_files, `${raw.name} runtime_files`)
  if (hasLegacyRuntime && (!runtime || !runtimeArtifacts || !runtimeCli)) {
    throw new Error(`${raw.name} legacy runtime requires runtime, runtime_artifacts, and runtime_cli`)
  }

  return {
    name: raw.name,
    version: raw.version,
    description: raw.description,
    dependencies: parseDependencies(raw.dependencies, `${raw.name} dependencies`),
    skill_files: pathArray(raw.skill_files, `${raw.name} skill_files`, true)!,
    harness_resources: harnessResources(raw.harness_resources, `${raw.name} harness_resources`),
    tools,
    tool_files: toolFiles,
    runtime_files: runtimeFiles,
    runtime,
    runtime_artifacts: runtimeArtifacts,
    runtime_cli: runtimeCli,
    cli_token: cliToken,
    instruction_fragment: raw.instruction_fragment === undefined
      ? undefined
      : containedPath(raw.instruction_fragment, `${raw.name} instruction_fragment`),
    generated_data: generatedData,
  }
}

function assertPackageFiles(root: string, manifest: SkillPackageManifest): void {
  const declared = new Set<string>([
    ...manifest.skill_files,
    ...Object.values(manifest.harness_resources ?? {}).flatMap((resources) => Object.values(resources).flat()),
    ...packageToolFiles(manifest),
    ...Object.values(packageTools(manifest)).flatMap((tool) => Object.values(tool.artifacts)),
    ...(manifest.instruction_fragment ? [manifest.instruction_fragment] : []),
  ])
  // Install manifests define the exact leaf files JLS may manage. Allowing a
  // declaration to name a directory would make later file-granular cleanup
  // ambiguous and could turn a shared container into an ownership boundary.
  for (const rel of declared) {
    const path = join(root, rel)
    if (!existsSync(path)) throw new Error(`${manifest.name} package is missing ${rel}`)
    if (!statSync(path).isFile()) {
      throw new Error(`${manifest.name} package declaration must reference a file: ${rel}`)
    }
  }
}

function assertPackageTarget(name: string, manifest: SkillPackageManifest, selected: TargetKey | 'portable'): void {
  const supportFiles = packageToolFiles(manifest)
  const supportSet = new Set(supportFiles)
  if (supportSet.size !== supportFiles.length) {
    throw new Error(`${name} package repeats a managed support-file path`)
  }

  const destinations = new Set<string>(supportFiles)
  for (const [toolName, tool] of Object.entries(packageTools(manifest))) {
    const targets = Object.keys(tool.artifacts)
    const target = targets[0]
    const allowed = selected === 'portable' ? target === 'portable' : target === selected || target === 'portable'
    if (targets.length !== 1 || !allowed) {
      throw new Error(`${name} ${selected} package tool ${toolName} must contain exactly one compatible artifact`)
    }
    const destination = `bin/${basename(tool.artifacts[target]!)}`
    if (destinations.has(destination)) {
      throw new Error(`${name} package tools/support files collide on installed path ${destination}`)
    }
    destinations.add(destination)
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
    if (released.description !== undefined && manifest.description !== released.description) {
      throw new Error(`${name} package description does not match release index`)
    }
    if (released.dependencies !== undefined
      && JSON.stringify(manifest.dependencies ?? []) !== JSON.stringify(released.dependencies)) {
      throw new Error(`${name} package dependencies do not match release index`)
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
