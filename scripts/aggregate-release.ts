import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  TARGET_KEYS,
  installerAssetName,
  targetByKey,
  type TargetKey,
} from '../src/targets'

const repo = resolve(import.meta.dir, '..')
const semver = /^\d+\.\d+\.\d+$/
const sha256Pattern = /^[a-f0-9]{64}$/

type Artifact = { url: string; sha256: string }
type SkillReference = { manifest_url: string }
type Fragment = {
  format: number
  installer: { version: string; artifacts: Record<string, Artifact> }
  skills: Record<string, SkillReference>
}

type Catalog = { format: 1; skills: Record<string, SkillReference> }

export type AggregateOptions = {
  inputRoot: string
  outputRoot: string
  releaseTag: string
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(', ')}`)
  }
}

export function catalogSkillReferences(skills: Record<string, unknown>): Record<string, SkillReference> {
  const references: Record<string, SkillReference> = {}
  for (const [name, value] of Object.entries(skills)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`invalid catalog skill name ${name}`)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid catalog skill ${name}`)
    const manifestUrl = (value as Record<string, unknown>).manifest_url
    if (typeof manifestUrl !== 'string' || !manifestUrl.trim()) throw new Error(`${name} catalog entry requires manifest_url`)
    const parsed = new URL(manifestUrl)
    if (parsed.protocol !== 'https:') throw new Error(`${name} manifest_url must use HTTPS`)
    references[name] = { manifest_url: manifestUrl }
  }
  return references
}

function readCatalog(): Catalog {
  const raw = JSON.parse(readFileSync(join(repo, 'catalog.json'), 'utf8')) as Record<string, unknown>
  if (raw.format !== 1 || !raw.skills || typeof raw.skills !== 'object' || Array.isArray(raw.skills)) {
    throw new Error('invalid catalog.json')
  }
  return { format: 1, skills: catalogSkillReferences(raw.skills as Record<string, unknown>) }
}

function assertArtifact(
  artifact: Artifact | undefined,
  file: string,
  expectedUrl: string,
  label: string,
): Artifact {
  if (!artifact) throw new Error(`${label} is missing from its target manifest`)
  if (artifact.url !== expectedUrl) throw new Error(`${label} URL must be ${expectedUrl}`)
  if (!sha256Pattern.test(artifact.sha256)) throw new Error(`${label} has an invalid SHA-256`)
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`${label} file is missing: ${file}`)
  const actual = sha256(file)
  if (actual !== artifact.sha256) throw new Error(`${label} SHA-256 does not match ${basename(file)}`)
  return artifact
}

function readFragment(path: string, target: TargetKey, catalog: Catalog): Fragment {
  if (!existsSync(path)) throw new Error(`missing ${target} manifest fragment: ${path}`)
  const fragment = JSON.parse(readFileSync(path, 'utf8')) as Fragment
  if (fragment.format !== 3) throw new Error(`${target} manifest fragment must use format 3`)
  if (!fragment.installer || typeof fragment.installer !== 'object') throw new Error(`${target} fragment is missing installer metadata`)
  if (typeof fragment.installer.version !== 'string' || !semver.test(fragment.installer.version)) {
    throw new Error(`${target} fragment has invalid installer version`)
  }
  if (!fragment.installer.artifacts || typeof fragment.installer.artifacts !== 'object') {
    throw new Error(`${target} fragment is missing installer artifacts`)
  }
  exactKeys(fragment.installer.artifacts, [target], `${target} installer artifact map`)
  if (JSON.stringify(fragment.skills) !== JSON.stringify(catalog.skills)) {
    throw new Error(`${target} skill references do not match catalog.json`)
  }
  return fragment
}

export function aggregateRelease({ inputRoot, outputRoot, releaseTag }: AggregateOptions): string {
  if (!/^[A-Za-z0-9._-]+$/.test(releaseTag)) throw new Error(`invalid release tag: ${releaseTag}`)
  const releaseBase = `https://github.com/jacoblockett/jls/releases/download/${releaseTag}`
  const catalog = readCatalog()
  const fragments = new Map<TargetKey, { root: string; manifest: Fragment }>()

  let installerVersion: string | undefined
  for (const key of TARGET_KEYS) {
    const targetRoot = join(inputRoot, `target-${key}`)
    if (!existsSync(targetRoot) || !statSync(targetRoot).isDirectory()) {
      throw new Error(`required target artifact directory is missing: target-${key}`)
    }
    const manifest = readFragment(join(targetRoot, 'manifest.json'), key, catalog)
    if (installerVersion === undefined) installerVersion = manifest.installer.version
    else if (manifest.installer.version !== installerVersion) {
      throw new Error(`${key} installer version ${manifest.installer.version} does not match ${installerVersion}`)
    }
    fragments.set(key, { root: targetRoot, manifest })
  }

  if (!installerVersion) throw new Error('no installer version was aggregated')
  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(outputRoot, { recursive: true })

  const installerArtifacts: Record<string, Artifact> = {}
  for (const key of TARGET_KEYS) {
    const target = targetByKey(key)
    const fragment = fragments.get(key)!
    const name = installerAssetName(target)
    const source = join(fragment.root, name)
    const expectedUrl = `${releaseBase}/${name}`
    const artifact = assertArtifact(fragment.manifest.installer.artifacts[key], source, expectedUrl, `${key} installer`)
    copyFileSync(source, join(outputRoot, name))
    installerArtifacts[key] = artifact
  }

  exactKeys(installerArtifacts, [...TARGET_KEYS], 'aggregated installer target set')

  const output = join(outputRoot, 'manifest.json')
  writeFileSync(output, `${JSON.stringify({
    format: 3,
    installer: {
      version: installerVersion,
      artifacts: installerArtifacts,
    },
    skills: catalog.skills,
  }, null, 2)}\n`)

  console.log(`Aggregated ${TARGET_KEYS.length} required installer targets into ${outputRoot}`)
  return output
}

if (import.meta.main) {
  const inputRoot = resolve(process.env.JLS_AGGREGATE_INPUT?.trim() || join(repo, 'build', 'targets'))
  const outputRoot = resolve(process.env.JLS_AGGREGATE_OUTPUT?.trim() || join(repo, 'build', 'release'))
  const releaseTag = process.env.JLS_RELEASE_TAG?.trim()
  if (!releaseTag) throw new Error('JLS_RELEASE_TAG is required for release aggregation')
  aggregateRelease({ inputRoot, outputRoot, releaseTag })
}
